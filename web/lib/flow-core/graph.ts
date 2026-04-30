import type { Edge, Node } from "@xyflow/react"
import * as Y from "yjs"

export const NODES_MAP_KEY = "flow:nodes"
export const EDGES_MAP_KEY = "flow:edges"

export function getNodesMap(doc: Y.Doc): Y.Map<Node> {
  return doc.getMap<Node>(NODES_MAP_KEY)
}

export function getEdgesMap(doc: Y.Doc): Y.Map<Edge> {
  return doc.getMap<Edge>(EDGES_MAP_KEY)
}

export function readNodes(doc: Y.Doc): Map<string, Node> {
  const nodesMap = getNodesMap(doc)
  const result = new Map<string, Node>()
  for (const id of nodesMap.keys()) {
    result.set(id, structuredClone(nodesMap.get(id)!))
  }
  return result
}

export function readEdges(doc: Y.Doc): Map<string, Edge> {
  const edgesMap = getEdgesMap(doc)
  const result = new Map<string, Edge>()
  for (const id of edgesMap.keys()) {
    result.set(id, structuredClone(edgesMap.get(id)!))
  }
  return result
}

export function project(doc: Y.Doc): {
  nodes: Map<string, Node>
  edges: Map<string, Edge>
} {
  return { nodes: readNodes(doc), edges: readEdges(doc) }
}

export function edgesTouchingNode(
  edges: Map<string, Edge> | Y.Map<Edge>,
  nodeId: string,
): Edge[] {
  const matches: Edge[] = []
  for (const edge of edges.values()) {
    if (edge.source === nodeId || edge.target === nodeId) {
      matches.push(edge)
    }
  }
  return matches
}
