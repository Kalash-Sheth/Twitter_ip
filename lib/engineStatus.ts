/**
 * Health signal for the Groq LLM call AutoTweet depends on. Upserted from
 * worker/autotweet.ts on every outcome (success, rate limit/backoff, daily
 * budget pause, other error) so the frontend can show a banner ONLY when
 * something is actually wrong — never a permanent fixture on the page.
 */
import { db } from "./db";

export type EngineStatusLevel = "ok" | "degraded" | "down";

export async function reportEngineStatus(
  id: string,
  status: EngineStatusLevel,
  message: string | null,
): Promise<void> {
  const { error } = await db
    .from("engine_status")
    .upsert({ id, status, message, updated_at: new Date().toISOString() }, { onConflict: "id" });
  if (error) console.error(`[${new Date().toISOString()}] reportEngineStatus failed:`, error.message);
}
