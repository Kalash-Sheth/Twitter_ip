/**
 * The intelligence call — turns a raw BSE filing into a refined category, an
 * impact score, and the editorial card fields.
 *
 * Provider-agnostic: it speaks the OpenAI-compatible /chat/completions API, so
 * the same code runs against any of these by setting env vars (see .env.example):
 *   • Local / open-source via Ollama  → $0, no rate limits  (LLM_BASE_URL=http://localhost:11434/v1)
 *   • Groq free cloud                 → $0, rate-limited     (LLM_BASE_URL=https://api.groq.com/openai/v1)
 *   • Any other OpenAI-compatible host (LM Studio, vLLM, OpenAI, OpenRouter…)
 *
 * Open models are less rigid, so we ask for a strict JSON object, normalize the
 * result (clamp score, clean facts, fallbacks) before validating, and retry once.
 * The analyze() interface is unchanged, so nothing downstream cares which model runs.
 */
import "dotenv/config";
import { AnalysisSchema, type Analysis } from "./schema";
import { RetryableError } from "./errors";

const BASE = (process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1").replace(/\/$/, "");
const URL = `${BASE}/chat/completions`;
const MODEL = process.env.LLM_MODEL ?? process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";
const KEY = process.env.LLM_API_KEY ?? process.env.GROQ_API_KEY; // optional (local needs none)
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 60_000); // local CPU can be slow
// Enough to judge accurately (material facts are on page one), while keeping
// free-tier token use down — fewer tokens/call = more filings before the daily cap.
const MAX_PDF_CHARS = Number(process.env.MAX_PDF_CHARS ?? 5_000);

export interface AnalyzeInput {
  company: string | null;
  bse_category: string | null;
  bse_subcategory: string | null;
  critical: boolean;
  headline: string | null;
  subject: string;
  pdf_text: string | null;
}

const SYSTEM = `You are the AUTOMATED desk editor for a fast, high-volume Indian-markets news account
(like RedboxIndia). You read raw BSE corporate filings and turn the genuine business updates into
tight, accurate posts. THERE IS NO HUMAN REVIEW — your post publishes as-is, so be accurate first.

We post ONLY MATERIAL news — filings a trader would actually act on. Most filings are NOT material;
be strict and skeptical. A filing is material only if it has (a) a HARD NUMBER of real size
(order/contract value, deal size, results figures, dividend, buyback, fundraise amount, capex,
capacity) OR (b) a clearly market-moving EVENT (M&A, stake acquisition, buyback, credit-rating
change, top-management change at a significant company, major regulatory action, default/insolvency).
If a filing has NEITHER a hard number NOR a clearly market-moving event, it is NOT material — score it
under 60 so it will not post.

IMPACT SCORE (0-100) — anything 60+ auto-posts, so 60 is the bar for "genuinely material":
  80-100  Big & clearly market-moving: large orders, M&A, buybacks, special/large dividends,
          earnings surprises, credit-rating changes, big QIP/fundraises, major capex/expansion.
  60-79   Solidly material WITH a hard number or clear impact: order/contract WIN with a disclosed
          value, quarterly results with figures, dividend, sizable fundraise, stake acquisition with
          size, new plant with capacity/investment, MD/CEO/CFO/Chairman change at a significant
          company, regulatory approval/action with real consequence.
  40-59   Minor / soft — DOES NOT POST: small or unvalued contracts, generic "operational/business
          updates" with no number, MOUs/JVs with no disclosed size, subsidiary housekeeping,
          a single non-executive/independent director appointment or resignation, small allotments.
  0-39    Procedural noise: schedules/intimations, compliance & secretarial certificates, newspaper
          publications, trading-window notices, company-secretary / auditor / RTA changes, ESOP
          allotments, committee reconstitutions, purely administrative filings.

MATERIALITY RULES (be strict — over-posting erodes the account):
- ROUTINE GOVERNANCE IS NOT NEWS. Appointment/resignation of a single director, company secretary,
  auditor, or KMP; committee reconstitution; RTA/registrar change → score UNDER 45. Reserve 60+ for a
  top leadership change (MD/CEO/CFO/Chairman) at a company of real size.
- NO NUMBER, NO EVENT → UNDER 60. A JV/MOU/partnership/"business update" with no disclosed value or
  scale is not material. Do not round up soft news to clear the bar.
- When unsure whether it is material, score it BELOW 60. Skipping a marginal filing is fine;
  posting a non-event is not.

ACCURACY RULES (posts publish automatically):
- NEVER invent, round, or estimate numbers. Use only figures explicitly in the filing; omit any
  that aren't there. A wrong number is worse than a missing one.
- The headline must lead with the single most important fact/number, be factual, no hype.
- The card facts must be the few hard numbers a trader would want, copied exactly from the filing.

Respond with ONE JSON object and nothing else, exactly this shape:
{
  "category": string,        // prefer: Earnings, Order Win, M&A, Capex/Expansion, Management Change,
                             //          Dividend/Buyback, Regulatory/Legal, Credit Rating, Fundraise,
                             //          Operational Update, Routine/Compliance, Other
  "impact_score": number,    // 0-100. 60+ ONLY for material events with a hard number or clear
                             //         market impact. Routine governance/admin/soft news <60. Be strict.
  "impact_reason": string,   // one short sentence: the fact that moves (or doesn't move) the stock
  "tag": string,             // ALL-CAPS card header, e.g. ORDER WIN, BUYBACK, RESULTS, M&A, DIVIDEND
  "headline": string,        // one factual sentence leading with the company + key number (use Rs/Cr)
  "facts": [ { "label": string, "value": string } ]  // 0-4 real figures from the filing, or []
}`;

