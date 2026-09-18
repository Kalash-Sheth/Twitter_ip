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
import { filterUnseen } from "./seenLinks";

const CHUNK_SIZE = 50;

// Links this process has already dealt with. Sources keep re-listing the same
// article for hours, so without this the SAME few hundred links get looked up
// and upserted on every single tick. Once a link has been handled the DB can't
// tell us anything new about it: it's either still in ticker_items (where the
// upsert is a no-op) or AutoTweet analyzed and deleted it, which the seen_links
// trigger recorded (so filterUnseen would drop it). Both answers are "skip".
const handled = new Set<string>();
const HANDLED_MAX = 20_000;
const HANDLED_TRIM = 10_000;

function remember(links: string[]): void {
  for (const l of links) handled.add(l);
  if (handled.size > HANDLED_MAX) {
    const keep = [...handled].slice(-HANDLED_TRIM);
    handled.clear();
    for (const l of keep) handled.add(l);
  }
}

export async function storeTickerItems(items: TickerItem[]): Promise<number> {
  if (items.length === 0) return 0;
  // Collapse same-link duplicates within this batch (e.g. the same article
  // showing up via both an RSS feed and the scraper), keeping the first occurrence,
  // and drop anything this process already handled on an earlier tick.
  const seen = new Set<string>();
  const deduped = [];
  for (const i of items) {
    if (seen.has(i.link) || handled.has(i.link)) continue;
    seen.add(i.link);
    deduped.push(i);
  }
  if (deduped.length === 0) return 0; // nothing here we haven't already settled

  // Drop anything AutoTweet has already analyzed — ticker_items rows get
  // deleted right after analysis, so an upsert alone can't tell "never seen"
  // apart from "already handled, and the source is still listing it."
  const fresh = await filterUnseen(deduped);
  // Whatever filterUnseen dropped was already analyzed — never ask again. On a
  // lookup error it fails open and drops nothing, so this can't cache a wrong answer.
  const freshLinks = new Set(fresh.map((f) => f.link));
  remember(deduped.filter((d) => !freshLinks.has(d.link)).map((d) => d.link));
  const rows = fresh.map((i) => ({
    publisher: i.publisher,
    category: i.category,
    title: i.title,
    link: i.link,
    published_at: i.published_at,
  }));

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
        remember(chunk.map((c) => c.link));
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
