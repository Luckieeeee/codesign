/**
 * Agent presence — a Yjs-synced "who's currently working on this canvas"
 * directory for HTTP-bridge agents.
 *
 * Why a Y.Map instead of Hocuspocus awareness?
 *   - The bridge talks to the doc through `openDirectConnection`, which
 *     does NOT participate in the awareness protocol. There's no clientID
 *     to attach awareness state to.
 *   - We DO want presence to broadcast to every connected browser the
 *     same way doc edits do — and a Y.Map already rides that pipeline,
 *     so we get fan-out for free without bolting a side channel onto
 *     Hocuspocus.
 *   - State survives reconnects: if an agent makes one request, then a
 *     browser refreshes mid-call, the entry is still there.
 *
 * Storage shape
 * -------------
 * Map name: `"agents:presence"` (`AGENTS_PRESENCE_KEY`).
 * Map<agentId, AgentPresenceEntry>.
 *
 * Each entry carries `lastSeenAt` (ms epoch). Browsers filter out entries
 * older than `STALE_AFTER_MS` so an agent that stopped sending requests
 * silently disappears from the collaborator list without requiring the
 * bridge to clean up — useful when a `curl`-driven agent dies between
 * requests with no shutdown hook.
 *
 * The bridge ALSO reaps entries older than `REAP_AFTER_MS` on every
 * write, so the map can't grow unbounded over the lifetime of a doc.
 */

import * as Y from "yjs"

import { assertJsonValue } from "./json-value"

export const AGENTS_PRESENCE_KEY = "agents:presence"

/** Browsers hide entries older than this (default: 60s). */
export const PRESENCE_STALE_AFTER_MS = 60_000

/** Bridge prunes entries older than this on every write (default: 10 min). */
export const PRESENCE_REAP_AFTER_MS = 10 * 60_000

export interface AgentPresenceEntry {
  /** `X-Agent-Id` value. Stable across requests from the same agent. */
  id: string
  /** Display name for the agent itself (e.g. "Claude Code"). */
  name: string
  /** Optional WorkOS user id of the human who spawned this agent. */
  ownerId?: string | null
  /** Optional display name of the spawning user, e.g. "Alice". */
  ownerName?: string | null
  /** Optional email of the spawning user. */
  ownerEmail?: string | null
  /** Hex colour swatch derived from the agent id (stable per agent). */
  color: string
  /** ms epoch — used for staleness filtering on the client. */
  lastSeenAt: number
  /** Optional run id from `X-Agent-Run-Id` so the inspector can show it. */
  runId?: string | null
}

/**
 * Deterministic hex colour for an agent id. Picks from a curated palette
 * tuned to coexist with the user-presence palette (warm → cool, all
 * `chip`-able on light/dark). Same agent id → same colour every time.
 */
const AGENT_COLORS = [
  "#0ea5e9", // sky-500
  "#8b5cf6", // violet-500
  "#22c55e", // green-500
  "#f97316", // orange-500
  "#ec4899", // pink-500
  "#14b8a6", // teal-500
  "#eab308", // yellow-500
  "#ef4444", // red-500
] as const

export function colorForAgent(agentId: string): string {
  let hash = 0
  for (let i = 0; i < agentId.length; i += 1) {
    hash = (hash * 31 + agentId.charCodeAt(i)) | 0
  }
  return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length] as string
}

/**
 * Read the agents-presence map from a `Y.Doc`. Always returns the same
 * Y.Map instance for a given doc (Yjs interns by name).
 */
export function getAgentsPresenceMap(
  doc: Y.Doc,
): Y.Map<AgentPresenceEntry> {
  return doc.getMap<AgentPresenceEntry>(AGENTS_PRESENCE_KEY)
}

/**
 * Touch (insert-or-update) the presence entry for an agent and reap any
 * entries older than `PRESENCE_REAP_AFTER_MS`.
 *
 * MUST be called inside a `Y.transact` (or `DirectConnection.transact`)
 * — we don't open a transaction here so callers can batch the touch
 * with their actual edit, producing a single broadcast.
 *
 * The `now` argument is injectable so tests can run deterministically.
 */
export function touchAgentPresence(
  doc: Y.Doc,
  entry: Omit<AgentPresenceEntry, "color" | "lastSeenAt"> & {
    color?: string
    lastSeenAt?: number
  },
  now: number = Date.now(),
): AgentPresenceEntry {
  const map = getAgentsPresenceMap(doc)

  const next: AgentPresenceEntry = {
    id: entry.id,
    name: entry.name,
    ownerId: entry.ownerId ?? null,
    ownerName: entry.ownerName ?? null,
    ownerEmail: entry.ownerEmail ?? null,
    color: entry.color ?? colorForAgent(entry.id),
    lastSeenAt: entry.lastSeenAt ?? now,
    runId: entry.runId ?? null,
  }

  // Defensive validation: presence entries fan out to every browser, and
  // a malformed value (Date / NaN / cycle) would corrupt the doc for
  // every connected client. The bridge already validates op `data` via
  // `assertJsonValue`, but presence is written from headers we control,
  // so this is belt-and-braces.
  assertJsonValue(next, "$.presence")

  map.set(entry.id, next)

  // Reap entries older than the cap. Bounded loop — the cap is generous
  // enough (10 min) that under normal traffic this finds nothing.
  const cutoff = now - PRESENCE_REAP_AFTER_MS
  const stale: string[] = []
  map.forEach((value, key) => {
    if (value.lastSeenAt < cutoff) stale.push(key)
  })
  for (const key of stale) map.delete(key)

  return next
}

/**
 * Snapshot every non-stale presence entry from the map. `now` is
 * injectable for tests.
 */
export function listLivePresence(
  doc: Y.Doc,
  now: number = Date.now(),
): AgentPresenceEntry[] {
  const map = getAgentsPresenceMap(doc)
  const cutoff = now - PRESENCE_STALE_AFTER_MS
  const out: AgentPresenceEntry[] = []
  map.forEach((value) => {
    if (value.lastSeenAt >= cutoff) out.push(value)
  })
  return out
}

/**
 * Best-effort "agent is shutting down" hook. Optional — agents typically
 * just stop sending requests and the staleness window covers it. Used
 * by graceful-shutdown paths to make the agent disappear immediately
 * instead of hanging in the collaborator list for ~60s.
 */
export function clearAgentPresence(doc: Y.Doc, agentId: string): void {
  const map = getAgentsPresenceMap(doc)
  if (map.has(agentId)) map.delete(agentId)
}
