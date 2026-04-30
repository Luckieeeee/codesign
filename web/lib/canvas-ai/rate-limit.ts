/**
 * Tiny in-memory token-bucket rate limiter keyed by user id.
 *
 * Survives only as long as the Node process — fine for a single-instance
 * dev / preview deploy. Swap for Upstash / Redis when going multi-region.
 */

type Bucket = {
  tokens: number
  lastRefillMs: number
}

const BUCKETS = new Map<string, Bucket>()

const CAPACITY = 20
const REFILL_PER_MS = CAPACITY / (60 * 1000) // 20 requests per minute

export type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfterMs: number }

export function checkRateLimit(key: string): RateLimitResult {
  const now = Date.now()
  const bucket = BUCKETS.get(key) ?? { tokens: CAPACITY, lastRefillMs: now }
  const elapsed = now - bucket.lastRefillMs
  bucket.tokens = Math.min(CAPACITY, bucket.tokens + elapsed * REFILL_PER_MS)
  bucket.lastRefillMs = now

  if (bucket.tokens < 1) {
    BUCKETS.set(key, bucket)
    const deficit = 1 - bucket.tokens
    return { ok: false, retryAfterMs: Math.ceil(deficit / REFILL_PER_MS) }
  }

  bucket.tokens -= 1
  BUCKETS.set(key, bucket)
  return { ok: true }
}
