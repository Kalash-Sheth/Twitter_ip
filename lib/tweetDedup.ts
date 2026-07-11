/**
 * Backstop duplicate check for the AutoTweet engine — defense in depth behind
 * the LLM's own "don't repeat a recent topic" instruction. Plain word-overlap
 * (Jaccard), no LLM call, so it's free and catches the case where the model
 * picks the same story again under a slightly different topic_key.
 */
function words(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

export function tooSimilar(a: string, b: string, threshold: number): boolean {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return false;
  let overlap = 0;
  for (const w of wa) if (wb.has(w)) overlap++;
  const union = wa.size + wb.size - overlap;
  return union > 0 && overlap / union >= threshold;
}
