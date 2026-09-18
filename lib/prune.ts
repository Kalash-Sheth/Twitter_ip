/**
 * Retention — keep only the most recent N rows; delete the rest so the database
 * stays small (this is a live news feed, not an archive).
 *
 * Rows are ordered newest-first by (timestamp, id) so ties break deterministically
 * — ties are the common case, not an edge case, since every row in one batch
 * insert shares the same default now(). Only the single BOUNDARY row (the newest
 * one that must go) is read; everything at or past it in that ordering is then
 * deleted server-side by predicate, so nothing but a count comes back over the
 * wire. Reading the whole id list just to slice it client-side was the same
 * delete, paid for in egress.
 */
import { db } from "./db";

const DEFAULT_RETAIN = Number(process.env.RETAIN ?? 100);

async function pruneTable(table: string, tsColumn: string, retain: number): Promise<number> {
  const { data, error: selErr } = await db
    .from(table)
    .select(`id, ${tsColumn}`)
    .order(tsColumn, { ascending: false })
    .order("id", { ascending: false })
    .range(retain, retain);
  if (selErr) throw new Error(`prune ${table} (boundary) failed: ${selErr.message}`);

  const boundary = data?.[0] as Record<string, string> | undefined;
  if (!boundary) return 0; // at or under retention — nothing past the window

  const ts = boundary[tsColumn]!;
  const older = await db.from(table).delete({ count: "exact" }).lt(tsColumn, ts);
  if (older.error) throw new Error(`prune ${table} (delete older) failed: ${older.error.message}`);

  // Rows sharing the boundary's exact timestamp are ranked by id, so only those
  // at or below the boundary id fall outside the window.
  const tied = await db.from(table).delete({ count: "exact" }).eq(tsColumn, ts).lte("id", boundary.id!);
  if (tied.error) throw new Error(`prune ${table} (delete tied) failed: ${tied.error.message}`);

  return (older.count ?? 0) + (tied.count ?? 0);
}

/** Announcements retention. Cascades to the tweets table via the FK. */
export async function prune(retain: number = DEFAULT_RETAIN): Promise<number> {
  return pruneTable("announcements", "ingested_at", retain);
}

/** Same rolling-window retention for the Ticker's raw ticker_items table. */
export async function pruneTicker(retain: number): Promise<number> {
  return pruneTable("ticker_items", "ingested_at", retain);
}

/** Same rolling-window retention for the AutoTweet engine's posting history. */
export async function pruneAutoTweets(retain: number): Promise<number> {
  return pruneTable("auto_tweets", "posted_at", retain);
}
