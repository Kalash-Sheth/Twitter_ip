/**
 * Free-tier guardrail. X's free tier allows ~500 writes/month (~16/day), so we
 * cap auto-posts over a rolling 24h window. Anything over budget is queued for
 * human review instead of dropped.
 */
import { db } from "./db";

export async function autoPostsLast24h(): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await db
    .from("tweets")
    .select("*", { count: "exact", head: true })
    .eq("auto", true)
    .eq("status", "posted")
    .not("x_tweet_id", "is", null) // only real X deliveries count against the X quota
    .gte("posted_at", since);
  if (error) throw new Error(`budget check failed: ${error.message}`);
  return count ?? 0;
}
