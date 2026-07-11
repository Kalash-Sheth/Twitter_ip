/**
 * The AUTOTWEET engine — sits on top of Ticker's raw feed. Every 7 minutes,
 * while active (8AM-12AM IST, see lib/activeHours.ts), it:
 *   1. reads EVERY article currently sitting in ticker_items (accumulated
 *      since the last run)
 *   2. asks the LLM to pick the single most material/impactful one and draft
 *      the tweet — or pick nothing if the batch is all routine/soft/duplicate
 *   3. posts the pick (respects the same X kill-switch/dry-run as the other
 *      engines — see lib/poster.ts) and logs it to auto_tweets for dedup
 *      context in future cycles
 *   4. deletes the WHOLE batch it just analyzed (whether or not it posted),
 *      so the next run only ever sees fresh articles — Ticker keeps filling
 *      ticker_items independently in the background
 *
 * Duplicate protection is two-layered: the LLM is shown recent topic_keys and
 * told not to repeat them, and a plain word-overlap check (lib/tweetDedup.ts)
 * backstops that in case the model slips.
 *
 * On a transient LLM failure (rate limit / network), the batch is
 * deliberately NOT deleted — it's retried next cycle instead of losing those
 * articles to a blip. On a non-transient error (bad response), the batch is
 * cleared anyway so one poison batch can't stall the engine forever.
 *
 *   npm run autotweet
 */
import "dotenv/config";
import { db } from "../lib/db";
import { getPoster } from "../lib/poster";
import { pickBestTweet, type CandidateArticle } from "../lib/tweetPick";
import { tooSimilar } from "../lib/tweetDedup";
import { pruneAutoTweets } from "../lib/prune";
import { RetryableError } from "../lib/errors";
import { isActiveNow } from "../lib/activeHours";

const POLL_MS = Number(process.env.AUTOTWEET_POLL_MS ?? 7 * 60_000);
const QUIET_CHECK_MS = 60_000; // how often to re-check for the active window during quiet hours
const RETAIN = Number(process.env.AUTOTWEET_RETAIN ?? 500);
// Scoring is now RELATIVE to the rest of the batch (see lib/tweetPick.ts), not
// an absolute "material event" bar — so this is just a sanity floor to catch a
// genuinely empty/degenerate response, not a second strict filter. The LLM is
// instructed to almost always find a best-of-batch pick rather than return null.
const MIN_SCORE = Number(process.env.AUTO_TWEET_MIN_SCORE ?? 20);
const DEDUP_LOOKBACK_MIN = Number(process.env.AUTO_TWEET_DEDUP_LOOKBACK_MIN ?? 240);
const DEDUP_JACCARD = Number(process.env.AUTO_TWEET_DEDUP_JACCARD ?? 0.5);
// Cap what's sent to the LLM in one call — keeps a single request small (and
// under Groq free-tier's tokens-per-minute limit) even after a long backlog
// (e.g. the worker was down a while). Normal 7-min cadence rarely gets close
// to this; any overflow beyond the cap just waits for the next cycle.
const MAX_BATCH = Number(process.env.AUTO_TWEET_MAX_BATCH ?? 60);
// Comfortably under Groq free-tier's daily cap — 7min cadence over a 16h
// active window is ~137 calls/day at most anyway, so this is a safety net.
const LLM_DAILY_CALL_BUDGET = Number(process.env.AUTOTWEET_LLM_DAILY_BUDGET ?? 250);

