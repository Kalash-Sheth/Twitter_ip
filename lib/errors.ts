/**
 * A transient failure that should be retried later (rate limit, 5xx, network
 * blip) — NOT a permanent error. Stages catch this and leave the row in its
 * current status to retry next tick, so a temporary hiccup never burns a filing.
 */
export class RetryableError extends Error {}
