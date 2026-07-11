/**
 * The whole pipeline in one long-running process. This is what you deploy.
 *
 * Every POLL_MS it runs the full chain end-to-end:
 *   1. fetch today's BSE filings   → store new (dedup on NEWSID)
 *   2. triage the new ones         → drop routine noise
 *   3. extract PDFs                → for survivors awaiting extraction
 *   4. analyze (LLM)             → impact score + editorial card
 *   5. distribute                  → auto-post (>= threshold & under budget) else queue
 *   6. prune                       → keep the newest RETAIN (rolling window)
 *
 * Ticks never overlap (we wait for one to finish, then wait POLL_MS), so a slow
 * batch of LLM calls can't stack up. Stage batches are capped so each tick stays
 * bounded; any backlog drains over the next few ticks.
 *
 *   npm start
 */
import "dotenv/config";
import { fetchAnnouncements } from "../lib/bse";
import { storeNew } from "../lib/store";
import { isTargetCategory } from "../lib/triage";
import { pdfTextFor, pdfTextForUrl } from "../lib/pdf";
import { analyze } from "../lib/analyze";
import { RetryableError } from "../lib/errors";
import { renderTweet } from "../lib/render";
import { getPoster } from "../lib/poster";
import { autoPostsLast24h } from "../lib/budget";
import { prune } from "../lib/prune";
import { db } from "../lib/db";

const POLL_MS = Number(process.env.POLL_MS ?? 15_000);
const RETAIN = Number(process.env.RETAIN ?? 100);
// 60 = "solidly newsworthy"+ in the rubric; drops the 45-59 "worth a mention"
// tier to cut posting volume down to the developments that matter most.
const THRESHOLD = Number(process.env.AUTO_POST_THRESHOLD ?? 60);
const BUDGET = Number(process.env.DAILY_TWEET_BUDGET ?? 16);
// Process a few at a time to pace the free LLM tier — avoids per-minute
// rate-limit bursts. New filings get analyzed steadily, one tick at a time.
const EXTRACT_BATCH = Number(process.env.EXTRACT_BATCH ?? 2);
const INTEL_BATCH = Number(process.env.INTEL_BATCH ?? 1);
// Hard ceiling on LLM calls per rolling 24h, well under Groq free-tier's daily
// request cap — once hit, analysis pauses for the rest of the window instead
// of grinding into hard rate-limit errors. A backlog just drains the next day.
const LLM_DAILY_CALL_BUDGET = Number(process.env.LLM_DAILY_CALL_BUDGET ?? 900);

