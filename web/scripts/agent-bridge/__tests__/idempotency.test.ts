import { describe, expect, test } from "bun:test"

import {
  createIdempotencyCache,
  hashRequestBody,
} from "../idempotency"

describe("createIdempotencyCache", () => {
  test("round-trips a stored entry exactly", () => {
    const cache = createIdempotencyCache()
    cache.set("p", "a", "k1", "h1", 200, { x: 1 })

    const got = cache.get("p", "a", "k1")
    expect(got).toBeDefined()
    expect(got?.bodyHash).toBe("h1")
    expect(got?.status).toBe(200)
    expect((got?.response as { x: number }).x).toBe(1)
  })

  test("isolates entries by agentId", () => {
    const cache = createIdempotencyCache()
    cache.set("p", "a", "k1", "h1", 200, { x: 1 })
    expect(cache.get("p", "a2", "k1")).toBeUndefined()
  })

  test("isolates entries by projectId", () => {
    const cache = createIdempotencyCache()
    cache.set("p", "a", "k1", "h1", 200, { x: 1 })
    expect(cache.get("p2", "a", "k1")).toBeUndefined()
  })

  test("isolates entries by key", () => {
    const cache = createIdempotencyCache()
    cache.set("p", "a", "k1", "h1", 200, { x: 1 })
    expect(cache.get("p", "a", "other-key")).toBeUndefined()
  })

  test("evicts entries past their TTL on access", () => {
    const fakeNow = { value: 0 }
    const cache = createIdempotencyCache({
      ttlMs: 100,
      now: () => fakeNow.value,
    })

    cache.set("p", "a", "k1", "h1", 200, { x: 1 })

    fakeNow.value = 99
    expect(cache.get("p", "a", "k1")).toBeDefined()

    fakeNow.value = 101
    expect(cache.get("p", "a", "k1")).toBeUndefined()
    expect(cache.size()).toBe(0)
  })

  test("evicts least-recently-used entry once maxEntries is exceeded", () => {
    const cache = createIdempotencyCache({ maxEntries: 3 })

    cache.set("p", "a", "k1", "h1", 200, { n: 1 })
    cache.set("p", "a", "k2", "h2", 200, { n: 2 })
    cache.set("p", "a", "k3", "h3", 200, { n: 3 })

    // Bump k1 to MRU; k2 is now the LRU.
    expect(cache.get("p", "a", "k1")).toBeDefined()

    cache.set("p", "a", "k4", "h4", 200, { n: 4 })

    expect(cache.get("p", "a", "k2")).toBeUndefined()
    expect(cache.get("p", "a", "k1")).toBeDefined()
    expect(cache.get("p", "a", "k3")).toBeDefined()
    expect(cache.get("p", "a", "k4")).toBeDefined()
  })

  test("size() reflects the current entry count and drops on lazy expiry", () => {
    const fakeNow = { value: 0 }
    const cache = createIdempotencyCache({
      ttlMs: 100,
      now: () => fakeNow.value,
    })

    cache.set("p", "a", "k1", "h1", 200, { n: 1 })
    cache.set("p", "a", "k2", "h2", 200, { n: 2 })
    expect(cache.size()).toBe(2)

    fakeNow.value = 101
    expect(cache.get("p", "a", "k1")).toBeUndefined()
    expect(cache.size()).toBe(1)
  })

  test("clear() empties the cache", () => {
    const cache = createIdempotencyCache()
    cache.set("p", "a", "k1", "h1", 200, { n: 1 })
    cache.set("p", "a", "k2", "h2", 200, { n: 2 })
    cache.set("p", "a", "k3", "h3", 200, { n: 3 })

    cache.clear()

    expect(cache.size()).toBe(0)
    expect(cache.get("p", "a", "k1")).toBeUndefined()
    expect(cache.get("p", "a", "k2")).toBeUndefined()
    expect(cache.get("p", "a", "k3")).toBeUndefined()
  })
})

describe("hashRequestBody", () => {
  test("is deterministic for the same input", () => {
    expect(hashRequestBody({ a: 1, b: 2 })).toBe(
      hashRequestBody({ a: 1, b: 2 }),
    )
  })

  test("is independent of object key order", () => {
    expect(hashRequestBody({ a: 1, b: 2 })).toBe(
      hashRequestBody({ b: 2, a: 1 }),
    )
  })

  test("preserves array order (arrays are ordered)", () => {
    expect(hashRequestBody([1, 2, 3])).not.toBe(hashRequestBody([3, 2, 1]))
  })

  test("produces different hashes for different values", () => {
    expect(hashRequestBody({ a: 1 })).not.toBe(hashRequestBody({ a: 2 }))
  })

  test("is independent of nested object key order", () => {
    expect(hashRequestBody({ a: { x: 1, y: 2 } })).toBe(
      hashRequestBody({ a: { y: 2, x: 1 } }),
    )
  })

  test("returns a 16-hex-character string", () => {
    expect(hashRequestBody({})).toMatch(/^[0-9a-f]{16}$/)
  })
})
