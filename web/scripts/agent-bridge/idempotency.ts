/**
 * Idempotency cache for the agent bridge.
 *
 * TTL'd LRU keyed by `(projectId, agentId, key)`. Stores the original
 * response body + status alongside a hash of the request body so the
 * caller can detect "same key, different body" reuse and reject it.
 *
 * Adapted from anthill/collab/src/idempotency.ts. The body-hash uses
 * FNV-1a-64 over a canonical (sorted-key) JSON serialisation — same
 * algorithm as `fnv1a64Hex` in `web/scripts/spike-direct-conn.ts`. A
 * future shared util can dedupe the FNV implementation.
 */

export interface IdempotencyEntry {
  bodyHash: string
  status: number
  /** JSON-serialisable response body. */
  response: unknown
}

export interface IdempotencyCacheConfig {
  ttlMs?: number
  maxEntries?: number
  now?: () => number
}

export interface IdempotencyCache {
  /** Look up; returns undefined if not present or expired. */
  get(
    projectId: string,
    agentId: string,
    key: string,
  ): IdempotencyEntry | undefined
  /** Store. Hashes body internally — call sites pass the parsed/serialised body. */
  set(
    projectId: string,
    agentId: string,
    key: string,
    bodyHash: string,
    status: number,
    response: unknown,
  ): void
  /** Test helper. */
  clear(): void
  /** Test helper. */
  size(): number
}

interface StoredEntry {
  entry: IdempotencyEntry
  expiresAt: number
}

const DEFAULT_TTL_MS = 15 * 60 * 1000
const DEFAULT_MAX_ENTRIES = 5_000

function makeKey(projectId: string, agentId: string, key: string): string {
  return `${projectId}|${agentId}|${key}`
}

export function createIdempotencyCache(
  config: IdempotencyCacheConfig = {},
): IdempotencyCache {
  const ttlMs = config.ttlMs ?? DEFAULT_TTL_MS
  const maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES
  const now = config.now ?? (() => Date.now())

  const store = new Map<string, StoredEntry>()

  function evictOldest(): void {
    const oldest = store.keys().next()
    if (!oldest.done) {
      store.delete(oldest.value)
    }
  }

  return {
    get(projectId, agentId, key) {
      const k = makeKey(projectId, agentId, key)
      const stored = store.get(k)
      if (!stored) return undefined
      if (now() >= stored.expiresAt) {
        store.delete(k)
        return undefined
      }
      // LRU bump: re-insert to push to back of insertion order.
      store.delete(k)
      store.set(k, stored)
      return stored.entry
    },

    set(projectId, agentId, key, bodyHash, status, response) {
      const k = makeKey(projectId, agentId, key)
      // Re-inserting an existing key still needs to refresh insertion
      // order, so delete first.
      if (store.has(k)) {
        store.delete(k)
      }
      while (store.size >= maxEntries) {
        evictOldest()
      }
      store.set(k, {
        entry: { bodyHash, status, response },
        expiresAt: now() + ttlMs,
      })
    },

    clear() {
      store.clear()
    },

    size() {
      return store.size
    },
  }
}

/**
 * Stable hash for a request body. Sorts object keys recursively, then
 * FNV-1a-64 hex over the resulting JSON string. Arrays preserve order;
 * primitives stringify as-is.
 *
 * NOTE: copied from `web/scripts/spike-direct-conn.ts` — do not import
 * from the spike. A future shared util can dedupe.
 */
export function hashRequestBody(body: unknown): string {
  const json = JSON.stringify(body, sortKeysReplacer) ?? "null"
  const bytes = new TextEncoder().encode(json)
  return fnv1a64Hex(bytes)
}

function sortKeysReplacer(_key: string, value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  ) {
    const src = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(src).sort()) {
      sorted[k] = src[k]
    }
    return sorted
  }
  return value
}

function fnv1a64Hex(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5 >>> 0
  let h2 = 0x9dc5811c >>> 0
  for (const b of bytes) {
    h1 ^= b
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 ^= b
    h2 = Math.imul(h2, 0x01000193) >>> 0
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")
}
