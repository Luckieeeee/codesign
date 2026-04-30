import { describe, expect, test } from "bun:test"
import { createRateLimiter, tokenFingerprint } from "../rate-limit"

function makeClock(initial = 0): { value: number; now: () => number } {
  const clock = { value: initial, now: () => clock.value }
  return clock
}

describe("createRateLimiter", () => {
  test("bucket starts full: first take returns allowed with remaining = burst - 1", () => {
    const clock = makeClock(1_000)
    const limiter = createRateLimiter({
      ratePerMinute: 60,
      burst: 10,
      now: clock.now,
    })

    const result = limiter.take("k")

    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(9)
    expect(result.retryAfterMs).toBe(0)
  })

  test("drains then blocks: 11th take with no time progression is denied with retryAfterMs ~ 1000", () => {
    const clock = makeClock(1_000)
    const limiter = createRateLimiter({
      ratePerMinute: 60,
      burst: 10,
      now: clock.now,
    })

    for (let i = 0; i < 10; i++) {
      const r = limiter.take("k")
      expect(r.allowed).toBe(true)
      expect(r.remaining).toBe(9 - i)
    }

    const blocked = limiter.take("k")
    expect(blocked.allowed).toBe(false)
    expect(blocked.remaining).toBe(0)
    // 1 token / (60 per 60_000 ms) = 1000 ms.
    expect(blocked.retryAfterMs).toBe(1000)
  })

  test("refills over time: advancing clock by 1000 ms after exhaustion allows one more take", () => {
    const clock = makeClock(1_000)
    const limiter = createRateLimiter({
      ratePerMinute: 60,
      burst: 10,
      now: clock.now,
    })

    for (let i = 0; i < 10; i++) {
      limiter.take("k")
    }
    const blocked = limiter.take("k")
    expect(blocked.allowed).toBe(false)

    clock.value += 1000
    const refilled = limiter.take("k")
    expect(refilled.allowed).toBe(true)
  })

  test("refill caps at burst: long idle does not exceed burst capacity", () => {
    const clock = makeClock(1_000)
    const limiter = createRateLimiter({
      ratePerMinute: 60,
      burst: 10,
      now: clock.now,
    })

    for (let i = 0; i < 10; i++) {
      limiter.take("k")
    }

    clock.value += 60_000
    const result = limiter.take("k")
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(9)
  })

  test("per-key isolation: exhausting one key does not affect another", () => {
    const clock = makeClock(1_000)
    const limiter = createRateLimiter({
      ratePerMinute: 60,
      burst: 10,
      now: clock.now,
    })

    for (let i = 0; i < 10; i++) {
      const r = limiter.take("a")
      expect(r.allowed).toBe(true)
    }
    const blockedA = limiter.take("a")
    expect(blockedA.allowed).toBe(false)

    const allowedB = limiter.take("b")
    expect(allowedB.allowed).toBe(true)
    expect(allowedB.remaining).toBe(9)
  })

  test("reset() empties state: after reset the bucket starts full again", () => {
    const clock = makeClock(1_000)
    const limiter = createRateLimiter({
      ratePerMinute: 60,
      burst: 10,
      now: clock.now,
    })

    for (let i = 0; i < 10; i++) {
      limiter.take("k")
    }
    expect(limiter.take("k").allowed).toBe(false)

    limiter.reset()

    const result = limiter.take("k")
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(9)
  })

  test("custom cost: take(key, 5) decrements by 5 and blocks when insufficient", () => {
    const clock = makeClock(1_000)
    const limiter = createRateLimiter({ now: clock.now })

    const first = limiter.take("k", 5)
    expect(first.allowed).toBe(true)
    expect(first.remaining).toBe(5)

    const second = limiter.take("k", 5)
    expect(second.allowed).toBe(true)
    expect(second.remaining).toBe(0)

    const third = limiter.take("k", 5)
    expect(third.allowed).toBe(false)
    expect(third.remaining).toBe(0)
  })
})

describe("tokenFingerprint", () => {
  test("undefined token → 'anon'", () => {
    expect(tokenFingerprint(undefined)).toBe("anon")
  })

  test("null token → 'anon'", () => {
    expect(tokenFingerprint(null)).toBe("anon")
  })

  test("empty string token → 'anon'", () => {
    expect(tokenFingerprint("")).toBe("anon")
  })

  test("'abc' fingerprint is first 8 hex chars of sha256('abc')", () => {
    expect(tokenFingerprint("abc")).toBe("ba7816bf")
  })

  test("deterministic: same input produces same fingerprint", () => {
    expect(tokenFingerprint("abc")).toBe(tokenFingerprint("abc"))
  })

  test("different inputs produce different fingerprints", () => {
    expect(tokenFingerprint("abc")).not.toBe(tokenFingerprint("abd"))
  })
})

describe("rate limiter keying by (tokenFingerprint, agentId)", () => {
  test("two agents sharing a token are isolated", () => {
    const clock = makeClock(1_000)
    const limiter = createRateLimiter({
      ratePerMinute: 60,
      burst: 10,
      now: clock.now,
    })

    const fp = tokenFingerprint("abc")
    expect(fp).toBe("ba7816bf")

    const keyAgent1 = `${fp}:agent1`
    const keyAgent2 = `${fp}:agent2`

    for (let i = 0; i < 10; i++) {
      expect(limiter.take(keyAgent1).allowed).toBe(true)
    }
    expect(limiter.take(keyAgent1).allowed).toBe(false)

    const allowed = limiter.take(keyAgent2)
    expect(allowed.allowed).toBe(true)
    expect(allowed.remaining).toBe(9)
  })

  test("anon mode: undefined token produces 'anon:<agentId>' keys with same isolation", () => {
    const clock = makeClock(1_000)
    const limiter = createRateLimiter({
      ratePerMinute: 60,
      burst: 10,
      now: clock.now,
    })

    const fp = tokenFingerprint(undefined)
    expect(fp).toBe("anon")

    const keyAgent1 = `${fp}:agent1`
    const keyAgent2 = `${fp}:agent2`
    expect(keyAgent1).toBe("anon:agent1")
    expect(keyAgent2).toBe("anon:agent2")

    for (let i = 0; i < 10; i++) {
      expect(limiter.take(keyAgent1).allowed).toBe(true)
    }
    expect(limiter.take(keyAgent1).allowed).toBe(false)

    const allowed = limiter.take(keyAgent2)
    expect(allowed.allowed).toBe(true)
    expect(allowed.remaining).toBe(9)
  })
})
