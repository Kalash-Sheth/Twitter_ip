/**
 * Rotates across multiple Groq API keys to multiply the effective free-tier
 * rate-limit budget — each key is presumably a separate account, each with
 * its own independent RPM/RPD/TPM/TPD allowance (see GROQ_API_KEYS in
 * .env.example). Falls back to a single key (LLM_API_KEY/GROQ_API_KEY) if
 * only one is configured — rotation is then a no-op.
 *
 * Rotates two ways: on a fixed timer (GROQ_KEY_ROTATE_HOURS, default 2h) so
 * load spreads evenly across the day, AND immediately whenever a call comes
 * back 429 (lib/tweetPick.ts calls rotateGroqKeyNow on that), so a key that's
 * already rate-limited is never retried against until its window comes back
 * around on its own.
 */
const KEYS = (process.env.GROQ_API_KEYS ?? process.env.LLM_API_KEY ?? process.env.GROQ_API_KEY ?? "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

const ROTATE_MS = Number(process.env.GROQ_KEY_ROTATE_HOURS ?? 2) * 60 * 60 * 1000;

let currentIndex = 0;
let lastRotated = Date.now();

function maybeRotateByTime(): void {
  if (KEYS.length <= 1) return;
  if (Date.now() - lastRotated >= ROTATE_MS) {
    currentIndex = (currentIndex + 1) % KEYS.length;
    lastRotated = Date.now();
    console.log(
      `[${new Date().toISOString()}] rotated Groq key (${ROTATE_MS / 3_600_000}h timer) — now using key #${currentIndex + 1}/${KEYS.length}`,
    );
  }
}

/** The key to use for the next call — checks the time-based rotation first. */
export function currentGroqKey(): string | undefined {
  maybeRotateByTime();
  return KEYS[currentIndex];
}

/** Force an immediate rotation, e.g. right after a 429 on the current key. */
export function rotateGroqKeyNow(reason: string): void {
  if (KEYS.length <= 1) return;
  currentIndex = (currentIndex + 1) % KEYS.length;
  lastRotated = Date.now();
  console.log(`[${new Date().toISOString()}] rotated Groq key (${reason}) — now using key #${currentIndex + 1}/${KEYS.length}`);
}

export function groqKeyCount(): number {
  return KEYS.length;
}
