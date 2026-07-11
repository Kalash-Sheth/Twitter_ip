/**
 * Minimal RSS reader for the Ticker engine. Handles the two date formats and the
 * CDATA-wrapping we found across our verified sources:
 *   - RFC822 with numeric offset:  "Thu, 09 Jul 2026 22:32:53 +0530"  (ET, India Today)
 *   - ISO 8601 with numeric offset: "2026-07-09T21:32:00+05:30"       (TOI)
 *   - Either one, CDATA-wrapped:    "<pubDate><![CDATA[...]]></pubDate>" (Mint, BusinessLine)
 * All of these carry an explicit numeric UTC offset, so parsing is unambiguous —
 * no "IST" named-zone guessing involved.
 */
import { setDefaultResultOrder } from "node:dns";
import type { TickerFeed } from "./tickerFeeds";

setDefaultResultOrder("ipv4first");

const TIMEOUT_MS = Number(process.env.TICKER_TIMEOUT_MS ?? 10_000);
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
};

export interface TickerItem {
  publisher: string;
  category: TickerFeed["category"];
  title: string;
  link: string;
  published_at: string | null; // ISO
}

function clean(s: string): string {
  return s
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

/** Parse either RFC822 ("Thu, 09 Jul 2026 22:32:53 +0530") or ISO8601 with an offset. */
function parseDate(raw: string): string | null {
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function extractTag(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? clean(m[1]!) : null;
}

function parseRss(xml: string, feed: TickerFeed): TickerItem[] {
  const items: TickerItem[] = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for (const raw of blocks) {
    const block = "<item>" + raw.split(/<\/item>/i)[0];
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const pubRaw = extractTag(block, "pubDate");
    if (!title || !link) continue;
    items.push({
      publisher: feed.publisher,
      category: feed.category,
      title,
      link,
      published_at: pubRaw ? parseDate(pubRaw) : null,
    });
  }
  return items;
}

/**
 * Fetch + parse one feed. One quick retry — polling 16 hosts concurrently every
 * few seconds occasionally trips a transient "fetch failed" (socket reuse under
 * load, same undici behavior seen elsewhere in this codebase), not a real block.
 * Throws only after both attempts fail (caller handles via allSettled).
 */
export async function fetchTickerFeed(feed: TickerFeed): Promise<TickerItem[]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(feed.url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`${res.status}`);
      const xml = await res.text();
      return parseRss(xml, feed);
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw lastErr;
}
