/**
 * Persistent memory of links that have already left ticker_items — populated
 * by a DB trigger on ticker_items (see supabase/schema.sql), which fires on
 * ANY delete (AutoTweet's batch-clear, Ticker's own retention pruning, or a
 * manual delete in the Supabase dashboard), not just the paths this file's
 * callers happen to go through. Without this, a source that keeps listing
 * the same article across later polls (completely normal RSS/scrape
 * behavior) would have it silently re-inserted as if brand new — Ticker's
 * upsert only dedups against ROWS CURRENTLY IN THE TABLE, not history.
 */
import { db } from "./db";

// `.in("link", chunk)` rides in the request URL, and URL + headers together
// are capped around 16KB server-side (past that: HeadersOverflowError, or a
// flat 400 once it's long enough). A fixed 200-row chunk was proven to always
// blow past that with real article URLs (avg ~150 chars) — chunk by encoded
// byte budget instead so it can't regress just because URLs get longer.
const CHUNK_BYTES = 6_000;

function chunkByBytes(links: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const link of links) {
    const len = encodeURIComponent(link).length + 1; // +1 for the "," separator
    if (current.length > 0 && size + len > CHUNK_BYTES) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(link);
    size += len;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Drop any item whose link has already been analyzed before, however long ago. */
export async function filterUnseen<T extends { link: string }>(items: T[]): Promise<T[]> {
  if (items.length === 0) return items;
  const links = [...new Set(items.map((i) => i.link))];
  const seen = new Set<string>();
  for (const chunk of chunkByBytes(links)) {
    const { data, error } = await db.from("seen_links").select("link").in("link", chunk);
    if (error) {
      console.error(`[${new Date().toISOString()}] filterUnseen lookup failed:`, error.message);
      continue; // fail open — better to risk a re-analysis than lose articles because of a lookup blip
    }
    (data ?? []).forEach((r) => seen.add(r.link));
  }
  return items.filter((i) => !seen.has(i.link));
}

/** Rolling retention — RSS/scrape sources don't re-list month-old articles, so a short window is plenty. */
export async function pruneSeenLinks(retainDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - retainDays * 86_400_000).toISOString();
  const { error, count } = await db.from("seen_links").delete({ count: "exact" }).lt("seen_at", cutoff);
  if (error) throw new Error(`pruneSeenLinks failed: ${error.message}`);
  return count ?? 0;
}
