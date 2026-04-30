import { describe, expect, test } from "bun:test"
import type { Edge, Node } from "@xyflow/react"
import * as Y from "yjs"

import { getEdgesMap, getNodesMap } from "../graph"
import { neighborhood, state, summary } from "../snapshot"

function buildDoc(
  nodes: Array<Partial<Node>>,
  edges: Array<Partial<Edge>>,
): Y.Doc {
  const doc = new Y.Doc()
  const nm = getNodesMap(doc)
  const em = getEdgesMap(doc)
  for (const n of nodes) {
    nm.set(n.id!, {
      id: n.id!,
      position: { x: 0, y: 0 },
      data: {},
      ...n,
    } as Node)
  }
  for (const e of edges) {
    em.set(e.id!, {
      id: e.id!,
      source: e.source!,
      target: e.target!,
      ...e,
    } as Edge)
  }
  return doc
}

const opts = { projectId: "proj-test", hasLiveClients: false }

function nodeIds(s: { focal: { id: string }; neighbours: Array<{ id: string }> }): Set<string> {
  return new Set([s.focal.id, ...s.neighbours.map((n) => n.id)])
}

function edgeIds(s: { edges: Array<{ id: string }> }): Set<string> {
  return new Set(s.edges.map((e) => e.id))
}

describe("summary", () => {
  test("counts and revision are present and accurate", () => {
    const doc = buildDoc(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      [
        { id: "e1", source: "a", target: "b" },
        { id: "e2", source: "b", target: "c" },
      ],
    )
    const s = summary(doc, opts)
    expect(s.nodeCount).toBe(3)
    expect(s.edgeCount).toBe(2)
    expect(typeof s.revision).toBe("string")
    expect(s.revision.length).toBeGreaterThan(0)
  })

  test("per-node summary includes id, type, position, label preview but not full data", () => {
    const doc = buildDoc(
      [
        {
          id: "a",
          type: "thing",
          position: { x: 10, y: 20 },
          data: { label: "Hi", secret: "do not leak" },
        },
      ],
      [],
    )
    const s = summary(doc, opts)
    const row = s.nodes[0]!
    expect(row.id).toBe("a")
    expect(row.type).toBe("thing")
    expect(row.position).toEqual({ x: 10, y: 20 })
    expect(row.label).toBe("Hi")
    expect(row).not.toHaveProperty("data")
    expect(JSON.stringify(row)).not.toContain("do not leak")
  })

  test("label preview falls through data.label -> data.name -> undefined", () => {
    const doc = buildDoc(
      [
        { id: "withLabel", data: { label: "L", name: "N" } },
        { id: "withName", data: { name: "OnlyName" } },
        { id: "neither", data: { other: "x" } },
        { id: "noData" },
      ],
      [],
    )
    const s = summary(doc, opts)
    const byId = new Map(s.nodes.map((n) => [n.id, n]))
    expect(byId.get("withLabel")!.label).toBe("L")
    expect(byId.get("withName")!.label).toBe("OnlyName")
    expect(byId.get("neither")!.label).toBeUndefined()
    expect(byId.get("noData")!.label).toBeUndefined()
  })

  test("label preview strips newlines/tabs and truncates at 80 chars", () => {
    const doc = buildDoc(
      [
        { id: "long", data: { label: "x".repeat(200) } },
        { id: "multi", data: { label: "first\nsecond\tthird\rfourth" } },
      ],
      [],
    )
    const s = summary(doc, opts)
    const byId = new Map(s.nodes.map((n) => [n.id, n]))
    const longLabel = byId.get("long")!.label!
    expect(longLabel.length).toBe(80)
    expect(longLabel).toBe("x".repeat(80))
    const multiLabel = byId.get("multi")!.label!
    expect(multiLabel).not.toMatch(/[\r\n\t]/)
    expect(multiLabel).toBe("first second third fourth")
  })

  test("projectId and hasLiveClients from opts appear in the response", () => {
    const doc = buildDoc([{ id: "a" }], [])
    const s = summary(doc, { projectId: "P-42", hasLiveClients: true })
    expect(s.projectId).toBe("P-42")
    expect(s.hasLiveClients).toBe(true)
  })
})

describe("state", () => {
  test("includes full data for every node (not stripped)", () => {
    const doc = buildDoc(
      [
        {
          id: "a",
          type: "thing",
          position: { x: 1, y: 2 },
          data: { label: "Hi", payload: { nested: [1, 2, 3] }, secret: "keep" },
        },
        {
          id: "b",
          data: { label: "B", details: "lots" },
        },
      ],
      [],
    )
    const s = state(doc, opts)
    const byId = new Map(s.nodes.map((n) => [n.id, n]))
    expect(byId.get("a")!.data).toEqual({
      label: "Hi",
      payload: { nested: [1, 2, 3] },
      secret: "keep",
    })
    expect(byId.get("b")!.data).toEqual({ label: "B", details: "lots" })
  })

  test("edges arrive intact (source/target preserved)", () => {
    const doc = buildDoc(
      [{ id: "a" }, { id: "b" }],
      [{ id: "e1", source: "a", target: "b", type: "smooth" }],
    )
    const s = state(doc, opts)
    expect(s.edges).toHaveLength(1)
    const e = s.edges[0]!
    expect(e.id).toBe("e1")
    expect(e.source).toBe("a")
    expect(e.target).toBe("b")
    expect(e.type).toBe("smooth")
  })

  test("revision present", () => {
    const doc = buildDoc([{ id: "a" }], [])
    const s = state(doc, opts)
    expect(typeof s.revision).toBe("string")
    expect(s.revision.length).toBeGreaterThan(0)
  })
})

