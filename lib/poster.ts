/**
 * Distribution is hidden behind this interface so the pipeline doesn't care
 * whether a tweet really goes to X or just gets logged. Default is dry-run
 * (logs the card) until X credentials exist in the environment — then the real
 * OAuth1 client takes over automatically.
 */
import { XPoster } from "./x";

export interface PostResult {
  id: string;
}

export interface Poster {
  readonly mode: string;
  post(text: string): Promise<PostResult>;
}

/** Logs the tweet instead of posting. Used until X creds are configured. */
class DryRunPoster implements Poster {
  readonly mode = "dry-run";
  async post(text: string): Promise<PostResult> {
    console.log("\n----- WOULD TWEET -----\n" + text + "\n-----------------------");
    return { id: `dryrun-${Date.now()}` };
  }
}

const hasXCreds = (): boolean =>
  Boolean(
    process.env.X_API_KEY &&
      process.env.X_API_SECRET &&
      process.env.X_ACCESS_TOKEN &&
      process.env.X_ACCESS_SECRET,
  );

// Deliberate kill-switch — independent of whether X creds are valid. Set
// DISABLE_X_POSTING=true in .env to force every engine (filings, newswire,
// pulse) into frontend-only mode. This is intentional, not a fallback: even if
// X credits/creds are restored, posting stays off until you flip this back.
const disabledByChoice = (): boolean => (process.env.DISABLE_X_POSTING ?? "").toLowerCase() === "true";

/** Pick the live X client if creds are present AND posting isn't deliberately disabled. */
export function getPoster(): Poster {
  if (disabledByChoice()) return new DryRunPoster();
  return hasXCreds() ? new XPoster() : new DryRunPoster();
}
