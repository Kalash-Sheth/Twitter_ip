/**
 * Retention — keep only the most recent N announcements; delete the rest so the
 * database stays small (this is a live news feed, not an archive). Cascades to
 * the tweets table via the FK. Called on every orchestrator tick.
 */
import { db } from "./db";

const DEFAULT_RETAIN = Number(process.env.RETAIN ?? 100);

export async function prune(retain: number = DEFAULT_RETAIN): Promise<number> {
  // List rows newest-first by (ingested_at, id) so ties are broken
  // deterministically, then delete everything past the newest `retain` by id.
  const { data: rows, error: selErr } = await db
    .from("announcements")
    .select("id")
    .order("ingested_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(10_000);
  if (selErr) throw new Error(`prune (select) failed: ${selErr.message}`);

  const old = (rows ?? []).slice(retain).map((r) => r.id);
  if (old.length === 0) return 0;

  // Delete in chunks — a single huge IN(...) list overflows the request limit.
  let removed = 0;
  for (let i = 0; i < old.length; i += 100) {
    const chunk = old.slice(i, i + 100);
    const { error: delErr, count } = await db
      .from("announcements")
      .delete({ count: "exact" })
      .in("id", chunk);
    if (delErr) throw new Error(`prune (delete) failed: ${delErr.message}`);
    removed += count ?? 0;
  }
  return removed;
}

/** Same rolling-window retention for the Ticker's raw ticker_items table. */
export async function pruneTicker(retain: number): Promise<number> {
  const { data: rows, error: selErr } = await db
    .from("ticker_items")
    .select("id")
    .order("ingested_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(10_000);
  if (selErr) throw new Error(`pruneTicker (select) failed: ${selErr.message}`);

  const old = (rows ?? []).slice(retain).map((r) => r.id);
  if (old.length === 0) return 0;

  let removed = 0;
  for (let i = 0; i < old.length; i += 100) {
    const chunk = old.slice(i, i + 100);
    const { error: delErr, count } = await db.from("ticker_items").delete({ count: "exact" }).in("id", chunk);
    if (delErr) throw new Error(`pruneTicker (delete) failed: ${delErr.message}`);
    removed += count ?? 0;
  }
  return removed;
}

/** Same rolling-window retention for the AutoTweet engine's posting history. */
export async function pruneAutoTweets(retain: number): Promise<number> {
  const { data: rows, error: selErr } = await db
    .from("auto_tweets")
    .select("id")
    .order("posted_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(10_000);
  if (selErr) throw new Error(`pruneAutoTweets (select) failed: ${selErr.message}`);

  const old = (rows ?? []).slice(retain).map((r) => r.id);
  if (old.length === 0) return 0;

  let removed = 0;
  for (let i = 0; i < old.length; i += 100) {
    const chunk = old.slice(i, i + 100);
    const { error: delErr, count } = await db.from("auto_tweets").delete({ count: "exact" }).in("id", chunk);
    if (delErr) throw new Error(`pruneAutoTweets (delete) failed: ${delErr.message}`);
    removed += count ?? 0;
  }
  return removed;
}
