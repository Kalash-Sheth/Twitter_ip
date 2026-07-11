/**
 * Persist raw ticker items with simple dedup: LINK ALONE is unique — never store
 * the same article twice, regardless of which source found it. This matters
 * because ET is fetched two ways (RSS feeds + the HTML scraper shared with
 * Newswire) and the two genuinely overlap (~33% of RSS links also turn up via
 * scraping) — deduping on (publisher, link) would let the same article through
 * twice under two different publisher labels. No cross-source STORY-collapsing
 * beyond exact-URL matches (that's what Newswire/Pulse do); the Ticker is a raw,
 * uncurated feed display.
 */
import { db } from "./db";
import type { TickerItem } from "./tickerRss";

const CHUNK_SIZE = 50;

export async function storeTickerItems(items: TickerItem[]): Promise<number> {
  if (items.length === 0) return 0;
  // Collapse same-link duplicates within this batch (e.g. the same article
  // showing up via both an RSS feed and the scraper), keeping the first occurrence.
  const seen = new Set<string>();
  const rows = [];
  for (const i of items) {
    if (seen.has(i.link)) continue;
    seen.add(i.link);
    rows.push({
      publisher: i.publisher,
      category: i.category,
      title: i.title,
      link: i.link,
      published_at: i.published_at,
    });
  }

  // Chunked — the first tick after a cold start can carry ~700 rows (16 feeds x
  // ~50 items, nothing stored yet); one huge upsert is more failure-prone than a
  // few small ones. Each chunk gets its own retry, wrapped in try/catch: a raw
  // thrown TypeError ("fetch failed" — the same macOS/undici cold-start blip
  // seen elsewhere in this codebase) skips a bare retry loop entirely, so it
  // must be caught here to actually retry instead of aborting on attempt 1.
  let stored = 0;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { data, error } = await db
          .from("ticker_items")
          .upsert(chunk, { onConflict: "link", ignoreDuplicates: true })
          .select("link");
        if (error) throw new Error(error.message);
        stored += data?.length ?? 0;
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
    if (lastErr) throw new Error(`storeTickerItems failed: ${lastErr instanceof Error ? lastErr.message : lastErr}`);
  }
  return stored;
}
