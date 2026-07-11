/**
 * Headline-based dedup signature for news. The SAME story breaks across ET,
 * Moneycontrol, Mint, BS, CNBC within minutes — worded slightly differently.
 * We reduce a headline to a stable signature so those collapse to one post:
 *   lowercase → strip publisher tails/punctuation → drop stopwords →
 *   keep significant tokens → sort → take the first few.
 *
 * Two genuinely different stories rarely share the same significant-token set,
 * and a short time window (applied in the store) guards against false merges.
 */

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "at", "by", "with",
  "as", "is", "are", "was", "were", "be", "from", "that", "this", "it", "its", "up",
  "after", "over", "amid", "into", "says", "say", "said", "will", "may", "new",
  "india", "indian", "report", "rs", "cr", "crore", "lakh", "pct", "percent",
]);

export function normalizeHeadline(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/[^a-z0-9%₹.\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[-.]+|[-.]+$/g, ""))
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** Signature = the 6 most significant tokens, sorted, joined. */
export function newsDedupKey(title: string): string {
  const tokens = normalizeHeadline(title);
  // Numbers/₹ figures are highly distinctive — keep them; then fill with words.
  const nums = tokens.filter((t) => /[0-9%₹]/.test(t));
  const words = tokens.filter((t) => !/[0-9%₹]/.test(t));
  const sig = [...new Set([...nums, ...words])].sort().slice(0, 6);
  return sig.join("|");
}
