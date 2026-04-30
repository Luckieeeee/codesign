import { describe, expect, test } from "bun:test"
import * as Y from "yjs"

import {
  AGENTS_PRESENCE_KEY,
  PRESENCE_REAP_AFTER_MS,
  PRESENCE_STALE_AFTER_MS,
  clearAgentPresence,
  colorForAgent,
  getAgentsPresenceMap,
  listLivePresence,
  touchAgentPresence,
} from "../agent-presence"

describe("colorForAgent", () => {
  test("is deterministic per agent id", () => {
    expect(colorForAgent("claude")).toBe(colorForAgent("claude"))
    expect(colorForAgent("codex")).toBe(colorForAgent("codex"))
  })

  test("returns a valid hex string from the palette", () => {
    const color = colorForAgent("anything")
    expect(color).toMatch(/^#[0-9a-f]{6}$/)
  })
})

describe("touchAgentPresence", () => {
  test("inserts a new entry with derived color and lastSeenAt", () => {
    const doc = new Y.Doc()
    const now = 1_700_000_000_000
    doc.transact(() => {
      touchAgentPresence(
        doc,
        { id: "claude", name: "Claude", ownerName: "Alice" },
        now,
      )
    })
    const map = getAgentsPresenceMap(doc)
    const entry = map.get("claude")
    expect(entry).toBeDefined()
    expect(entry!.id).toBe("claude")
    expect(entry!.name).toBe("Claude")
    expect(entry!.ownerName).toBe("Alice")
    expect(entry!.ownerId).toBeNull()
    expect(entry!.ownerEmail).toBeNull()
    expect(entry!.color).toBe(colorForAgent("claude"))
    expect(entry!.lastSeenAt).toBe(now)
  })

  test("re-touch overwrites lastSeenAt", () => {
    const doc = new Y.Doc()
    doc.transact(() => {
      touchAgentPresence(doc, { id: "claude", name: "Claude" }, 1_000)
      touchAgentPresence(doc, { id: "claude", name: "Claude" }, 2_000)
    })
    expect(getAgentsPresenceMap(doc).get("claude")!.lastSeenAt).toBe(2_000)
  })

  test("reaps entries older than PRESENCE_REAP_AFTER_MS on every write", () => {
    const doc = new Y.Doc()
    const map = getAgentsPresenceMap(doc)
    const t0 = 1_000_000

    // Seed an old entry directly so we can assert it gets reaped.
    doc.transact(() => {
      map.set("ancient", {
        id: "ancient",
        name: "Ancient",
        color: "#000000",
        lastSeenAt: t0 - PRESENCE_REAP_AFTER_MS - 1, // just past the cutoff
        ownerId: null,
        ownerName: null,
        ownerEmail: null,
        runId: null,
      })
    })
    expect(map.has("ancient")).toBe(true)

    doc.transact(() => {
      touchAgentPresence(doc, { id: "fresh", name: "Fresh" }, t0)
    })

    expect(map.has("ancient")).toBe(false)
    expect(map.has("fresh")).toBe(true)
  })

  test("rejects malformed presence values via assertJsonValue", () => {
    const doc = new Y.Doc()
    expect(() => {
      doc.transact(() => {
        // @ts-expect-error — exercising the runtime validator with a bad value
        touchAgentPresence(doc, { id: "x", name: new Date() })
      })
    }).toThrow()
  })
})

describe("listLivePresence", () => {
  test("returns only entries within the stale window", () => {
    const doc = new Y.Doc()
    const map = getAgentsPresenceMap(doc)
    const now = 5_000_000

    doc.transact(() => {
      // Stale — older than PRESENCE_STALE_AFTER_MS
      map.set("stale", {
        id: "stale",
        name: "Stale",
        color: "#000",
        lastSeenAt: now - PRESENCE_STALE_AFTER_MS - 1,
        ownerId: null,
        ownerName: null,
        ownerEmail: null,
        runId: null,
      })
      // Fresh
      touchAgentPresence(doc, { id: "fresh", name: "Fresh" }, now)
    })

    const live = listLivePresence(doc, now)
    expect(live.map((e) => e.id)).toEqual(["fresh"])
  })

  test("returns empty array when map is empty", () => {
    const doc = new Y.Doc()
    expect(listLivePresence(doc)).toEqual([])
  })
})

describe("clearAgentPresence", () => {
  test("removes the entry by id", () => {
    const doc = new Y.Doc()
    doc.transact(() => {
      touchAgentPresence(doc, { id: "claude", name: "Claude" })
    })
    expect(getAgentsPresenceMap(doc).has("claude")).toBe(true)

    doc.transact(() => clearAgentPresence(doc, "claude"))
    expect(getAgentsPresenceMap(doc).has("claude")).toBe(false)
  })

  test("is a no-op for unknown ids", () => {
    const doc = new Y.Doc()
    expect(() =>
      doc.transact(() => clearAgentPresence(doc, "nope")),
    ).not.toThrow()
  })
})

describe("AGENTS_PRESENCE_KEY", () => {
  test("getAgentsPresenceMap always returns the same Y.Map for a given doc", () => {
    const doc = new Y.Doc()
    expect(getAgentsPresenceMap(doc)).toBe(getAgentsPresenceMap(doc))
    expect(getAgentsPresenceMap(doc)).toBe(doc.getMap(AGENTS_PRESENCE_KEY))
  })
})
