import { createHash } from "node:crypto"

export interface RateLimitConfig {
  /** Tokens per minute. Default 60. */
  ratePerMinute?: number
  /** Burst capacity. Default 10. */
  burst?: number
  /** Override for tests; defaults to () => Date.now() */
  now?: () => number
}

export interface RateLimitResult {
  allowed: boolean
  /** Milliseconds until the next token is available. 0 if allowed. */
  retryAfterMs: number
  /** Tokens remaining in the bucket after this take (decimal ok). */
  remaining: number
}

export interface RateLimiter {
  /** key = `${tokenFingerprint}:${agentId}` (or `"anon:<agentId>"` if no token). */
  take(key: string, cost?: number): RateLimitResult
  /** Test helper. */
  reset(): void
}

interface Bucket {
  tokens: number
  lastRefill: number
}

const DEFAULT_RATE_PER_MINUTE = 60
const DEFAULT_BURST = 10

export function createRateLimiter(config: RateLimitConfig = {}): RateLimiter {
  const ratePerMinute = config.ratePerMinute ?? DEFAULT_RATE_PER_MINUTE
  const burst = config.burst ?? DEFAULT_BURST
  const now = config.now ?? (() => Date.now())
  const refillRatePerMs = ratePerMinute / 60_000

  // v1: no eviction. Cardinality is bounded by the number of distinct
  // (tokenFingerprint, agentId) tuples in normal operation. Under sustained
  // attack with rotating tokens this map could grow unboundedly; acceptable
  // for v1, revisit when we see real traffic. `reset()` is exposed for tests
  // and to allow operators to clear state without restarting.
  const buckets = new Map<string, Bucket>()

  return {
    take(key: string, cost: number = 1): RateLimitResult {
      const t = now()
      let bucket = buckets.get(key)
      if (bucket === undefined) {
        bucket = { tokens: burst, lastRefill: t }
        buckets.set(key, bucket)
      } else {
        const elapsed = Math.max(0, t - bucket.lastRefill)
        bucket.tokens = Math.min(burst, bucket.tokens + elapsed * refillRatePerMs)
        bucket.lastRefill = t
      }

      if (bucket.tokens >= cost) {
        bucket.tokens -= cost
        return { allowed: true, retryAfterMs: 0, remaining: bucket.tokens }
      }

      const deficit = cost - bucket.tokens
      const retryAfterMs =
        refillRatePerMs > 0 ? Math.ceil(deficit / refillRatePerMs) : Number.POSITIVE_INFINITY
      return { allowed: false, retryAfterMs, remaining: bucket.tokens }
    },

    reset(): void {
      buckets.clear()
    },
  }
}

/**
 * Derive the short, opaque token fingerprint used in the rate-limit key.
 * Returns `"anon"` when token is undefined, null, or empty string.
 */
export function tokenFingerprint(token: string | undefined | null): string {
  if (token === undefined || token === null || token === "") {
    return "anon"
  }
  return createHash("sha256").update(token).digest("hex").slice(0, 8)
}
