/**
 * Render the editorial card from Claude's typed fields into the final tweet
 * text — the RedboxIndia-style house format:
 *
 *   ORDER WIN
 *
 *   ABC Ltd secures ₹420 Cr order.
 *
 *   Execution period:
 *   18 months
 *
 *   Exchange Filing
 *   28 Jun 2026 · 10:32 AM IST
 *
 * Kept under 280 chars; if it would overflow we drop supporting facts from the
 * bottom up rather than truncate mid-number.
 */
import type { Analysis } from "./schema";

const LIMIT = 280;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-06-28T18:38:00" (IST already) -> "28 Jun 2026 · 6:38 PM IST". */
function istStamp(announcementDt: string | null): string {
  if (!announcementDt) return "Exchange Filing";
  const m = announcementDt.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return "Exchange Filing";
  const [, year, mon, day, hh, min] = m;
  let h = Number(hh);
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  const date = `${Number(day)} ${MONTHS[Number(mon) - 1]} ${year}`;
  return `${date} · ${h}:${min} ${ampm} IST`;
}

function compose(a: Analysis, factCount: number, time: string): string {
  const lines: string[] = [a.tag.trim(), "", a.headline.trim()];
  const facts = a.facts.slice(0, factCount);
  if (facts.length > 0) {
    lines.push("");
    for (const f of facts) {
      lines.push(`${f.label.trim()}:`);
      lines.push(f.value.trim());
    }
  }
  lines.push("", "Exchange Filing", time);
  return lines.join("\n");
}

export function renderTweet(a: Analysis, announcementDt: string | null): string {
  const time = istStamp(announcementDt);
  // Try with all facts, then shed them from the bottom until we fit 280 chars.
  for (let n = a.facts.length; n >= 0; n--) {
    const text = compose(a, n, time);
    if (text.length <= LIMIT) return text;
  }
  // Headline alone still too long — hard cap.
  return compose(a, 0, time).slice(0, LIMIT);
}
