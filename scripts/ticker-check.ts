/**
 * Fetch every Ticker RSS feed once and report freshness — use it to catch a
 * feed a publisher has broken, or to see if previously-blocked sources
 * (Business Standard, Zee Business, NDTV Profit, Moneycontrol) work from your
 * current IP (they're Akamai-blocked from most servers, but may work from a
 * residential connection).
 *   npm run ticker:check
 */
import "dotenv/config";
import { TICKER_FEEDS } from "../lib/tickerFeeds";
import { fetchTickerFeed } from "../lib/tickerRss";

(async () => {
  const results = await Promise.allSettled(TICKER_FEEDS.map((f) => fetchTickerFeed(f)));
  let ok = 0;
  results.forEach((r, i) => {
    const f = TICKER_FEEDS[i]!;
    if (r.status === "fulfilled") {
      ok++;
      const newest = r.value[0];
      const age = newest?.published_at ? Math.round((Date.now() - Date.parse(newest.published_at)) / 60000) : null;
      console.log(`✓ ${f.publisher.padEnd(28)} n=${String(r.value.length).padStart(3)} newest=${age ?? "?"}m  [${f.category}]`);
      if (newest) console.log(`    "${newest.title.slice(0, 70)}"`);
    } else {
      console.log(`✗ ${f.publisher.padEnd(28)} FAILED: ${r.reason instanceof Error ? r.reason.message : r.reason}`);
    }
  });
  console.log(`\n${ok}/${TICKER_FEEDS.length} feeds live.`);
})();
