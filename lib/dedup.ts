/**
 * Cross-exchange de-duplication.
 *
 * The same company files the same news to BOTH NSE and BSE, but with different
 * IDs, slightly different company-name spelling ("Ltd" vs "Limited"), and often
 * different subject wording. So we can't dedup on text alone. Instead we build a
 * coarse signature: normalized company + the broad EVENT TYPE.
 *
 * The signature alone is intentionally NOT time-bound — store.ts pairs it with a
 * short TIME WINDOW: two filings collapse only if they share the signature AND
 * land within ~30 min of each other (i.e. the same filing cross-posted to both
 * exchanges). Two genuinely different same-type filings hours apart are kept.
 */

/** Strip suffixes/punctuation so "Camlin Fine Sciences Ltd" == "Camlin Fine Sciences Limited". */
function normalizeCompany(name: string | null): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[-$]/g, " ")
    .replace(/\b(limited|ltd|pvt|private|inc|corporation|corp|company|co|the)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Map a filing's subject/category text to a broad event bucket. */
function eventBucket(text: string): string {
  const t = text.toLowerCase();
  const has = (...words: string[]) => words.some((w) => t.includes(w));
  if (has("buyback", "buy back")) return "buyback";
  if (has("dividend")) return "dividend";
  if (has("bonus")) return "bonus";
  if (has("split", "sub-division", "subdivision")) return "split";
  if (has("amalgamation", "merger", "acquisition", "acqui", "stake", "demerger")) return "ma";
  if (has("order", "contract", "bags", "secures", "awarded", "work order", "loa", "letter of award")) return "order";
  if (has("result", "financial result", "quarterly", "earnings")) return "results";
  if (has("fund rais", "fundrais", "qip", "preferential", "allot", "rights issue", "ncd", "debenture")) return "fundraise";
  if (has("rating", "credit rating")) return "rating";
  if (has("board meeting", "outcome of board", "board of director")) return "board";
  if (has("investor meet", "analyst", "con. call", "conference call", "earnings call", "investor presentation")) return "investor_meet";
  if (has("resignation", "appointment", "cessation", "resign", "appoint", "director")) return "management";
  if (has("expansion", "capacity", "commission", "plant", "capex", "facility")) return "expansion";
  if (has("acquisition of order", "agreement", "mou", "partnership", "joint venture", "jv", "collaboration")) return "partnership";
  return "other";
}

/** The dedup signature for a filing: normalized company + event type (no time). */
export function dedupKey(args: { company: string | null; subject: string; category: string | null }): string {
  const co = normalizeCompany(args.company);
  const bucket = eventBucket(`${args.subject} ${args.category ?? ""}`);
  return `${co}|${bucket}`;
}
