/**
 * The centrepiece test for the agent bridge: validates that
 * `applyEdit` is the load-bearing safety boundary the design promises.
 *
 * Critical invariants (see `docs/agent-bridge-plan.md` § "Edit
 * operations" and the Testing Strategy bullets for `operations.test.ts`):
 *   - On validation failure, ZERO live `Y.Map` writes happen and ZERO
 *     update events are broadcast (the "no partial writes" guarantee
 *     that replaces the abandoned UndoManager rollback approach).
 *   - On success, the entire batch commits in ONE Yjs update event
 *     (proves we use a single `conn.transact` for the whole batch).
 *   - The stale-revision guard fires BEFORE per-op validation so a
 *     stale agent never sees a misleading `NODE_NOT_FOUND`.
 *   - `data.__codesign` provenance is stamped on every created /
 *     updated entity without clobbering caller fields.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import { Database } from "@hocuspocus/extension-database"
import { Hocuspocus, type DirectConnection } from "@hocuspocus/server"
import type { Edge, Node } from "@xyflow/react"
import type * as Y from "yjs"

import {
  _resetDocumentCacheForTesting,
  closeAllCachedConnections,
  openProjectDoc,
} from "../document"
import { AgentError } from "../errors"
import { getEdgesMap, getNodesMap } from "../graph"
import { applyEdit } from "../operations"
import { computeRevision } from "../revision"
import type { AgentIdentity, EditOp } from "../types"

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const identity: AgentIdentity = { id: "ai:test-agent", runId: "run-1" }

let hp: Hocuspocus

beforeAll(() => {
  // Bare `new Hocuspocus()` (no `.listen()`) is enough — `openDirectConnection`
  // does not require a listening port. Confirmed in `scripts/spike-direct-conn.ts`.
  hp = new Hocuspocus({
    name: "operations-test",
    extensions: [
      new Database({
        fetch: async () => null,
        store: async () => {},
      }),
    ],
  })
})

beforeEach(() => {
  _resetDocumentCacheForTesting()
})

afterAll(async () => {
  await closeAllCachedConnections()
})

/**
 * Hocuspocus's exported `DirectConnection` interface declares only
 * `transact` and `disconnect`. The implementation class (returned by
 * `openDirectConnection`) also exposes `.document: Y.Doc`. We cast
 * locally to read it for revision/Y.Map assertions.
 */
type DirectConn = DirectConnection & { document: Y.Doc }

/** Per-test unique doc id so the warm cache + Hocuspocus document map don't bleed. */
function freshPid(): string {
  return "proj-" + crypto.randomUUID()
}

async function openConn(pid: string): Promise<DirectConn> {
  return (await openProjectDoc(hp, pid)) as DirectConn
}

async function openSibling(pid: string): Promise<DirectConn> {
  return (await hp.openDirectConnection(pid, {})) as unknown as DirectConn
}

async function expectAgentError(
  fn: () => Promise<unknown>,
  code: string,
): Promise<AgentError> {
  try {
    await fn()
  } catch (err) {
    if (!(err instanceof AgentError)) throw err
    expect(err.code as string).toBe(code)
    return err
  }
  throw new Error(`expected applyEdit to throw AgentError(${code})`)
}

/** Synchronously seed nodes/edges into the live Y.Maps via the conn's transact. */
async function seed(
  conn: DirectConn,
  nodes: Node[] = [],
  edges: Edge[] = [],
): Promise<void> {
  await conn.transact((doc) => {
    const nm = getNodesMap(doc)
    const em = getEdgesMap(doc)
    for (const n of nodes) nm.set(n.id, n)
    for (const e of edges) em.set(e.id, e)
  })
}

function liveNodes(conn: DirectConn): Map<string, Node> {
  const nm = getNodesMap(conn.document)
  const out = new Map<string, Node>()
  for (const id of nm.keys()) {
    const v = nm.get(id)
    if (v) out.set(id, v)
  }
  return out
}

function liveEdges(conn: DirectConn): Map<string, Edge> {
  const em = getEdgesMap(conn.document)
  const out = new Map<string, Edge>()
  for (const id of em.keys()) {
    const v = em.get(id)
    if (v) out.set(id, v)
  }
  return out
}

function makeNode(id: string, data: Record<string, unknown> = {}): Node {
  return { id, position: { x: 0, y: 0 }, data }
}

