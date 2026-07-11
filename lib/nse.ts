/**
 * NSE corporate-announcements client.
 *
 * NSE is heavily bot-protected: the JSON API only responds once you've picked up
 * session cookies from the homepage, and it throttles/tarpits rapid repeat hits.
 * So we (a) handshake for cookies and cache them, (b) poll NSE on a SLOWER cadence
 * than BSE (it doesn't disseminate faster than that anyway), and (c) refresh the
 * session whenever a request fails.
 *
 *   https://www.nseindia.com/api/corporate-announcements?index=equities
 */
import { setDefaultResultOrder } from "node:dns";
import type { Announcement } from "./types";

setDefaultResultOrder("ipv4first");

const HOME = "https://www.nseindia.com/";
const API = "https://www.nseindia.com/api/corporate-announcements?index=equities";
const REFERER = "https://www.nseindia.com/companies-listing/corporate-filings-announcements";
const TIMEOUT_MS = Number(process.env.NSE_TIMEOUT_MS ?? 20_000);
// Don't hammer NSE — fetch at most this often regardless of the worker tick rate.
const MIN_INTERVAL_MS = Number(process.env.NSE_POLL_MS ?? 60_000);

// NOTE: deliberately NOT setting Accept-Encoding (breaks undici auto-decompress)
// or Connection: keep-alive (reused sockets to NSE get reset → "fetch failed").
const BASE_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
};

let cookieCache = "";
let cookieAt = 0;
let lastFetchAt = 0;
const COOKIE_TTL_MS = 5 * 60 * 1000;

async function getCookies(force: boolean): Promise<string> {
  if (!force && cookieCache && Date.now() - cookieAt < COOKIE_TTL_MS) return cookieCache;
  const res = await fetch(HOME, {
    headers: {
      ...BASE_HEADERS,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-User": "?1",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const set = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  cookieCache = set.map((c) => c.split(";")[0]).join("; ");
  cookieAt = Date.now();
  return cookieCache;
}

interface NseRow {
  seq_id?: string;
  symbol?: string;
  sm_name?: string;
  sm_isin?: string;
  desc?: string;
  attchmntText?: string;
  attchmntFile?: string;
  an_dt?: string;
  exchdisstime?: string;
  [k: string]: unknown;
}

/** "28-Jun-2026 16:52:13" -> "2026-06-28T16:52:13" (matches BSE's format). */
function parseNseDate(s: string | undefined): string | null {
  if (!s) return null;
  const m = s.match(/(\d{2})-(\w{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const months: Record<string, string> = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
  };
  const mm = months[m[2]!];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[1]}T${m[4]}:${m[5]}:${m[6]}`;
}

function normalize(row: NseRow): Announcement {
  const dt = parseNseDate(row.an_dt) ?? parseNseDate(row.exchdisstime);
  const subject = (row.desc ?? "").trim() || (row.attchmntText ?? "").trim();
  return {
    source: "NSE",
    source_news_id: String(row.seq_id ?? `${row.symbol}-${row.an_dt}`),
    scrip_cd: String(row.symbol ?? ""),
    company: row.sm_name?.trim() || null,
    nsurl: row.symbol ? `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(row.symbol)}` : null,
    headline: row.attchmntText?.trim() || null,
    subject,
    category: row.desc?.trim() || null,
    subcategory: null,
    critical: false,
    announcement_dt: dt,
    dissem_dt: dt,
    attachment_name: null, // NSE PDFs are full URLs — see pdf_url
    pdf_url: row.attchmntFile?.trim() || null,
    raw: row,
  };
}

async function fetchOnce(force: boolean): Promise<Announcement[]> {
  const cookies = await getCookies(force);
  const res = await fetch(API, {
    headers: { ...BASE_HEADERS, Accept: "application/json", Referer: REFERER, Cookie: cookies },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) throw new Error(`NSE auth ${res.status}`);
  if (!res.ok) throw new Error(`NSE ${res.status}`);
  const json = (await res.json()) as NseRow[] | { data?: NseRow[] };
  const rows = Array.isArray(json) ? json : (json.data ?? []);
  return rows.map(normalize);
}

/**
 * Fetch the latest NSE announcements — throttled to MIN_INTERVAL_MS so we never
 * hammer NSE. Returns [] when called too soon (the next eligible tick fetches).
 * Retries once with a fresh session on failure; invalidates cookies on error.
 */
export async function fetchNseAnnouncements(): Promise<Announcement[]> {
  if (Date.now() - lastFetchAt < MIN_INTERVAL_MS) return [];
  lastFetchAt = Date.now();
  try {
    return await fetchOnce(false);
  } catch {
    cookieAt = 0; // force a fresh handshake and try once more
    try {
      return await fetchOnce(true);
    } catch (e) {
      cookieAt = 0;
      throw e instanceof Error ? e : new Error(String(e));
    }
  }
}
