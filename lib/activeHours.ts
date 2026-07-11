/**
 * Shared "are we live right now" gate for Ticker + the AutoTweet engine. Both
 * run 8AM-12AM IST only — overnight is a deliberate quiet period (nothing
 * happening in Indian markets/news, no point polling or burning LLM calls).
 * Hardcoded to Asia/Kolkata since this is an Indian-markets product.
 */
const START_HOUR = Number(process.env.ACTIVE_START_HOUR ?? 8);
const END_HOUR = Number(process.env.ACTIVE_END_HOUR ?? 24); // 24 = runs through midnight

function currentIstHour(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const raw = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  return raw % 24; // normalize the midnight edge case some ICU builds report as "24"
}

export function isActiveNow(): boolean {
  const h = currentIstHour();
  if (END_HOUR >= 24) return h >= START_HOUR;
  return h >= START_HOUR && h < END_HOUR;
}