function makeEdge(
  id: string,
  source: string,
  target: string,
  data?: Record<string, unknown>,
): Edge {
  return data === undefined
    ? { id, source, target }
    : { id, source, target, data }
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe("applyEdit — happy paths", () => {
  test("addNode with explicit id: applied=1, created.nodes:['n1'], revision bumps, provenance stamped", async () => {
    const conn = await openConn(freshPid())
    const revBefore = computeRevision(conn.document)

    const ops: EditOp[] = [
      {
        op: "addNode",
        node: { id: "n1", position: { x: 0, y: 0 }, data: { label: "A" } },
      },
    ]
    const res = await applyEdit(conn, ops, identity)

    expect(res.applied).toBe(1)
    expect(res.created.nodes).toEqual(["n1"])
    expect(res.created.edges).toEqual([])
    expect(res.deleted.nodes).toEqual([])
    expect(res.cascadedEdges).toEqual([])
    expect(res.revision).not.toBe(revBefore)
    expect(res.revision).toBe(computeRevision(conn.document))

    const nodes = liveNodes(conn)
    expect(nodes.size).toBe(1)
    const n1 = nodes.get("n1")!
    expect(n1.data!.label).toBe("A")
    const stamp = (n1.data as { __codesign?: { author: string; runId: string | null; at: string } }).__codesign
    expect(stamp).toBeDefined()
    expect(stamp!.author).toBe("ai:test-agent")
    expect(stamp!.runId).toBe("run-1")
    expect(typeof stamp!.at).toBe("string")
  })

  test("addNode mints id when missing — matches /^n-[0-9a-f]{8}$/", async () => {
    const conn = await openConn(freshPid())

    const res = await applyEdit(
      conn,
      [{ op: "addNode", node: { position: { x: 0, y: 0 }, data: {} } }],
      identity,
    )
    expect(res.created.nodes).toHaveLength(1)
    const minted = res.created.nodes[0]!
    expect(minted).toMatch(/^n-[0-9a-f]{8}$/)

    const nodes = liveNodes(conn)
    expect(nodes.has(minted)).toBe(true)
  })

  test("updateNode shallow-merges data — color preserved", async () => {
    const conn = await openConn(freshPid())
    await seed(conn, [makeNode("n1", { label: "A", color: "red" })])

    await applyEdit(
      conn,
      [{ op: "updateNode", id: "n1", patch: { data: { label: "B" } } }],
      identity,
    )

    const n1 = liveNodes(conn).get("n1")!
    expect(n1.data!.label).toBe("B")
    expect(n1.data!.color).toBe("red")
    expect(
      (n1.data as { __codesign?: unknown }).__codesign,
    ).toBeDefined()
  })

  test("deleteNode with default cascade removes touching edges", async () => {
    const conn = await openConn(freshPid())
    await seed(
      conn,
      [makeNode("n1"), makeNode("n2")],
      [makeEdge("e1-2", "n1", "n2")],
    )

    const res = await applyEdit(
      conn,
      [{ op: "deleteNode", id: "n1", cascadeEdges: true }],
      identity,
    )

    expect(res.deleted.nodes).toEqual(["n1"])
    expect(res.cascadedEdges).toEqual(["e1-2"])

    const nodes = liveNodes(conn)
    const edges = liveEdges(conn)
    expect(nodes.has("n1")).toBe(false)
    expect(nodes.has("n2")).toBe(true)
    expect(edges.has("e1-2")).toBe(false)
  })

  test("addEdge with explicit id stamps provenance", async () => {
    const conn = await openConn(freshPid())
    await seed(conn, [makeNode("n1"), makeNode("n2")])

    const res = await applyEdit(
      conn,
      [{ op: "addEdge", edge: { id: "e1", source: "n1", target: "n2" } }],
      identity,
    )

    expect(res.created.edges).toEqual(["e1"])
    const e1 = liveEdges(conn).get("e1")!
    expect(e1.source).toBe("n1")
    expect(e1.target).toBe("n2")
    expect(
      (e1.data as { __codesign?: unknown } | undefined)?.__codesign,
    ).toBeDefined()
  })

  test("addEdge mints id matching /^e-n1-n2-[0-9a-f]{6}$/", async () => {
    const conn = await openConn(freshPid())
    await seed(conn, [makeNode("n1"), makeNode("n2")])

    const res = await applyEdit(
      conn,
      [{ op: "addEdge", edge: { source: "n1", target: "n2" } }],
      identity,
    )
    expect(res.created.edges).toHaveLength(1)
    expect(res.created.edges[0]).toMatch(/^e-n1-n2-[0-9a-f]{6}$/)
  })

  test("updateEdge shallow-merges data — color preserved", async () => {
    const conn = await openConn(freshPid())
    await seed(
      conn,
      [makeNode("n1"), makeNode("n2")],
      [makeEdge("e1", "n1", "n2", { weight: 1, color: "red" })],
    )

    await applyEdit(
      conn,
      [{ op: "updateEdge", id: "e1", patch: { data: { weight: 2 } } }],
      identity,
    )

    const e1 = liveEdges(conn).get("e1")!
    expect(e1.data!.weight).toBe(2)
    expect(e1.data!.color).toBe("red")
    expect(
      (e1.data as { __codesign?: unknown }).__codesign,
    ).toBeDefined()
  })

  test("updateEdge source/target change validates the new endpoint exists", async () => {
    const conn = await openConn(freshPid())
    await seed(
      conn,
      [makeNode("n1"), makeNode("n2"), makeNode("n3")],
      [makeEdge("e1", "n1", "n2")],
    )

    // Switching source to existing n3 succeeds.
    await applyEdit(
      conn,
      [{ op: "updateEdge", id: "e1", patch: { source: "n3" } }],
      identity,
    )
    expect(liveEdges(conn).get("e1")!.source).toBe("n3")

    // Switching target to a missing node throws EDGE_REFERENCES_MISSING_NODE.
    await expectAgentError(
      () =>
        applyEdit(
          conn,
          [{ op: "updateEdge", id: "e1", patch: { target: "missing" } }],
          identity,
        ),
      "EDGE_REFERENCES_MISSING_NODE",
    )
  })

  test("deleteEdge removes the live entry", async () => {
    const conn = await openConn(freshPid())
    await seed(
      conn,
      [makeNode("n1"), makeNode("n2")],
      [makeEdge("e1", "n1", "n2")],
    )

    await applyEdit(conn, [{ op: "deleteEdge", id: "e1" }], identity)
    expect(liveEdges(conn).size).toBe(0)
  })

  test("multi-op batch produces EXACTLY ONE Yjs update event (single broadcast)", async () => {
    const pid = freshPid()
    const conn = await openConn(pid)
    await seed(conn, [makeNode("n1"), makeNode("n2")])

    // Sibling DirectConnection on the same document — its `.document`
    // resolves to the same Y.Doc, so `update` events fire there too.
    const sibling = await openSibling(pid)
    let updateCount = 0
    const listener = () => {
      updateCount++
    }
    sibling.document.on("update", listener)
    // Let Hocuspocus settle the observer registration.
    await new Promise((r) => setTimeout(r, 50))

    await applyEdit(
      conn,
      [
        { op: "addNode", node: { id: "n3", position: { x: 0, y: 0 }, data: {} } },
        { op: "addEdge", edge: { id: "e2-3", source: "n2", target: "n3" } },
        { op: "updateNode", id: "n1", patch: { data: { label: "A" } } },
      ],
      identity,
    )

    await new Promise((r) => setTimeout(r, 50))
    sibling.document.off("update", listener)
    await sibling.disconnect()

    expect(updateCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Validation-fail paths — the load-bearing assertions
// ---------------------------------------------------------------------------

describe("applyEdit — validation-fail paths (no-partial-writes)", () => {
  test("no partial writes when a later op fails ref validation", async () => {
    const conn = await openConn(freshPid())
    const revBefore = computeRevision(conn.document)

    await expectAgentError(
      () =>
        applyEdit(
          conn,
          [
            { op: "addNode", node: { id: "n1", position: { x: 0, y: 0 }, data: {} } },
            { op: "addEdge", edge: { id: "e1", source: "n1", target: "missing" } },
          ],
          identity,
        ),
      "EDGE_REFERENCES_MISSING_NODE",
    )

    expect(getNodesMap(conn.document).size).toBe(0)
    expect(getEdgesMap(conn.document).size).toBe(0)
    expect(computeRevision(conn.document)).toBe(revBefore)
  })

  test("zero broadcasts on validation fail (sibling observer never fires)", async () => {
    const pid = freshPid()
    const conn = await openConn(pid)

    const sibling = await openSibling(pid)
    let updateCount = 0
    const listener = () => {
      updateCount++
    }
    sibling.document.on("update", listener)
    await new Promise((r) => setTimeout(r, 50))

    await expectAgentError(
      () =>
        applyEdit(
          conn,
          [
            { op: "addNode", node: { id: "n1", position: { x: 0, y: 0 }, data: {} } },
            { op: "addEdge", edge: { id: "e1", source: "n1", target: "missing" } },
          ],
          identity,
        ),
      "EDGE_REFERENCES_MISSING_NODE",
    )

    await new Promise((r) => setTimeout(r, 50))
    sibling.document.off("update", listener)
    await sibling.disconnect()

    expect(updateCount).toBe(0)
  })

  test("stale revision check fires BEFORE per-op validation", async () => {
    const conn = await openConn(freshPid())
    await seed(conn, [makeNode("n1")])
    const rev0 = computeRevision(conn.document)

    // Bump revision via a sibling write so rev0 is now stale.
    await conn.transact((doc) => {
      getNodesMap(doc).set("nx", makeNode("nx"))
    })
    expect(computeRevision(conn.document)).not.toBe(rev0)

    const err = await expectAgentError(
      () =>
        applyEdit(
          conn,
          [{ op: "deleteNode", id: "missing", cascadeEdges: true }],
          identity,
          { baseRevision: rev0 },
        ),
      "STALE_REVISION",
    )

    const details = err.details as {
      currentRevision: string
      baseRevision: string
      snapshot: { revision: string; nodes: Node[]; edges: Edge[] }
    }
    expect(details.baseRevision).toBe(rev0)
    expect(details.currentRevision).toBe(computeRevision(conn.document))
    expect(details.snapshot).toBeDefined()
    expect(details.snapshot.revision).toBe(details.currentRevision)
    expect(Array.isArray(details.snapshot.nodes)).toBe(true)
    expect(Array.isArray(details.snapshot.edges)).toBe(true)
    // Snapshot reflects the post-bump state (n1 + nx).
    const ids = new Set(details.snapshot.nodes.map((n) => n.id))
    expect(ids.has("n1")).toBe(true)
    expect(ids.has("nx")).toBe(true)
  })

  test("JSON-value pre-validation rejects NaN before any transact", async () => {
    const conn = await openConn(freshPid())
    const revBefore = computeRevision(conn.document)

    const err = await expectAgentError(
      () =>
        applyEdit(
          conn,
          [
            {
              op: "addNode",
              node: { position: { x: 0, y: 0 }, data: { bad: NaN } },
            },
          ],
          identity,
        ),
      "BAD_REQUEST",
    )
    const path = (err.details as { path?: string }).path
    expect(path).toContain("data.bad")

    expect(computeRevision(conn.document)).toBe(revBefore)
    expect(getNodesMap(conn.document).size).toBe(0)
  })

  test("51-op batch is rejected with BAD_REQUEST and doc is unchanged", async () => {
    const conn = await openConn(freshPid())
    const revBefore = computeRevision(conn.document)

    const ops: EditOp[] = Array.from({ length: 51 }, (_, i) => ({
      op: "addNode",
      node: {
        id: `n${i}`,
        position: { x: i, y: i },
        data: {},
      },
    }))

    const err = await expectAgentError(
      () => applyEdit(conn, ops, identity),
      "BAD_REQUEST",
    )
    expect(err.message.toLowerCase()).toContain("max")

    expect(getNodesMap(conn.document).size).toBe(0)
    expect(computeRevision(conn.document)).toBe(revBefore)
  })
})

// ---------------------------------------------------------------------------
// Cascade and same-batch reference rules
// ---------------------------------------------------------------------------

describe("applyEdit — cascade and same-batch refs", () => {
  test("deleteNode with cascadeEdges:false and live edges throws EDGES_WOULD_BE_ORPHANED", async () => {
    const conn = await openConn(freshPid())
    await seed(
      conn,
      [makeNode("n1"), makeNode("n2")],
      [makeEdge("e1-2", "n1", "n2")],
    )
    const revBefore = computeRevision(conn.document)

    const err = await expectAgentError(
      () =>
        applyEdit(
          conn,
          [{ op: "deleteNode", id: "n1", cascadeEdges: false }],
          identity,
        ),
      "EDGES_WOULD_BE_ORPHANED",
    )
    const details = err.details as { nodeId: string; edgeIds: string[] }
    expect(details.nodeId).toBe("n1")
    expect(details.edgeIds).toContain("e1-2")

    // Doc unchanged.
    expect(getNodesMap(conn.document).size).toBe(2)
    expect(getEdgesMap(conn.document).size).toBe(1)
    expect(computeRevision(conn.document)).toBe(revBefore)
  })

  test("same-batch addNode (explicit id) + addEdge can reference the new node", async () => {
    const conn = await openConn(freshPid())

    const res = await applyEdit(
      conn,
      [
        { op: "addNode", node: { id: "n1", position: { x: 0, y: 0 }, data: {} } },
        { op: "addNode", node: { id: "n2", position: { x: 1, y: 1 }, data: {} } },
        { op: "addEdge", edge: { id: "e1-2", source: "n1", target: "n2" } },
      ],
      identity,
    )

    expect(res.created.nodes).toEqual(["n1", "n2"])
    expect(res.created.edges).toEqual(["e1-2"])
    expect(liveNodes(conn).size).toBe(2)
    expect(liveEdges(conn).size).toBe(1)
  })

  test("same-batch addEdge cannot reference a node id that doesn't exist (minted ids aren't predictable)", async () => {
    const conn = await openConn(freshPid())
    const revBefore = computeRevision(conn.document)

    await expectAgentError(
      () =>
        applyEdit(
          conn,
          [
            // mints some id like n-XXXXXXXX — caller can't predict it
            { op: "addNode", node: { position: { x: 0, y: 0 }, data: {} } },
            // referencing a guess for the minted id (or any other unknown id)
            // is rejected — projection lookup uses literal ids only.
            {
              op: "addEdge",
              edge: { source: "some-other-id", target: "some-other-id" },
            },
          ],
          identity,
        ),
      "EDGE_REFERENCES_MISSING_NODE",
    )

    // No partial writes — even the addNode that would have succeeded standalone is rolled back.
    expect(getNodesMap(conn.document).size).toBe(0)
    expect(computeRevision(conn.document)).toBe(revBefore)
  })
})

// ---------------------------------------------------------------------------
// Provenance + audit-behaviour deviations
// ---------------------------------------------------------------------------

describe("applyEdit — provenance + audit semantics", () => {
  test("provenance stamp shape: { author, runId, at: <ISO string> }", async () => {
    const conn = await openConn(freshPid())

    await applyEdit(
      conn,
      [{ op: "addNode", node: { id: "n1", position: { x: 0, y: 0 }, data: {} } }],
      identity,
    )

    const stamp = (
      liveNodes(conn).get("n1")!.data as {
        __codesign: { author: string; runId: string | null; at: string }
      }
    ).__codesign
    expect(stamp).toEqual({
      author: "ai:test-agent",
      runId: "run-1",
      at: expect.any(String),
    })
    const parsed = new Date(stamp.at)
    expect(Number.isNaN(parsed.getTime())).toBe(false)
    // Round-trip ISO check.
    expect(parsed.toISOString()).toBe(stamp.at)
  })

  test("provenance.runId is null when identity.runId is omitted", async () => {
    const conn = await openConn(freshPid())

    await applyEdit(
      conn,
      [{ op: "addNode", node: { id: "n1", position: { x: 0, y: 0 }, data: {} } }],
      { id: "ai:noerun" },
    )
    const stamp = (
      liveNodes(conn).get("n1")!.data as {
        __codesign: { runId: string | null }
      }
    ).__codesign
    expect(stamp.runId).toBeNull()
  })

  test("same-batch create-then-delete nets out — neither created nor deleted appears in the response", async () => {
    const conn = await openConn(freshPid())

    const res = await applyEdit(
      conn,
      [
        { op: "addNode", node: { id: "n1", position: { x: 0, y: 0 }, data: {} } },
        { op: "deleteNode", id: "n1", cascadeEdges: true },
      ],
      identity,
    )

    expect(res.created.nodes).not.toContain("n1")
    expect(res.deleted.nodes).not.toContain("n1")
    expect(liveNodes(conn).size).toBe(0)
  })
})
