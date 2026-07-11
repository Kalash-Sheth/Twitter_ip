/**
 * Persist normalized announcements with TWO layers of dedup:
 *   1. (source, source_news_id) unique  — never re-store the same filing.
 *   2. dedup signature + TIME WINDOW     — never store the same STORY twice across
 *      exchanges: same company + event type AND within DEDUP_WINDOW_MIN minutes.
 *      (Two genuinely different same-type filings hours apart are both kept.)
 *
 * Returns the rows that were genuinely new.
 */
import { db } from "./db";
import { dedupKey } from "./dedup";
import type { Announcement } from "./types";

const WINDOW_MS = Number(process.env.DEDUP_WINDOW_MIN ?? 30) * 60_000;

const timeOf = (a: { announcement_dt: string | null }): number | null => {
  const t = a.announcement_dt ? Date.parse(a.announcement_dt) : NaN;
  return Number.isNaN(t) ? null : t;
};

export async function storeNew(items: Announcement[]): Promise<Announcement[]> {
  if (items.length === 0) return [];

  // Existing stories: signature -> list of announcement timestamps.
  const { data: existing } = await db.from("announcements").select("dedup_key, announcement_dt");
  const byKey = new Map<string, number[]>();
  for (const r of existing ?? []) {
    if (!r.dedup_key) continue;
    const t = timeOf(r);
    if (t !== null) (byKey.get(r.dedup_key) ?? byKey.set(r.dedup_key, []).get(r.dedup_key)!).push(t);
  }

  const isDup = (key: string, t: number | null): boolean => {
    if (t === null) return false; // no timestamp to compare -> keep (don't risk losing it)
    const times = byKey.get(key);
    return times ? times.some((et) => Math.abs(et - t) <= WINDOW_MS) : false;
  };

  // Keep only new stories; also collapses NSE+BSE of the same filing within this batch.
  const fresh: Announcement[] = [];
  for (const item of items) {
    const key = dedupKey(item);
    const t = timeOf(item);
    if (isDup(key, t)) continue;
    fresh.push({ ...item, dedup_key: key });
    if (t !== null) (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(t);
  }
  if (fresh.length === 0) return [];

  // Retry the write — transient "fetch failed" blips to Supabase shouldn't lose a tick.
  let data: { source_news_id: string }[] | null = null;
  let error: { message: string } | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    ({ data, error } = await db
      .from("announcements")
      .upsert(fresh, { onConflict: "source,source_news_id", ignoreDuplicates: true })
      .select("source_news_id"));
    if (!error) break;
    if (attempt < 3) await new Promise((r) => setTimeout(r, 400 * attempt));
  }

  if (error) throw new Error(`storeNew failed: ${error.message}`);

  const insertedIds = new Set((data ?? []).map((r) => r.source_news_id));
  return fresh.filter((i) => insertedIds.has(i.source_news_id));
}