const poster = getPoster();
const log = (...a: unknown[]) => console.log(`[${new Date().toISOString()}]`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Rolling 24h count of LLM calls made by this process, so a big backlog (e.g.
// after downtime) can't blow through the daily quota in one sitting.
const llmCallLog: number[] = [];
function llmCallsLast24h(): number {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  while (llmCallLog.length && llmCallLog[0]! < cutoff) llmCallLog.shift();
  return llmCallLog.length;
}

// Exponential backoff after transient LLM failures (rate limit / 5xx) — retrying
// every tick (15s) into a live rate limit just keeps tripping it. Back off
// 60s, 120s, 240s… capped at 10min, and reset the moment a call succeeds.
let intelBackoffUntil = 0;
let intelConsecutiveFailures = 0;
const INTEL_BACKOFF_BASE_MS = 60_000;
const INTEL_BACKOFF_MAX_MS = 10 * 60_000;

// Only pick up filings disseminated AFTER the worker started — begin fresh and
// follow new arrivals going forward, instead of replaying the whole day's backlog.
// (BSE timestamps are IST with no zone, so keep the server on TZ=Asia/Kolkata.)
// Override with SINCE_ISO=2026-06-28T09:00 to backfill from a specific moment.
const SINCE = process.env.SINCE_ISO ? Date.parse(process.env.SINCE_ISO) : Date.now();

/** 1-2: fetch BSE, keep only filings newer than SINCE, dedup, store + triage. */
async function ingestAndTriage(): Promise<number> {
  const today = new Date();
  let items: Awaited<ReturnType<typeof fetchAnnouncements>> = [];
  try {
    items = await fetchAnnouncements(today, today);
  } catch (err) {
    log("ingest: BSE fetch failed —", err instanceof Error ? err.message : err);
    return 0;
  }

  const recent = items.filter((i) => {
    const t = i.dissem_dt ?? i.announcement_dt;
    return t ? Date.parse(t) > SINCE : false;
  });
  const fresh = await storeNew(recent);
  if (fresh.length === 0) return 0;

  const routine = fresh
    .filter((f) => !isTargetCategory({ subject: f.subject, subcategory: f.subcategory, category: f.category, critical: f.critical }))
    .map((f) => f.source_news_id);
  if (routine.length > 0) {
    await db.from("announcements").update({ status: "skipped" }).in("source_news_id", routine);
  }

  const bySrc = fresh.reduce<Record<string, number>>((a, f) => ((a[f.source] = (a[f.source] ?? 0) + 1), a), {});
  const newest = fresh[0]!;
  const lagS = newest.dissem_dt ? Math.round((Date.now() - Date.parse(newest.dissem_dt)) / 1000) : null;
  log(
    `ingest: +${fresh.length} new (${JSON.stringify(bySrc)}, ${routine.length} routine) · ` +
      `newest [${newest.source}] "${newest.company}" lag ${lagS ?? "?"}s`,
  );
  return fresh.length - routine.length;
}

/** 3: extract PDFs for filings awaiting it (BSE via Live/His, NSE via direct URL). */
async function extractStage(): Promise<void> {
  const { data } = await db
    .from("announcements")
    .select("id, attachment_name, pdf_url, company")
    .eq("status", "ingested")
    .or("attachment_name.not.is.null,pdf_url.not.is.null")
    .order("ingested_at", { ascending: true })
    .limit(EXTRACT_BATCH);

  for (const row of data ?? []) {
    try {
      const text = row.attachment_name
        ? await pdfTextFor(row.attachment_name as string) // BSE
        : await pdfTextForUrl(row.pdf_url as string); // NSE
      await db.from("announcements").update({ pdf_text: text, status: "extracted", error_detail: null }).eq("id", row.id);
    } catch (err) {
      // Transient (network/host blip): leave as `ingested` to retry next tick.
      if (err instanceof RetryableError) continue;
      await db.from("announcements").update({ status: "failed", error_detail: String(err) }).eq("id", row.id);
    }
  }
}

/** 4: score + draft the editorial card for extracted filings. */
async function intelStage(): Promise<void> {
  if (Date.now() < intelBackoffUntil) return; // cooling down after a rate limit

  const callsUsed = llmCallsLast24h();
  if (callsUsed >= LLM_DAILY_CALL_BUDGET) {
    log(`intel: LLM daily budget reached (${callsUsed}/${LLM_DAILY_CALL_BUDGET}) — pausing analysis until it rolls off`);
    return;
  }

  const { data } = await db
    .from("announcements")
    .select("id, company, category, subcategory, critical, headline, subject, pdf_text, announcement_dt")
    .eq("status", "extracted")
    .order("ingested_at", { ascending: true })
    .limit(Math.min(INTEL_BATCH, LLM_DAILY_CALL_BUDGET - callsUsed));

  for (const row of data ?? []) {
    try {
      llmCallLog.push(Date.now());
      const a = await analyze({
        company: row.company,
        bse_category: row.category,
        bse_subcategory: row.subcategory,
        critical: row.critical ?? false,
        headline: row.headline,
        subject: row.subject,
        pdf_text: row.pdf_text,
      });
      intelConsecutiveFailures = 0;
      await db
        .from("announcements")
        .update({
          ai_category: a.category,
          impact_score: a.impact_score,
          impact_reason: a.impact_reason,
          summary: a.headline,
          tweet_text: renderTweet(a, row.announcement_dt),
          status: "drafted",
          error_detail: null,
        })
        .eq("id", row.id);
    } catch (err) {
      // Transient (rate limit / 5xx / network): back off and leave this
      // (and the rest) as `extracted` to retry later — never failed.
      if (err instanceof RetryableError) {
        intelConsecutiveFailures++;
        const backoffMs = Math.min(INTEL_BACKOFF_BASE_MS * 2 ** (intelConsecutiveFailures - 1), INTEL_BACKOFF_MAX_MS);
        intelBackoffUntil = Date.now() + backoffMs;
        log(`intel: LLM transient/rate-limit — backing off ${Math.round(backoffMs / 1000)}s (failure #${intelConsecutiveFailures})`);
        return;
      }
      await db.from("announcements").update({ status: "failed", error_detail: String(err) }).eq("id", row.id);
    }
  }
}

/**
 * 5: fully autonomous distribution — no human, no review queue.
 *   score >= THRESHOLD  ->  PUBLISH to the live frontend wall (always), and also
 *                           push to X when a live poster has budget left.
 *   otherwise           ->  discard (status `skipped`)
 * The frontend is the publication of record, so winners are never lost just
 * because X is unavailable (e.g. no posting credits). Highest-impact first.
 */
async function distributeStage(): Promise<void> {
  let used = await autoPostsLast24h();
  const { data } = await db
    .from("announcements")
    .select("id, company, tweet_text, impact_score")
    .eq("status", "drafted")
    .not("tweet_text", "is", null)
    .order("impact_score", { ascending: false });

  for (const row of data ?? []) {
    const score = row.impact_score ?? 0;

    if (score < THRESHOLD) {
      // Not newsworthy enough — discard, no queue.
      await db.from("announcements").update({ status: "skipped" }).eq("id", row.id);
      continue;
    }

    // Try X only when we have a live poster and budget; never block the wall on it.
    // The frontend wall is the publication of record — x_tweet_id stays null when
    // X is unavailable (e.g. no posting credits), and the card is published anyway.
    let xId: string | null = null;
    if (poster.mode === "x-live" && used < BUDGET) {
      try {
        ({ id: xId } = await poster.post(row.tweet_text as string));
        used++;
      } catch (err) {
        log(`  ⚠ X delivery failed (${String(err).slice(0, 70)}…) — showcasing on frontend`);
      }
    }

    await db.from("tweets").insert({
      announcement_id: row.id,
      text: row.tweet_text,
      auto: true,
      status: "posted",
      x_tweet_id: xId,
      posted_at: new Date().toISOString(),
    });
    await db.from("announcements").update({ status: "posted", error_detail: null }).eq("id", row.id);
    log(`  ▲ ${xId ? "POSTED→X" : "PUBLISHED"} [${score}] ${row.company}`);
  }
}

async function tick(): Promise<void> {
  // Run stages independently — a transient failure in one (e.g. a dropped
  // Supabase write during ingest) must not stop the others from draining the
  // existing backlog.
  const stages: [string, () => Promise<unknown>][] = [
    ["ingest", ingestAndTriage],
    ["extract", extractStage],
    ["intel", intelStage],
    ["distribute", distributeStage],
    ["prune", () => prune(RETAIN)],
  ];
  for (const [name, fn] of stages) {
    try {
      await fn();
    } catch (err) {
      log(`${name} error:`, err instanceof Error ? err.message : err);
    }
  }
}

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log(`${sig} — finishing current tick then exiting`);
    stopping = true;
  });
}

/**
 * The first outbound request after a cold process start can fail on some
 * systems (undici/macOS DNS warmup). Prime the Supabase connection with a
 * throwaway read (retried) so the real tick 1 doesn't take the hit.
 */
async function warmup(): Promise<void> {
  for (let i = 1; i <= 3; i++) {
    const { error } = await db.from("announcements").select("id").limit(1);
    if (!error) return;
    await sleep(500 * i);
  }
}

async function main(): Promise<void> {
  log(`orchestrator up · poll ${POLL_MS}ms · poster=${poster.mode} · threshold ${THRESHOLD} · retain ${RETAIN}`);
  log(`watching for filings disseminated after ${new Date(SINCE).toLocaleString()} (only new ones)`);
  await warmup();
  while (!stopping) {
    const t0 = Date.now();
    try {
      await tick();
    } catch (err) {
      log("tick error:", err);
    }
    await sleep(Math.max(0, POLL_MS - (Date.now() - t0)));
  }
  log("stopped.");
}

void main();
