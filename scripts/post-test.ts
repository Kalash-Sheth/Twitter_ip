/**
 * One-off X posting test — verifies the OAuth1 credentials + signature by posting
 * a single, uniquely-timestamped tweet. Run BEFORE letting the pipeline post on
 * its own.   npm run post:test
 */
import "dotenv/config";
import { getPoster } from "../lib/poster";

(async () => {
  const poster = getPoster();
  console.log("poster mode:", poster.mode);
  if (poster.mode !== "x-live") {
    if ((process.env.DISABLE_X_POSTING ?? "").toLowerCase() === "true") {
      console.log("✗ X posting is deliberately disabled (DISABLE_X_POSTING=true in .env). Remove/unset it to test live posting.");
    } else {
      console.log("✗ X credentials not detected in .env (need all four: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET).");
    }
    process.exit(1);
  }

  // Unique text — X rejects duplicate tweets.
  const text = `🟢 Live test — Fastest IP automated markets desk is online (BSE + NSE). [test ${new Date().toISOString().slice(11, 19)} IST]`;
  console.log("posting:", text);

  try {
    const { id } = await poster.post(text);
    console.log(`\n✓ POSTED — id ${id}`);
    console.log(`  https://x.com/i/web/status/${id}`);
  } catch (e) {
    console.log(`\n✗ POST FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
})();
