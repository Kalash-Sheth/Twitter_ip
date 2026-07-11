/**
 * The TICKER engine — raw news aggregation, no editorial layer. Every 5
 * seconds (while active — see below) it fetches:
 *   1. all 15 verified RSS feeds (lib/tickerFeeds.ts)
 *   2. ET + Moneycontrol + India Today via the shared HTML scraper
 *      (lib/scrape.ts + lib/newsSites.ts) — it already has its own
 *      freshness-gate and per-source novelty tracking built in
 * ...spanning Markets / Indian Economy / Business / Finance, keeps only
 * genuinely NEW articles (published after this process started — no backlog
 * replay), and stores them for the /ticker frontend to show live, each with a
 * link back to the source. NO LLM, NO posting — that's the AutoTweet engine's
 * job (worker/autotweet.ts), which reads from ticker_items on its own 7-min
 * cycle and clears out what it's analyzed.
 *
 * PIB's feed carries no per-item date, so it can't be gated by timestamp — it
 * instead seeds a baseline of currently-visible links on the first tick (emits
 * nothing) and only passes through links it hasn't seen before on later ticks.
 *
 * Moneycontrol's scraped feed is general (politics/sports/entertainment mixed
 * in) — a cheap keyword pre-filter (lib/newsFilter.ts, no AI) drops obvious
 * noise before it's stored here.
 *
 * Active 8AM-12AM IST only (lib/activeHours.ts, shared with AutoTweet) —
 * outside that window it just checks back once a minute without polling.
 *
 * Runs alongside the Filings (BSE/NSE) worker but shares nothing with it.
 *
 *   npm run ticker
 *   SINCE_ISO=2026-07-09T09:00 npm run ticker   # backfill from a specific moment
 */
import "dotenv/config";
import { TICKER_FEEDS, mapScrapedCategory, isBusinessRelevant } from "../lib/tickerFeeds";
import { fetchTickerFeed, type TickerItem } from "../lib/tickerRss";
import { fetchAllScraped } from "../lib/scrape";
import { SITES } from "../lib/newsSites";
import { isNoise } from "../lib/newsFilter";
import { storeTickerItems } from "../lib/tickerStore";
import { pruneTicker } from "../lib/prune";
import { isActiveNow } from "../lib/activeHours";
import { db } from "../lib/db";

const POLL_MS = Number(process.env.TICKER_POLL_MS ?? 5_000);
const RETAIN = Number(process.env.TICKER_RETAIN ?? 300);
// How often to re-check for the active window while quiet (12AM-8AM IST).
const QUIET_CHECK_MS = 60_000;

