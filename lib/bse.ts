/**
 * BSE corporate-announcements client.
 *
 * Proven endpoint (returns JSON { Table: [...], Table1: [{ ROWCNT }] }):
 *   https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w
 * The api.* host serves JSON without the cookie handshake the www.* site needs,
 * but it DOES require browser-like Origin/Referer/UA headers.
 */

import { setDefaultResultOrder } from "node:dns";

// Some hosts/CI have a dead IPv6 route; BSE resolves to both. Prefer IPv4 so
// Node's fetch (undici) doesn't hang on an unreachable AAAA address.
setDefaultResultOrder("ipv4first");

const API = "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w";
const PDF_BASE = "https://www.bseindia.com/xml-data/corpfiling/AttachLive";
const PAGE_SIZE = 50; // BSE returns 50 rows/page

const HEADERS: Record<string, string> = {
  Accept: "application/json",
  Origin: "https://www.bseindia.com",
  Referer: "https://www.bseindia.com/",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
};

/** Raw record shape as BSE returns it (subset of fields we rely on). */
interface BseRow {
  NEWSID: string;
  SCRIP_CD: number;
  NEWSSUB: string;
  HEADLINE: string | null;
  CATEGORYNAME: string | null;
  SUBCATNAME: string | null;
  CRITICALNEWS: number;
  DT_TM: string;
  DissemDT: string | null;
  ATTACHMENTNAME: string | null;
  NSURL: string | null;
  SLONGNAME: string | null;
  [k: string]: unknown;
}

export type { Announcement } from "./types";
import type { Announcement } from "./types";

const yyyymmdd = (d: Date): string =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(
    d.getDate(),
  ).padStart(2, "0")}`;

function normalize(row: BseRow): Announcement {
  const attachment = row.ATTACHMENTNAME?.trim() || null;
  return {
    source: "BSE",
    source_news_id: row.NEWSID,
    scrip_cd: String(row.SCRIP_CD),
    company: row.SLONGNAME?.trim() || null,
    nsurl: row.NSURL?.trim() || null,
    headline: row.HEADLINE?.trim() || null,
    subject: row.NEWSSUB?.trim() ?? "",
    category: row.CATEGORYNAME?.trim() || null,
    subcategory: row.SUBCATNAME?.trim() || null,
    critical: row.CRITICALNEWS === 1,
    announcement_dt: row.DT_TM || null,
    dissem_dt: row.DissemDT || null,
    attachment_name: attachment,
    pdf_url: attachment ? `${PDF_BASE}/${attachment}` : null,
    raw: row,
  };
}

interface BseResponse {
  Table?: BseRow[];
  Table1?: { ROWCNT: number }[];
}

async function fetchPage(
  from: string,
  to: string,
  pageno: number,
): Promise<BseResponse> {
  const url =
    `${API}?pageno=${pageno}&strCat=-1&strPrevDate=${from}` +
    `&strScrip=&strSearch=P&strToDate=${to}&strType=C&subcategory=-1`;

  // BSE's edge occasionally drops a connection; retry a couple of times before
  // giving up (the orchestrator would otherwise skip the whole tick).
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`BSE ${res.status} ${res.statusText}`);
      const text = await res.text();
      if (text.trim().startsWith('"No Record')) return { Table: [] };
      return JSON.parse(text) as BseResponse;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw lastErr;
}

/**
 * Fetch all announcements between two dates (inclusive), newest first.
 * For the live watcher, call with today's date for both bounds.
 */
export async function fetchAnnouncements(
  from: Date = new Date(),
  to: Date = new Date(),
): Promise<Announcement[]> {
  const f = yyyymmdd(from);
  const t = yyyymmdd(to);

  const first = await fetchPage(f, t, 1);
  const rows = [...(first.Table ?? [])];
  const total = first.Table1?.[0]?.ROWCNT ?? rows.length;
  const pages = Math.ceil(total / PAGE_SIZE);

  for (let p = 2; p <= pages; p++) {
    const page = await fetchPage(f, t, p);
    rows.push(...(page.Table ?? []));
  }
  return rows.map(normalize);
}
