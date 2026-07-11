/**
 * Cheap, deterministic pre-filter. BSE/NSE push ~800 filings/day but we only
 * ever tweet two news types: Earnings and Order Win. Everything else is
 * dropped from metadata alone — before downloading any PDF or calling the
 * LLM — since it would never be posted regardless of what the LLM says.
 *
 * Precision over recall on the allow-list: a wrongly-dropped filing is gone
 * forever, so patterns are kept broad enough to catch real earnings/order-win
 * filings even at the cost of occasionally letting a near-miss through to the
 * LLM (which will just score it low).
 */

// Financial results / earnings filings.
const EARNINGS_PATTERN =
  /\bfinancial results?\b|\b(un)?audited\b.{0,20}results?|results?\s+for\s+the\s+(quarter|year|half-?year)|\bquarterly results?\b|\bconsolidated results?\b|\bstandalone results?\b|\bearnings\b/i;

// Order / contract wins.
const ORDER_WIN_PATTERN =
  /\border\b.{0,25}(win|won|worth|bagged|received|secured|award)|bag(s|ged)\b.{0,15}order|secures?\b.{0,15}(order|contract|project)|work order|letter of (intent|award|acceptance)|\bLOA\b|award of order/i;

export interface TriageInput {
  subject: string;
  subcategory: string | null;
  category?: string | null;
  critical: boolean;
}

/** True if the filing is an Earnings or Order Win candidate worth sending to the LLM. */
export function isTargetCategory({ subject, subcategory, category }: TriageInput): boolean {
  const hay = `${subject} ${subcategory ?? ""} ${category ?? ""}`;
  return EARNINGS_PATTERN.test(hay) || ORDER_WIN_PATTERN.test(hay);
}

// ---------------------------------------------------------------------------
// PREVIOUS APPROACH (deny-list of procedural noise, kept for all other news
// types) — disabled now that the pipeline only targets Earnings/Order Win via
// isTargetCategory() above, but preserved in case the scope widens again.
// ---------------------------------------------------------------------------
//
// // Real corporate actions — NEVER triage-drop these, whatever else the subject says.
// // Note: dividend/bonus/split/record-date are here so a "…Dividend And AGM" notice
// // is rescued from the AGM pattern. Management is scoped to "X of <senior role>" so
// // routine "re-appointment of Director" in AGM notices still drops.
// const MATERIAL_OVERRIDE =
//   /\bbuy-?back\b|\bbonus\b|stock split|sub-division|\bdividend\b|preferential (issue|allotment)|\bqip\b|rights issue|fund ?rais|amalgamation|\bmerger\b|acquisi|takeover|scheme of arrangement|open offer|delisting|\border\b.{0,25}(win|won|worth|bagged|received|secured|award)|bag(s|ged)\b.{0,15}order|secures?\b.{0,15}(order|contract|project)|work order|letter of (intent|award|acceptance)|\bLOA\b|credit rating|rating (up|down|re)|winning bid|(appointment|resignation|cessation|change|induction) of\s.{0,30}(managing director|chief executive|chief financial|\bCEO\b|\bCFO\b|chairman|whole-?time director|executive director)/i;
//
// // Subject / subcategory patterns that are procedural noise.
// const ROUTINE_PATTERNS: RegExp[] = [
//   /trading window/i,
//   /newspaper\s+(publication|advertisement|clipping|copy)/i,
//   /publication\s+in\s+newspaper/i,
//   /certificate under reg(ulation)?\.?\s*74\s*\(?5\)?/i, // RTA quarterly cert
//   /reg(ulation)?\.?\s*7\s*\(3\)/i, // compliance certificate
//   /reg(ulation)?\.?\s*40\s*\(9\)|40\s*\(10\)/i, // share transfer cert
//   /reg(ulation)?\.?\s*39\s*\(3\)/i, // loss of share certificate
//   /(loss|duplicate|issue)\s+(of\s+)?(share\s+)?certificate/i,
//   /secretarial\s+compliance/i,
//   /compliances?-certificate/i,
//   /grievance redressal|reg(ulation)?\.?\s*13\s*\(3\)/i,
//   /\bISIN\b.*activation/i,
//
//   // ---- expanded (data-driven: these reached the LLM and always scored low) ----
//   /reg(ulation)?\.?\s*57\s*\(5\)|compliance-?\s*57\s*\(5\)/i, // interest/principal payment intimation
//   /reg(ulation)?\.?\s*34\s*\(1\)|\bannual report\b/i, // annual report copy
//   /annual general meeting|\bAGM\b|extra-?ordinary general meeting|\bEGM\b|shareholders'?\s+meeting|postal ballot|notice of (the\s+)?\d*.{0,4}(annual|general) meeting/i, // meeting notices
//   /board meeting intimation|intimation.{0,25}board meeting|intimation of board meeting/i, // board-meeting SCHEDULING (outcome files separately)
//   /business responsibility and sustainability|\bBRSR\b/i, // BRSR report
//   /certificate from ceo\s*\/?\s*cfo|ceo\s*\/?\s*cfo\s+certif|reg(ulation)?\.?\s*33\b.{0,30}certif/i, // CEO/CFO certification
//   /non-?applicability of reg(ulation)?|certificate of non-?applicability/i, // non-applicability certs
//   /functional website|declaration.{0,25}website/i, // website declaration
//   /physical shareholders|updation of (pan|kyc|bank|nomination|details)|\bfolio\b/i, // shareholder KYC housekeeping
//   /reg(ulation)?\.?\s*7\s*\(2\)|prohibition of insider trading/i, // PIT disclosures
//   /grant of (employee )?stock options|\besop\b|\besos\b|\besps\b/i, // ESOP grants
//   /book closure|record date.{0,20}(agm|dividend already)/i, // book-closure housekeeping
//   /related party transaction.{0,15}(disclosure|reg)|reg(ulation)?\.?\s*23\s*\(9\)/i, // RPT half-yearly disclosure
// ];
//
// // Whole BSE/NSE categories that are administrative by nature — matched against
// // the raw CATEGORYNAME the exchange assigns (not the AI-derived category).
// const ROUTINE_CATEGORIES = [
//   /insider trading\s*\/?\s*sast/i,
//   /trading window/i,
//   /^agm\s*\/?\s*egm$/i,
//   /esop\s*\/?\s*esos\s*\/?\s*esps/i,
// ];
//
// /** True if the filing is procedural noise that should be skipped before the LLM. */
// export function isRoutine({ subject, subcategory, category, critical }: TriageInput): boolean {
//   if (critical) return false; // BSE flagged it as critical — never drop
//   const hay = `${subject} ${subcategory ?? ""}`;
//   // Rescue genuinely material actions before any routine pattern can drop them.
//   if (MATERIAL_OVERRIDE.test(hay)) return false;
//   if (category && ROUTINE_CATEGORIES.some((re) => re.test(category))) return true;
//   return ROUTINE_PATTERNS.some((re) => re.test(hay));
// }
