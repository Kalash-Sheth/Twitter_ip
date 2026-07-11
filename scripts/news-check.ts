/**
 * Fetch every ET/Moneycontrol/India Today section page once and report how many
 * articles each yields + a sample title. This is the scraper Ticker's worker
 * relies on for those three sources — use this to spot markup a publisher has
 * changed or a source that's being blocked (esp. from a non-residential IP).
 *   npm run scrape:check
 */
import "dotenv/config";
import { checkAllSections } from "../lib/scrape";
import { SITES } from "../lib/newsSites";

(async () => {
  const rows = await checkAllSections(SITES);
  let ok = 0;
  let site = "";
  for (const r of rows) {
    if (r.site !== site) {
      site = r.site;
      console.log(`\n── ${site} ──`);
    }
    if (r.status === "ok" && r.count > 0) ok++;
    const mark = r.status === "ok" && r.count > 0 ? "✓" : "✗";
    console.log(`${mark} ${String(r.count).padStart(3)}  ${r.path.padEnd(46)} ${r.category}`);
    if (r.sample) console.log(`      ↳ "${r.sample.slice(0, 80)}"`);
  }
  console.log(`\n${ok}/${rows.length} sections live.`);
})();
