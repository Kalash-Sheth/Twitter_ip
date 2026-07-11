import { z } from "zod";

/**
 * What we ask Claude for, per filing. The model does NOT write the final tweet
 * as free text — it extracts typed editorial fields, and we render them through
 * a fixed house template (see render.ts) so every post is on-brand and
 * consistent. One call covers refined category + impact score + the fields.
 */
export const AnalysisSchema = z.object({
  category: z
    .string()
    .describe(
      "News type, refined from the filing content. Prefer one of: Earnings, Order Win, M&A, " +
        "Capex/Expansion, Management Change, Dividend/Buyback, Regulatory/Legal, Credit Rating, " +
        "Fundraise, Operational Update, Routine/Compliance, Other.",
    ),
  impact_score: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe(
      "How market-moving for the stock, 0-100. Routine compliance <20. Big earnings beats, " +
        "large order wins, M&A, buybacks, rating changes 70+. Be strict — most filings are noise.",
    ),
  impact_reason: z
    .string()
    .describe("One short sentence: the concrete fact that moves (or doesn't move) the stock."),

  // --- editorial card fields (rendered by render.ts) ---
  tag: z
    .string()
    .describe(
      "Short ALL-CAPS label for the card header, e.g. ORDER WIN, BUYBACK, RESULTS, M&A, " +
        "DIVIDEND, RATING, FUNDRAISE. Keep under ~16 chars.",
    ),
  headline: z
    .string()
    .describe(
      "One factual sentence leading with the company and the single most important fact/number, " +
        'e.g. "ABC Ltd secures ₹420 Cr order." Use ₹ and Cr/Lakh conventions. No hype.',
    ),
  facts: z
    .array(
      z.object({
        label: z.string().describe('Field name, e.g. "Size", "Price", "Premium", "Execution period".'),
        value: z.string().describe('Field value, e.g. "₹1,500 Cr", "₹980/share", "14%", "18 months".'),
      }),
    )
    .describe(
      "0-4 key supporting numbers as label/value pairs. Only include figures that actually appear " +
        "in the filing. Never invent numbers. Empty array if there are no clean supporting figures.",
    ),
});

export type Analysis = z.infer<typeof AnalysisSchema>;