describe("neighborhood", () => {
  test("depth=1 on chain 1->2->3 from focal 2", () => {
    const doc = buildDoc(
      [{ id: "1" }, { id: "2" }, { id: "3" }],
      [
        { id: "e1-2", source: "1", target: "2" },
        { id: "e2-3", source: "2", target: "3" },
      ],
    )
    const n = neighborhood(doc, "2", 1)
    expect(n).not.toBeNull()
    expect(nodeIds(n!)).toEqual(new Set(["1", "2", "3"]))
    expect(edgeIds(n!)).toEqual(new Set(["e1-2", "e2-3"]))
    expect(n!.incoming).toEqual(["e1-2"])
    expect(n!.outgoing).toEqual(["e2-3"])
  })

  test("depth=0 on chain 1->2->3 from focal 2: only focal, no edges", () => {
    const doc = buildDoc(
      [{ id: "1" }, { id: "2" }, { id: "3" }],
      [
        { id: "e1-2", source: "1", target: "2" },
        { id: "e2-3", source: "2", target: "3" },
      ],
    )
    const n = neighborhood(doc, "2", 0)
    expect(n).not.toBeNull()
    expect(nodeIds(n!)).toEqual(new Set(["2"]))
    expect(n!.edges).toEqual([])
    expect(n!.incoming).toEqual([])
    expect(n!.outgoing).toEqual([])
  })

  test("depth=2 on chain 1->2->3->4->5 from focal 3 includes all 5 nodes and 4 edges", () => {
    const doc = buildDoc(
      [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }, { id: "5" }],
      [
        { id: "e1-2", source: "1", target: "2" },
        { id: "e2-3", source: "2", target: "3" },
        { id: "e3-4", source: "3", target: "4" },
        { id: "e4-5", source: "4", target: "5" },
      ],
    )
    const n = neighborhood(doc, "3", 2)
    expect(n).not.toBeNull()
    expect(nodeIds(n!)).toEqual(new Set(["1", "2", "3", "4", "5"]))
    expect(edgeIds(n!)).toEqual(new Set(["e1-2", "e2-3", "e3-4", "e4-5"]))
  })

  test("depth=99 is clamped to 5", () => {
    // Chain of 10 nodes 1..10; focal 1 -> nodes within hop-distance 5 are
    // {1,2,3,4,5,6}; nodes 7..10 must be absent.
    const ids = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]
    const nodes = ids.map((id) => ({ id }))
    const edges = []
    for (let i = 0; i < ids.length - 1; i++) {
      edges.push({
        id: `e${ids[i]}-${ids[i + 1]}`,
        source: ids[i]!,
        target: ids[i + 1]!,
      })
    }
    const doc = buildDoc(nodes, edges)
    const n = neighborhood(doc, "1", 99)
    expect(n).not.toBeNull()
    const visited = nodeIds(n!)
    expect(visited).toEqual(new Set(["1", "2", "3", "4", "5", "6"]))
    for (const absent of ["7", "8", "9", "10"]) {
      expect(visited.has(absent)).toBe(false)
    }
  })

  test("self-loop on focal: edge included exactly once, focal once", () => {
    const doc = buildDoc(
      [{ id: "a" }],
      [{ id: "loop", source: "a", target: "a" }],
    )
    const n = neighborhood(doc, "a", 1)
    expect(n).not.toBeNull()
    expect(n!.focal.id).toBe("a")
    expect(n!.neighbours.map((x) => x.id)).toEqual([])
    expect(n!.edges.map((e) => e.id)).toEqual(["loop"])
    expect(n!.incoming).toEqual(["loop"])
    expect(n!.outgoing).toEqual(["loop"])
  })

  test("disconnected focal returns just the focal and no edges", () => {
    const doc = buildDoc([{ id: "a" }, { id: "b" }], [])
    const n = neighborhood(doc, "a", 5)
    expect(n).not.toBeNull()
    expect(nodeIds(n!)).toEqual(new Set(["a"]))
    expect(n!.edges).toEqual([])
    expect(n!.incoming).toEqual([])
    expect(n!.outgoing).toEqual([])
  })

  test("focal not in doc returns null", () => {
    const doc = buildDoc([{ id: "a" }], [])
    const n = neighborhood(doc, "missing", 1)
    expect(n).toBeNull()
  })

  // Locked-in behaviour for dangling edges: snapshot.ts (lines 144-149)
  // explicitly drops any collected edge whose endpoints aren't both in
  // `visitedNodeIds`. Since "4" is not a node in the doc, it can never enter
  // `visitedNodeIds`, so `e4-2` is dropped from the response — and therefore
  // also absent from node 2's `incoming`.
  test("dangling edges referencing nonexistent nodes are dropped", () => {
    const doc = buildDoc(
      [{ id: "1" }, { id: "2" }, { id: "3" }],
      [
        { id: "e1-2", source: "1", target: "2" },
        { id: "e2-3", source: "2", target: "3" },
        { id: "e4-2", source: "4", target: "2" },
      ],
    )
    const n = neighborhood(doc, "2", 1)
    expect(n).not.toBeNull()
    expect(nodeIds(n!)).toEqual(new Set(["1", "2", "3"]))
    expect(edgeIds(n!)).toEqual(new Set(["e1-2", "e2-3"]))
    expect(n!.incoming).toEqual(["e1-2"])
    expect(n!.outgoing).toEqual(["e2-3"])
    expect(n!.edges.find((e) => e.id === "e4-2")).toBeUndefined()
  })
})
