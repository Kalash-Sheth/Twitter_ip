import { z } from "zod";

/**
 * What we ask the LLM for once per AutoTweet cycle: look at every article
 * from the last cycle and either pick the single best one, or pick nothing.
 */
export const TweetPickSchema = z.object({
  pick_index: z
    .number()
    .int()
    .nullable()
    .describe(
      "1-based index of the chosen article from the numbered list, or null if nothing is genuinely " +
        "tweet-worthy or every strong candidate just repeats an already-covered topic.",
    ),
  topic_key: z
    .string()
    .describe(
      'Short lowercase-hyphen slug identifying the story\'s topic, e.g. "reliance-q1-results", ' +
        '"rbi-repo-rate-cut" — used to detect the same story coming back in a later cycle. Empty ' +
        "string if pick_index is null.",
    ),
  tweet_text: z
    .string()
    .describe(
      "The finished tweet, ready to post as-is, <=280 chars: line 1 an ALL CAPS punchy headline, " +
        "then a blank line, then a properly composed 1-2 sentence body (not a copy of the source " +
        "title), then a blank line, then 2-3 relevant hashtags. No URL/link ever. Empty string if " +
        "pick_index is null.",
    ),
  impact_score: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe(
      "How good this pick is RELATIVE TO THE REST OF THIS BATCH, 0-100 — not an absolute bar. " +
        "0 if pick_index is null.",
    ),
  reason: z.string().describe("One short sentence: why this was chosen, or why nothing qualified."),
});

export type TweetPick = z.infer<typeof TweetPickSchema>;
