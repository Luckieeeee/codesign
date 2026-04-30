import { describe, expect, test } from "bun:test"
import type { Edge, Node } from "@xyflow/react"
import * as Y from "yjs"
import {
  edgesTouchingNode,
  getEdgesMap,
  getNodesMap,
  project,
  readEdges,
  readNodes,
} from "../graph"

function makeNode(id: string, label: string): Node {
  return {
    id,
    type: "default",
    position: { x: 0, y: 0 },
    data: { label },
  }
}

function makeEdge(id: string, source: string, target: string): Edge {
  return { id, source, target }
}

function seedDoc(): Y.Doc {
  const doc = new Y.Doc()
  const nodes = getNodesMap(doc)
  const edges = getEdgesMap(doc)
  nodes.set("n1", makeNode("n1", "first"))
  nodes.set("n2", makeNode("n2", "second"))
  edges.set("e1", makeEdge("e1", "n1", "n2"))
  return doc
}

describe("flow-core/graph", () => {
  test("readNodes / readEdges return plain Maps with correct entries", () => {
    const doc = seedDoc()
    const nodes = readNodes(doc)
    const edges = readEdges(doc)

    expect(nodes).toBeInstanceOf(Map)
    expect(edges).toBeInstanceOf(Map)
    expect(nodes.size).toBe(2)
    expect(edges.size).toBe(1)

    const n1 = nodes.get("n1")
    expect(n1).toBeDefined()
    expect(n1?.id).toBe("n1")
    expect(n1?.position).toEqual({ x: 0, y: 0 })
    expect((n1?.data as { label: string }).label).toBe("first")

    const e1 = edges.get("e1")
    expect(e1).toEqual({ id: "e1", source: "n1", target: "n2" })
  })

  test("returned entries are deep clones — mutating does not affect the Y.Map", () => {
    const doc = seedDoc()
    const nodes = readNodes(doc)

    const n1 = nodes.get("n1")
    expect(n1).toBeDefined()
    ;(n1!.data as { label: string }).label = "MUTATED"

    const stored = getNodesMap(doc).get("n1")
    expect(stored).toBeDefined()
    expect((stored!.data as { label: string }).label).toBe("first")

    const reread = readNodes(doc).get("n1")
    expect((reread!.data as { label: string }).label).toBe("first")
  })

  test("edgesTouchingNode works on a Y.Map<Edge>", () => {
    const doc = new Y.Doc()
    const edges = getEdgesMap(doc)
    edges.set("e1", makeEdge("e1", "a", "b"))
    edges.set("e2", makeEdge("e2", "b", "c"))
    edges.set("e3", makeEdge("e3", "x", "y"))

    const touching = edgesTouchingNode(getEdgesMap(doc), "b")
    expect(touching.length).toBe(2)
    expect(new Set(touching.map((e) => e.id))).toEqual(new Set(["e1", "e2"]))

    expect(edgesTouchingNode(getEdgesMap(doc), "z")).toEqual([])
  })

  test("edgesTouchingNode works on a plain Map<string, Edge>", () => {
    const doc = new Y.Doc()
    const edgesMap = getEdgesMap(doc)
    edgesMap.set("e1", makeEdge("e1", "a", "b"))
    edgesMap.set("e2", makeEdge("e2", "b", "c"))
    edgesMap.set("e3", makeEdge("e3", "x", "y"))

    const plain = readEdges(doc)
    const touching = edgesTouchingNode(plain, "b")
    expect(touching.length).toBe(2)
    expect(new Set(touching.map((e) => e.id))).toEqual(new Set(["e1", "e2"]))

    expect(edgesTouchingNode(plain, "z")).toEqual([])
  })

  test("self-loop edge is returned exactly once", () => {
    const doc = new Y.Doc()
    const edges = getEdgesMap(doc)
    edges.set("loop", makeEdge("loop", "a", "a"))

    const fromY = edgesTouchingNode(getEdgesMap(doc), "a")
    expect(fromY.length).toBe(1)
    expect(fromY[0]?.id).toBe("loop")

    const fromPlain = edgesTouchingNode(readEdges(doc), "a")
    expect(fromPlain.length).toBe(1)
    expect(fromPlain[0]?.id).toBe("loop")
  })

  test("empty maps are handled without throwing", () => {
    const emptyDoc = new Y.Doc()
    const nodes = readNodes(emptyDoc)
    const edges = readEdges(emptyDoc)

    expect(nodes).toBeInstanceOf(Map)
    expect(edges).toBeInstanceOf(Map)
    expect(nodes.size).toBe(0)
    expect(edges.size).toBe(0)

    expect(edgesTouchingNode(new Map<string, Edge>(), "anything")).toEqual([])
  })

  test("project(doc) returns { nodes, edges } matching readNodes / readEdges", () => {
    const doc = seedDoc()
    const projected = project(doc)
    const nodes = readNodes(doc)
    const edges = readEdges(doc)

    expect(projected.nodes).toBeInstanceOf(Map)
    expect(projected.edges).toBeInstanceOf(Map)
    expect(projected.nodes.size).toBe(nodes.size)
    expect(projected.edges.size).toBe(edges.size)

    for (const [id, node] of nodes) {
      expect(projected.nodes.get(id)).toEqual(node)
    }
    for (const [id, edge] of edges) {
      expect(projected.edges.get(id)).toEqual(edge)
    }
  })
})
