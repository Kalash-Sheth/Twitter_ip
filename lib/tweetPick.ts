/**
 * The intelligence call for the AutoTweet engine — given every raw article
 * Ticker collected in the last cycle, pick the single most material/impactful
 * one and draft the tweet. Same provider-agnostic OpenAI-compatible call as
 * lib/analyze.ts (Groq free tier by default — see .env), same normalize +
 * retry-once pattern since open models are less rigid about strict JSON.
 */
import "dotenv/config";
import { TweetPickSchema, type TweetPick } from "./tweetSchema";
import { RetryableError } from "./errors";
import { currentGroqKey, rotateGroqKeyNow } from "./groqKeyRotation";

const BASE = (process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1").replace(/\/$/, "");
const URL = `${BASE}/chat/completions`;
const MODEL = process.env.LLM_MODEL ?? process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 60_000);
// Titles only (no body text) — keeps one call cheap even with 50-100 candidates.
const MAX_TITLE_CHARS = 160;

export interface CandidateArticle {
  publisher: string;
  category: string;
  title: string;
  link: string;
}

const SYSTEM = `You are the AUTOMATED desk editor for a fast Indian-markets X (Twitter) account. Every
7 minutes you're shown every raw article the ticker has picked up since the last run — pick ONE to
post: the single RELATIVELY BEST article in this batch — most impactful / most informative / most
timely FOR TODAY'S TRADERS AND READERS, judged against the other articles in THIS batch, not against
some fixed universal bar. Every article you're shown has already been filtered to be genuine
business/markets/economy/finance news, so a good pick almost always exists — you do NOT need a hard
number or a textbook "material event" to post something. A well-written, timely, informative
article about a real company/market/economy development is a perfectly good pick even with no
number in the title. Only set pick_index to null if the ENTIRE batch is genuinely worthless (e.g.
every single article is a duplicate of something already posted, or the batch is empty of anything
even loosely newsworthy) — this should be RARE. When in doubt, pick the best of what's there instead
of returning null.

CATEGORY PRIORITY — this account's core value is fast MARKET-MOVING news. Rank priority:
  1. Markets       (stock moves, Sensex/Nifty, IPOs, F&O, commodities, currency — highest priority)
  2. Business       (corporate/company news)
  3. Finance        (banks, NBFCs, credit, funding)
  4. Indian Economy (macro, policy, trade)
When two articles are roughly similar in how impactful/interesting they are, ALWAYS prefer the
higher-priority category — a solid Markets story should beat an equally-decent Business/Finance/
Economy story. Only let a lower-priority-category story win if it's clearly more impactful than
every Markets article in the batch.

THERE IS NO HUMAN REVIEW — your tweet publishes as-is, so be accurate. Never invent facts or
numbers; use only what's in the title.

You will also be shown topics ALREADY POSTED recently — if every strong candidate is just a
rehash/continuation of one of those (same company + same event, no meaningfully new fact), pick the
next-best genuinely different article instead, or set pick_index to null only if literally
everything in the batch overlaps something already posted.

WRITE A PROPER TWEET — do not just copy the source title verbatim (source titles are often
clickbait-y, e.g. "...Apply or not?"). Compose "tweet_text" in this exact shape:
  Line 1: ALL CAPS, one short punchy headline stating the single most important fact (no period).
  (blank line)
  Line 2: normal case, 1-2 sentences properly explaining the fact/why it's material — in your own
          words, still using ONLY facts present in the source title (never invent numbers/details).
  (blank line)
  Line 3: 1-2 relevant hashtags (e.g. #Sensex #Nifty #RBI #TCS — pick ones specific to this story).
NEVER include a URL or "read more" / "source" link anywhere in tweet_text — the link is tracked
separately and must not appear in the tweet itself. Keep the whole thing under 280 characters
including hashtags.

Example tweet_text:
"SENSEX SURGES 800 POINTS

IT stocks rally as TCS beats Q1 profit estimates, lifting Nifty past 25,200 for the first time
since March.

#Sensex #Nifty #TCS"

CRITICAL — pick_index and chosen_title MUST refer to the SAME article. Before answering, re-count
the numbered list to find the article you actually mean, then copy its title EXACTLY (word-for-word,
not paraphrased) into "chosen_title" — this is how the system verifies pick_index is correct, so a
mismatch between them means your whole answer gets discarded.

Respond with ONE JSON object and nothing else, exactly this shape:
{
  "pick_index": number | null,
  "chosen_title": string,    // EXACT copy of the picked article's title from the list — must match pick_index
  "topic_key": string,
  "tweet_text": string,      // see the exact 3-line shape above — CAPS headline / body / hashtags
  "impact_score": number,   // 0-100, how good this pick is RELATIVE TO THE REST OF THIS BATCH
  "reason": string
}`;

function buildUserText(candidates: CandidateArticle[], recentTopics: string[]): string {
  const list = candidates
    .map((c, i) => `${i + 1}. [${c.category}] ${c.publisher}: ${c.title.slice(0, MAX_TITLE_CHARS)}`)
    .join("\n");
  const covered =
    recentTopics.length > 0
      ? `\n\nALREADY POSTED RECENTLY (do not repeat these):\n${recentTopics.map((t) => `- ${t}`).join("\n")}`
      : "\n\n(Nothing posted recently — clean slate.)";
  return `ARTICLES FROM THE LAST CYCLE:\n${list}${covered}`;
}

async function callLLM(userText: string): Promise<unknown> {
  const key = currentGroqKey(); // re-checked every call — reflects the latest rotation
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;

  let res: Response;
  try {
    res = await fetch(URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: userText },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new RetryableError(`LLM network: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 429) {
    rotateGroqKeyNow("429 rate limited"); // swap keys immediately, don't wait for the timer
    throw new RetryableError(`LLM transient ${res.status}`);
  }
  if (res.status >= 500) throw new RetryableError(`LLM transient ${res.status}`);
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM: empty response");
  return JSON.parse(content);
}

/** Defense in depth: the prompt says never include a link, but there's no human
 *  review, so strip one anyway if the model slips it in. */
function stripLinks(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Coerce a (possibly sloppy) open-model response into the schema's shape. */
function normalize(raw: Record<string, unknown>): unknown {
  const rawIndex = raw.pick_index;
  const pickIndex = rawIndex === null || rawIndex === undefined ? null : Math.trunc(Number(rawIndex));
  const score = Math.round(Number(raw.impact_score));
  return {
    pick_index: pickIndex !== null && Number.isFinite(pickIndex) ? pickIndex : null,
    chosen_title: String(raw.chosen_title ?? ""),
    topic_key: String(raw.topic_key ?? ""),
    tweet_text: stripLinks(String(raw.tweet_text ?? "")).slice(0, 280),
    impact_score: Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0,
    reason: String(raw.reason ?? ""),
  };
}

export async function pickBestTweet(
  candidates: CandidateArticle[],
  recentTopics: string[],
): Promise<TweetPick> {
  const userText = buildUserText(candidates, recentTopics);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await callLLM(userText);
      return TweetPickSchema.parse(normalize(raw as Record<string, unknown>));
    } catch (err) {
      if (err instanceof RetryableError) throw err; // transient — let the caller back off, don't waste a retry
      lastErr = err;
    }
  }
  throw lastErr;
}