interface RawAnalysis {
  category?: unknown;
  impact_score?: unknown;
  impact_reason?: unknown;
  tag?: unknown;
  headline?: unknown;
  facts?: unknown;
}

/** Coerce a (possibly sloppy) open-model response into the schema's shape. */
function normalize(raw: RawAnalysis, input: AnalyzeInput): unknown {
  const score = Math.round(Number(raw.impact_score));
  const facts = Array.isArray(raw.facts)
    ? raw.facts
        .filter((f) => f && typeof f === "object" && "label" in f && "value" in f)
        .slice(0, 4)
        .map((f) => ({ label: String((f as any).label), value: String((f as any).value) }))
    : [];
  return {
    category: String(raw.category ?? "Other"),
    impact_score: Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0,
    impact_reason: String(raw.impact_reason ?? ""),
    tag: String(raw.tag ?? "UPDATE").toUpperCase(),
    headline: String(raw.headline ?? input.subject),
    facts,
  };
}

async function callLLM(userText: string): Promise<RawAnalysis> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (KEY) headers.Authorization = `Bearer ${KEY}`;

  let res: Response;
  try {
    res = await fetch(URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: userText },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // Network drop / timeout — transient, retry later.
    throw new RetryableError(`LLM network: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Rate limit or server error → transient (pause + retry next tick).
  if (res.status === 429 || res.status >= 500) throw new RetryableError(`LLM transient ${res.status}`);
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM: empty response");
  return JSON.parse(content) as RawAnalysis;
}

export async function analyze(input: AnalyzeInput): Promise<Analysis> {
  const pdf = (input.pdf_text ?? "").slice(0, MAX_PDF_CHARS);
  const userText = [
    `Company: ${input.company ?? "(unknown)"}`,
    `BSE category: ${input.bse_category ?? "-"} / ${input.bse_subcategory ?? "-"}`,
    `BSE critical flag: ${input.critical ? "YES" : "no"}`,
    `Subject: ${input.subject}`,
    input.headline ? `Headline: ${input.headline}` : "",
    "",
    "Filing text:",
    pdf || "(no extracted text)",
  ]
    .filter(Boolean)
    .join("\n");

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await callLLM(userText);
      return AnalysisSchema.parse(normalize(raw, input));
    } catch (err) {
      if (err instanceof RetryableError) throw err; // transient — let the caller pause, don't waste a retry
      lastErr = err;
    }
  }
  throw lastErr;
}