const log = (...a: unknown[]) => console.log(`[${new Date().toISOString()}]`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A tick that finds nothing new and nothing failed logs NOTHING (by design, to
// cut noise) — but that's indistinguishable from "stuck" over a quiet stretch.
// Print a heartbeat at least this often so liveness is never ambiguous.
const HEARTBEAT_MS = 60_000;
let lastHeartbeat = 0;
let ticksSinceHeartbeat = 0;

// Only articles published after this moment are ever stored — start fresh, no backlog.
const START = process.env.SINCE_ISO ? Date.parse(process.env.SINCE_ISO) : Date.now();
// For date-less feeds (PIB): baseline of links already seen, so tick 1 seeds
// silently and only later, genuinely-new links pass through.
const seenNoDate = new Set<string>();
let seededNoDate = false;

// Per-feed backoff — a source that fails BACKOFF_AFTER ticks in a row (e.g. gets
// blocked, same pattern we've hit with Business Standard/CNBC-TV18 elsewhere)
// stops being hammered every tick and is instead checked at a growing interval
// (capped at 5 min). One success resets it to full health immediately. This is
// per-feed — a struggling source never slows down any of the others.
interface FeedHealth { failCount: number; nextAttempt: number; }
const feedHealth = new Map<string, FeedHealth>();
const BACKOFF_AFTER = 3;
const BACKOFF_MAX_MS = 5 * 60_000;

function dueForFetch(publisher: string): boolean {
  const h = feedHealth.get(publisher);
  return !h || Date.now() >= h.nextAttempt;
}
function recordFeedResult(publisher: string, ok: boolean): void {
  if (ok) {
    feedHealth.delete(publisher);
    return;
  }
  const h = feedHealth.get(publisher) ?? { failCount: 0, nextAttempt: 0 };
  h.failCount++;
  h.nextAttempt =
    Date.now() + (h.failCount >= BACKOFF_AFTER ? Math.min(BACKOFF_MAX_MS, 15_000 * 2 ** (h.failCount - BACKOFF_AFTER)) : 0);
  feedHealth.set(publisher, h);
}

/** Keep only items published after START; for date-less items, seed-then-diff by link. */
function filterFresh(items: TickerItem[]): TickerItem[] {
  const fresh: TickerItem[] = [];
  for (const item of items) {
    if (item.published_at) {
      if (Date.parse(item.published_at) > START) fresh.push(item);
      continue;
    }
    if (seenNoDate.has(item.link)) continue;
    seenNoDate.add(item.link);
    if (seededNoDate) fresh.push(item);
  }
  seededNoDate = true;
  if (seenNoDate.size > 2000) {
    const keep = [...seenNoDate].slice(-1000);
    seenNoDate.clear();
    for (const l of keep) seenNoDate.add(l);
  }
  return fresh;
}

async function tick(): Promise<void> {
  const activeFeeds = TICKER_FEEDS.filter((f) => dueForFetch(f.publisher));
  const skipped = TICKER_FEEDS.length - activeFeeds.length;

  // RSS and the ET/MC/India Today scraper are fully independent — run them
  // concurrently instead of back-to-back (measured: roughly halves tick time).
  const [rssResults, scrapedResult] = await Promise.all([
    Promise.allSettled(activeFeeds.map((f) => fetchTickerFeed(f))),
    fetchAllScraped(SITES).catch((err) => {
      log("scrape error:", err instanceof Error ? err.message : err);
      return [] as Awaited<ReturnType<typeof fetchAllScraped>>;
    }),
  ]);

  const items: TickerItem[] = [];
  let failed = 0;
  rssResults.forEach((r, i) => {
    const publisher = activeFeeds[i]!.publisher;
    recordFeedResult(publisher, r.status === "fulfilled");
    if (r.status !== "fulfilled") {
      failed++;
      return;
    }
    for (const item of r.value) {
      // ET Now has no dedicated business feed (it's their sitewide latest —
      // FIFA World Cup, celebrity home purchases, etc. mixed in) — same
      // relevance gate as Moneycontrol's unscoped scraped feed.
      if (item.publisher === "ET Now" && !isBusinessRelevant(item.title)) continue;
      items.push(item);
    }
  });
  const fresh = filterFresh(items);

  // ET + Moneycontrol scraper — already freshness-gated and novelty-tracked by
  // fetchAllScraped itself, so these go straight into the store without passing
  // through filterFresh (that logic is for the RSS-sourced, date-driven items).
  let scrapedCount = 0;
  for (const s of scrapedResult) {
    if (!s.link || isNoise(s.title, s.link)) continue;
    // MC's feed is unscoped (no per-section categories like ET has) — require a
    // real business/markets/finance/economy hit, not just "not obvious noise".
    if (s.source === "Moneycontrol" && !isBusinessRelevant(`${s.title} ${s.description ?? ""}`)) continue;
    fresh.push({
      publisher: s.source,
      category: mapScrapedCategory(s.feed_category),
      title: s.title,
      link: s.link,
      published_at: s.published_at,
    });
    scrapedCount++;
  }

  const stored = await storeTickerItems(fresh);
  await pruneTicker(RETAIN);

  if (stored > 0 || failed > 0) {
    log(
      `tick: +${stored} new (${scrapedCount} scraped)${failed ? ` · ${failed}/${activeFeeds.length} feeds errored` : ""}${skipped ? ` · ${skipped} backing off` : ""}`,
    );
    lastHeartbeat = Date.now();
    ticksSinceHeartbeat = 0;
    return;
  }

  ticksSinceHeartbeat++;
  if (Date.now() - lastHeartbeat > HEARTBEAT_MS) {
    log(
      `heartbeat: alive, ${ticksSinceHeartbeat} quiet ticks since last update (nothing new, no errors)${skipped ? ` · ${skipped} feeds backing off` : ""}`,
    );
    lastHeartbeat = Date.now();
    ticksSinceHeartbeat = 0;
  }
}

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log(`${sig} — finishing current tick then exiting`);
    stopping = true;
  });
}

async function warmup(): Promise<void> {
  for (let i = 1; i <= 3; i++) {
    const { error } = await db.from("ticker_items").select("id").limit(1);
    if (!error) return;
    if (/ticker_items/.test(error.message) && /does not exist|schema cache/i.test(error.message)) {
      log("⚠ ticker_items table not found — run the SQL in supabase/schema.sql (TICKER block) in the Supabase SQL editor, then restart.");
    }
    await sleep(500 * i);
  }
}

async function main(): Promise<void> {
  log(`ticker up · ${TICKER_FEEDS.length} feeds · poll ${POLL_MS}ms · retain ${RETAIN} · active 8AM-12AM IST · no AI, no posting — raw display only`);
  log(`only articles published after ${new Date(START).toLocaleString()} will show (no backlog)`);
  lastHeartbeat = Date.now();
  await warmup();
  let wasActive = isActiveNow();
  if (!wasActive) log("starting in quiet hours (12AM-8AM IST) — will wait for 8AM");
  while (!stopping) {
    const t0 = Date.now();
    const active = isActiveNow();
    if (active !== wasActive) {
      log(active ? "active hours started (8AM IST) — resuming polling" : "quiet hours (12AM-8AM IST) — pausing polling until morning");
      wasActive = active;
    }
    if (active) {
      try {
        await tick();
      } catch (err) {
        log("tick error:", err instanceof Error ? err.message : err);
      }
      await sleep(Math.max(0, POLL_MS - (Date.now() - t0)));
    } else {
      await sleep(QUIET_CHECK_MS);
    }
  }
  log("stopped.");
}

void main();