const poster = getPoster();
const log = (...a: unknown[]) => console.log(`[${new Date().toISOString()}]`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Backstop for "hashtags should be there" — the prompt already asks for 2-3,
// but there's no human review, so fall back to category tags if the model
// forgets, rather than ever post without any.
const CATEGORY_HASHTAGS: Record<string, string> = {
  Markets: "#Sensex #Nifty",
  Business: "#Business",
  Finance: "#Finance",
  "Indian Economy": "#Economy",
};
function ensureHashtags(text: string, category: string): string {
  if (/#\w/.test(text)) return text;
  const tag = CATEGORY_HASHTAGS[category] ?? "#India";
  const withTag = `${text}\n\n${tag}`;
  return withTag.length <= 280 ? withTag : text;
}

let intelBackoffUntil = 0;
let consecutiveFailures = 0;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 10 * 60_000;

const llmCallLog: number[] = [];
function llmCallsLast24h(): number {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  while (llmCallLog.length && llmCallLog[0]! < cutoff) llmCallLog.shift();
  return llmCallLog.length;
}

async function recentTopics(): Promise<{ topic_key: string; headline: string }[]> {
  const since = new Date(Date.now() - DEDUP_LOOKBACK_MIN * 60_000).toISOString();
  const { data } = await db
    .from("auto_tweets")
    .select("topic_key, headline")
    .gte("posted_at", since)
    .order("posted_at", { ascending: false })
    .limit(30);
  return data ?? [];
}

/** Chunked delete — a single huge IN(...) list can overflow the request limit. */
async function deleteBatch(ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const { error } = await db.from("ticker_items").delete().in("id", chunk);
    if (error) log("tick: failed to clear part of the analyzed batch —", error.message);
  }
}

async function tick(): Promise<void> {
  const { data: rows, error } = await db
    .from("ticker_items")
    .select("id, publisher, category, title, link")
    .order("ingested_at", { ascending: true })
    .limit(MAX_BATCH);
  if (error) {
    log("tick: fetch failed —", error.message);
    return;
  }
  if (!rows || rows.length === 0) {
    log("tick: nothing new since last run — nothing to analyze");
    return;
  }

  const ids = rows.map((r) => r.id as string);
  const candidates: CandidateArticle[] = rows.map((r) => ({
    publisher: r.publisher as string,
    category: r.category as string,
    title: r.title as string,
    link: r.link as string,
  }));

  if (Date.now() < intelBackoffUntil) {
    log(`tick: cooling down after an LLM failure — skipping (batch of ${rows.length} stays queued for next run)`);
    return;
  }
  const callsUsed = llmCallsLast24h();
  if (callsUsed >= LLM_DAILY_CALL_BUDGET) {
    log(`tick: LLM daily budget reached (${callsUsed}/${LLM_DAILY_CALL_BUDGET}) — skipping, batch kept for later`);
    return;
  }

  let clearBatch = true;
  try {
    const recent = await recentTopics();
    llmCallLog.push(Date.now());
    const pick = await pickBestTweet(
      candidates,
      recent.map((r) => r.topic_key).filter(Boolean),
    );
    consecutiveFailures = 0;

    if (pick.pick_index == null || pick.impact_score < MIN_SCORE) {
      log(`tick: no post-worthy pick from ${rows.length} articles (${pick.reason || "below bar"})`);
    } else {
      const chosen = candidates[pick.pick_index - 1];
      if (!chosen) {
        log(`tick: LLM picked an out-of-range index (${pick.pick_index}/${candidates.length}) — discarding pick`);
      } else {
        const dupByKey = recent.some((r) => r.topic_key && r.topic_key === pick.topic_key);
        const dupByText = recent.some((r) => tooSimilar(pick.tweet_text, r.headline, DEDUP_JACCARD));
        if (dupByKey || dupByText) {
          log(`tick: skipping likely-duplicate pick "${chosen.title.slice(0, 60)}" — overlaps a recent post`);
        } else {
          const tweetText = ensureHashtags(pick.tweet_text, chosen.category);
          let xId: string | null = null;
          if (poster.mode === "x-live") {
            try {
              ({ id: xId } = await poster.post(tweetText));
            } catch (err) {
              log(`  ⚠ X delivery failed (${String(err).slice(0, 70)}…)`);
            }
          } else {
            await poster.post(tweetText); // dry-run logs it
          }
          await db.from("auto_tweets").insert({
            topic_key: pick.topic_key,
            headline: tweetText,
            tweet_text: tweetText,
            source_publisher: chosen.publisher,
            source_link: chosen.link,
            source_category: chosen.category,
            impact_score: pick.impact_score,
            x_tweet_id: xId,
            posted_at: new Date().toISOString(),
          });
          log(`  ▲ ${xId ? "POSTED→X" : "DRY-RUN"} [${pick.impact_score}] ${chosen.publisher}: ${chosen.title.slice(0, 70)}`);
        }
      }
    }
  } catch (err) {
    if (err instanceof RetryableError) {
      consecutiveFailures++;
      const backoffMs = Math.min(BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1), BACKOFF_MAX_MS);
      intelBackoffUntil = Date.now() + backoffMs;
      clearBatch = false; // transient — retry the SAME batch next cycle instead of losing it
      log(`tick: LLM transient/rate-limit — backing off ${Math.round(backoffMs / 1000)}s (failure #${consecutiveFailures}); batch kept for retry`);
    } else {
      log("tick: LLM error, clearing batch —", err instanceof Error ? err.message : err);
    }
  }

  if (clearBatch) await deleteBatch(ids);
  await pruneAutoTweets(RETAIN);
}

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log(`${sig} — finishing current tick then exiting`);
    stopping = true;
  });
}

/** Prime the Supabase connection so tick 1 doesn't take a cold-start hit. */
async function warmup(): Promise<void> {
  for (let i = 1; i <= 3; i++) {
    const { error } = await db.from("auto_tweets").select("id").limit(1);
    if (!error) return;
    if (i === 3) log("warmup: auto_tweets table not reachable — run the SQL block in supabase/schema.sql");
    await sleep(500 * i);
  }
}

async function main(): Promise<void> {
  log(
    `autotweet up · every ${Math.round(POLL_MS / 60_000)}min · poster=${poster.mode} · ` +
      `min score ${MIN_SCORE} · active 8AM-12AM IST`,
  );
  await warmup();
  let wasActive = isActiveNow();
  if (!wasActive) log("starting in quiet hours (12AM-8AM IST) — will wait for 8AM");
  while (!stopping) {
    const t0 = Date.now();
    const active = isActiveNow();
    if (active !== wasActive) {
      log(active ? "active hours started (8AM IST) — resuming" : "quiet hours (12AM-8AM IST) — pausing until morning");
      wasActive = active;
    }
    if (active) {
      try {
        await tick();
      } catch (err) {
        log("tick error:", err);
      }
      await sleep(Math.max(0, POLL_MS - (Date.now() - t0)));
    } else {
      await sleep(QUIET_CHECK_MS);
    }
  }
  log("stopped.");
}

void main();
