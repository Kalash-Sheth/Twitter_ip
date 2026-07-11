/**
 * Word-overlap (Jaccard) text similarity — no LLM call, so it's free. Used
 * two ways in the AutoTweet engine: as a duplicate-post backstop (defense in
 * depth behind the LLM's own "don't repeat a recent topic" instruction), and
 * to ground the LLM's pick_index against its own chosen_title (defense
 * against the model returning an index that doesn't match what it wrote
 * about — see worker/autotweet.ts).
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

export function jaccardSimilarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let overlap = 0;
  for (const w of wa) if (wb.has(w)) overlap++;
  const union = wa.size + wb.size - overlap;
  return union > 0 ? overlap / union : 0;
}

export function tooSimilar(a: string, b: string, threshold: number): boolean {
  return jaccardSimilarity(a, b) >= threshold;
}
