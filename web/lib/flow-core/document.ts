/**
 * Warm DirectConnection cache for the agent-bridge.
 *
 * One cached `DirectConnection` per Hocuspocus document name (== Codesign
 * `projectId`). Entries are kept warm so successive HTTP edit requests
 * skip the `openDirectConnection` round-trip.
 *
 * Lifecycle (extends anthill's `withDoc` / `getWarmConnection`):
 *   - **Idle TTL**: entries unused for `idleTtlMs` are evicted on the next
 *     touch. Default 5 min. No `setInterval` — the reaper runs lazily on
 *     each `openProjectDoc` call to keep the lifecycle deterministic for
 *     tests.
 *   - **Max-size LRU**: when adding a new entry would push the cache past
 *     `maxSize`, the entry with the smallest `lastUsed` is evicted and
 *     its `.disconnect()` is awaited *before* the new entry is created
 *     (so we never briefly exceed the limit).
 *   - **Shutdown**: `closeAllCachedConnections()` snapshots and disconnects
 *     every entry in parallel. Idempotent — safe to call from both SIGINT
 *     and SIGTERM handlers.
 *
 * The cached value is `Promise<DirectConnection>` (not the resolved
 * connection) so concurrent callers for the same `projectId` share one
 * in-flight `openDirectConnection` call.
 */

import type { DirectConnection, Hocuspocus } from "@hocuspocus/server"

export interface DocumentCacheConfig {
  /** Eviction window since `lastUsed`. Default `5 * 60 * 1000` ms. */
  idleTtlMs?: number
  /** Max cached entries before LRU eviction kicks in. Default `100`. */
  maxSize?: number
  /** Time source. Override in tests. Defaults to `() => Date.now()`. */
  now?: () => number
}

interface CacheEntry {
  conn: Promise<DirectConnection>
  lastUsed: number
}

interface ResolvedConfig {
  idleTtlMs: number
  maxSize: number
  now: () => number
}

const DEFAULT_CONFIG: ResolvedConfig = {
  idleTtlMs: 5 * 60 * 1000,
  maxSize: 100,
  now: () => Date.now(),
}

const cache = new Map<string, CacheEntry>()
let config: ResolvedConfig = { ...DEFAULT_CONFIG }

/**
 * Returns a cached `DirectConnection` for `projectId`, opening one on
 * miss. Also stamps the entry's `lastUsed` to `now()` on every call
 * (touch-on-use). On miss + over-capacity, evicts the LRU entry and
 * awaits its disconnect first.
 */
export async function openProjectDoc(
  hocuspocus: Hocuspocus,
  projectId: string,
): Promise<DirectConnection> {
  reapExpired()

  const now = config.now()
  const existing = cache.get(projectId)
  if (existing) {
    existing.lastUsed = now
    return existing.conn
  }

  if (cache.size >= config.maxSize) {
    await evictLru()
  }

  const connPromise = hocuspocus.openDirectConnection(projectId, {})
  const entry: CacheEntry = { conn: connPromise, lastUsed: now }
  cache.set(projectId, entry)

  // If the open ever rejects, drop the entry so a subsequent caller can
  // retry instead of being stuck with a poisoned promise.
  connPromise.catch(() => {
    if (cache.get(projectId) === entry) {
      cache.delete(projectId)
    }
  })

  return connPromise
}

/**
 * Convenience wrapper: open + run `fn`. Does NOT auto-close — the warm
 * cache is meant to survive across requests.
 *
 * The Supabase project-existence check belongs in the route handler
 * (which owns the supabase client), not here. This module stays pure.
 */
export async function withProjectDoc<T>(
  hocuspocus: Hocuspocus,
  projectId: string,
  fn: (conn: DirectConnection) => Promise<T>,
): Promise<T> {
  const conn = await openProjectDoc(hocuspocus, projectId)
  return fn(conn)
}

/**
 * Disconnects every cached entry in parallel and empties the cache.
 * Snapshot-then-clear so re-entrant adds during shutdown can't loop.
 * Errors from individual `.disconnect()` calls are swallowed (logged) so
 * one bad connection can't block the rest.
 */
export async function closeAllCachedConnections(): Promise<void> {
  const snapshot = Array.from(cache.values())
  cache.clear()

  await Promise.all(
    snapshot.map((entry) =>
      entry.conn
        .then((conn) => conn.disconnect())
        .catch((err: unknown) => {
          console.error("[flow-core/document] disconnect during shutdown failed:", err)
        }),
    ),
  )
}

/**
 * Mutates the active config. Used by tests (e.g. `idleTtlMs: 1`).
 * Unspecified fields fall back to the previous value.
 */
export function configureDocumentCache(cfg: DocumentCacheConfig): void {
  config = {
    idleTtlMs: cfg.idleTtlMs ?? config.idleTtlMs,
    maxSize: cfg.maxSize ?? config.maxSize,
    now: cfg.now ?? config.now,
  }
}

/**
 * Test helper. Clears the cache **without** disconnecting — tests own the
 * Hocuspocus instance per worker and tear it down themselves. Also resets
 * config back to defaults.
 */
export function _resetDocumentCacheForTesting(): void {
  cache.clear()
  config = { ...DEFAULT_CONFIG }
}

function reapExpired(): void {
  const now = config.now()
  const ttl = config.idleTtlMs
  for (const [id, entry] of cache) {
    if (now - entry.lastUsed > ttl) {
      cache.delete(id)
      entry.conn
        .then((conn) => conn.disconnect())
        .catch((err: unknown) => {
          console.error(
            `[flow-core/document] disconnect during idle-TTL eviction of ${id} failed:`,
            err,
          )
        })
    }
  }
}

async function evictLru(): Promise<void> {
  let oldestId: string | null = null
  let oldestUsed = Number.POSITIVE_INFINITY
  for (const [id, entry] of cache) {
    if (entry.lastUsed < oldestUsed) {
      oldestUsed = entry.lastUsed
      oldestId = id
    }
  }
  if (oldestId === null) return

  const entry = cache.get(oldestId)
  if (!entry) return
  cache.delete(oldestId)

  try {
    const conn = await entry.conn
    await conn.disconnect()
  } catch (err) {
    console.error(
      `[flow-core/document] disconnect during LRU eviction of ${oldestId} failed:`,
      err,
    )
  }
}
