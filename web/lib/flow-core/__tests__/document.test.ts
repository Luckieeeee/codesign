/**
 * Lifecycle tests for the warm DirectConnection cache in `document.ts`.
 *
 * Covers cache hit, multi-id distinctness, idle-TTL eviction (with an
 * injected `now`), LRU eviction at `maxSize`, `closeAllCachedConnections`
 * (including idempotency), and shared in-flight promise semantics.
 *
 * No real time is used — TTL behavior is driven by a `fakeNow` injected
 * via `configureDocumentCache({ now })`.
 */

import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test"

import { Database } from "@hocuspocus/extension-database"
import { Hocuspocus } from "@hocuspocus/server"

import {
  _resetDocumentCacheForTesting,
  closeAllCachedConnections,
  configureDocumentCache,
  openProjectDoc,
} from "../document"

function createTestHocuspocus(): Hocuspocus {
  return new Hocuspocus({
    name: "test",
    extensions: [
      new Database({
        fetch: async () => null,
        store: async () => {},
      }),
    ],
  })
}

const hp = createTestHocuspocus()

beforeEach(() => {
  _resetDocumentCacheForTesting()
})

afterAll(async () => {
  await closeAllCachedConnections()
})

describe("document cache", () => {
  test("cache hit: same projectId returns the same DirectConnection ref", async () => {
    const c1 = await openProjectDoc(hp, "p1")
    const c2 = await openProjectDoc(hp, "p1")
    expect(c1).toBe(c2)
  })

  test("different projectIds return distinct DirectConnections", async () => {
    const a = await openProjectDoc(hp, "a")
    const b = await openProjectDoc(hp, "b")
    expect(a).not.toBe(b)
  })

  test("idle TTL eviction calls disconnect() and forgets the entry", async () => {
    const fakeNow = { value: 0 }
    configureDocumentCache({ idleTtlMs: 100, now: () => fakeNow.value })

    const conn1 = await openProjectDoc(hp, "p1")
    const disconnectSpy = spyOn(conn1, "disconnect")

    // Advance past the TTL window relative to conn1.lastUsed (= 0).
    fakeNow.value = 200

    // Any other openProjectDoc call triggers reapExpired() at the top.
    await openProjectDoc(hp, "p2")

    // reapExpired fires conn.disconnect() but does NOT await it. Yield
    // a microtask + tick so the .then chain settles before we assert.
    await new Promise((r) => setTimeout(r, 10))

    expect(disconnectSpy).toHaveBeenCalled()

    // And the entry must be gone — re-opening "p1" returns a new ref.
    const conn1Again = await openProjectDoc(hp, "p1")
    expect(conn1Again).not.toBe(conn1)
  })

  test("LRU eviction at maxSize disconnects the least-recently-used entry", async () => {
    const fakeNow = { value: 0 }
    configureDocumentCache({
      maxSize: 2,
      idleTtlMs: 1_000_000,
      now: () => fakeNow.value,
    })

    fakeNow.value = 1
    const a = await openProjectDoc(hp, "a")
    fakeNow.value = 2
    const b = await openProjectDoc(hp, "b")
    // Touch "a" so its lastUsed > b's, making "b" the LRU.
    fakeNow.value = 3
    await openProjectDoc(hp, "a")

    const bDisconnectSpy = spyOn(b, "disconnect")

    fakeNow.value = 4
    // Triggers eviction of the LRU entry ("b") before adding "c".
    await openProjectDoc(hp, "c")

    expect(bDisconnectSpy).toHaveBeenCalled()

    // Sanity: "a" was the most recently used and survived in cache.
    expect(await openProjectDoc(hp, "a")).toBe(a)

    // "b" was evicted — re-opening returns a fresh DirectConnection.
    // (Note: this open also evicts "c" since the cache is again at
    // maxSize, so we check "b" identity *before* re-touching anyone.)
    fakeNow.value = 5
    const bAgain = await openProjectDoc(hp, "b")
    expect(bAgain).not.toBe(b)
  })

  test("closeAllCachedConnections() disconnects every cached entry and empties the cache", async () => {
    const a = await openProjectDoc(hp, "a")
    const b = await openProjectDoc(hp, "b")
    const c = await openProjectDoc(hp, "c")

    const aSpy = spyOn(a, "disconnect")
    const bSpy = spyOn(b, "disconnect")
    const cSpy = spyOn(c, "disconnect")

    await closeAllCachedConnections()

    expect(aSpy).toHaveBeenCalledTimes(1)
    expect(bSpy).toHaveBeenCalledTimes(1)
    expect(cSpy).toHaveBeenCalledTimes(1)

    // Cache was emptied — re-opening any id returns a brand-new connection.
    const aFresh = await openProjectDoc(hp, "a")
    expect(aFresh).not.toBe(a)
  })

  test("closeAllCachedConnections() is idempotent", async () => {
    const a = await openProjectDoc(hp, "a")
    const aSpy = spyOn(a, "disconnect")

    await closeAllCachedConnections()
    // Second call resolves cleanly without re-disconnecting.
    await expect(closeAllCachedConnections()).resolves.toBeUndefined()

    expect(aSpy).toHaveBeenCalledTimes(1)
  })

  test("concurrent openProjectDoc calls share the same in-flight connection", async () => {
    const [c1, c2, c3] = await Promise.all([
      openProjectDoc(hp, "x"),
      openProjectDoc(hp, "x"),
      openProjectDoc(hp, "x"),
    ])
    expect(c1).toBe(c2)
    expect(c2).toBe(c3)
  })
})
