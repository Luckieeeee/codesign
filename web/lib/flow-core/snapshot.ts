/**
 * Read-side serialisers for the agent bridge.
 *
 * Three pure projections of a `Y.Doc`:
 *   - `summary` — counts + label-only node rows + minimal edge rows
 *   - `state`   — full node + edge payloads (data preserved)
 *   - `neighborhood` — BFS-to-depth view around a focal node
 *
 * No `Y.transact`, no mutation. Every helper reads via
 * `readNodes` / `readEdges` (which `structuredClone` each entry, so the
 * returned objects are safe to inspect without leaking refs back into
 * the live `Y.Map`s) and embeds a fresh `revision` token.
 *
 * Note on signatures: the prompt for this todo specified only `(doc)`
 * for `summary` / `state`, but `SnapshotResponseSchema` /
 * `StateResponseSchema` require `projectId` and `hasLiveClients` —
 * neither of which can be derived from the `Y.Doc` alone. The schema
 * is the load-bearing contract (`docs/agent-bridge-plan.md`
 * § "API surface (HTTP)"), so the signatures take an `opts` argument
 * carrying those caller-supplied envelope fields.
 *
 * `neighborhood` returns `null` when the focal id is missing rather
 * than throwing — `routes.ts` translates that to a `404
 * NODE_NOT_FOUND` `AgentError`. Doing the mapping at the route layer
 * keeps `flow-core/` free of HTTP-specific error types.
 */

import type { Edge, Node } from "@xyflow/react"
import * as Y from "yjs"

import { edgesTouchingNode, readEdges, readNodes } from "./graph"
import { computeRevision } from "./revision"
import type { NeighborhoodResponse, SnapshotResponse, StateResponse } from "./types"

const MAX_DEPTH = 5
const LABEL_MAX_CHARS = 80

export interface SnapshotOpts {
  projectId: string
  hasLiveClients: boolean
}

function previewLabel(data: Node["data"] | undefined): string | undefined {
  if (!data) return undefined
  const raw = (data as Record<string, unknown>).label ?? (data as Record<string, unknown>).name
  if (raw === undefined || raw === null) return undefined
  const flattened = String(raw).replace(/[\r\n\t]+/g, " ").trim()
  if (flattened.length === 0) return undefined
  return flattened.length > LABEL_MAX_CHARS
    ? flattened.slice(0, LABEL_MAX_CHARS)
    : flattened
}

export function summary(doc: Y.Doc, opts: SnapshotOpts): SnapshotResponse {
  const nodes = readNodes(doc)
  const edges = readEdges(doc)

  const nodeRows: SnapshotResponse["nodes"] = []
  for (const node of nodes.values()) {
    const row: SnapshotResponse["nodes"][number] = {
      id: node.id,
      position: node.position,
    }
    if (node.type !== undefined) row.type = node.type
    const label = previewLabel(node.data)
    if (label !== undefined) row.label = label
    nodeRows.push(row)
  }

  const edgeRows: SnapshotResponse["edges"] = []
  for (const edge of edges.values()) {
    const row: SnapshotResponse["edges"][number] = {
      id: edge.id,
      source: edge.source,
      target: edge.target,
    }
    if (edge.type !== undefined) row.type = edge.type
    edgeRows.push(row)
  }

  return {
    projectId: opts.projectId,
    revision: computeRevision(doc),
    nodeCount: nodes.size,
    edgeCount: edges.size,
    hasLiveClients: opts.hasLiveClients,
    nodes: nodeRows,
    edges: edgeRows,
  }
}

export function state(doc: Y.Doc, opts: SnapshotOpts): StateResponse {
  const nodes = readNodes(doc)
  const edges = readEdges(doc)

  return {
    projectId: opts.projectId,
    revision: computeRevision(doc),
    nodeCount: nodes.size,
    edgeCount: edges.size,
    hasLiveClients: opts.hasLiveClients,
    nodes: Array.from(nodes.values()) as StateResponse["nodes"],
    edges: Array.from(edges.values()) as StateResponse["edges"],
  }
}

export function neighborhood(
  doc: Y.Doc,
  nodeId: string,
  depth: number,
): NeighborhoodResponse | null {
  const nodes = readNodes(doc)
  const focal = nodes.get(nodeId)
  if (!focal) return null

  const edges = readEdges(doc)
  const clampedDepth = Math.max(0, Math.min(MAX_DEPTH, Math.floor(depth)))

  const visitedNodeIds = new Set<string>([nodeId])
  const collectedEdges = new Map<string, Edge>()

  // BFS frontier: ids whose neighbours we still need to explore.
  let frontier: string[] = [nodeId]
  for (let hop = 0; hop < clampedDepth; hop++) {
    const nextFrontier: string[] = []
    for (const currentId of frontier) {
      const touching = edgesTouchingNode(edges, currentId)
      for (const edge of touching) {
        collectedEdges.set(edge.id, edge)
        const otherId = edge.source === currentId ? edge.target : edge.source
        if (!nodes.has(otherId)) continue
        if (visitedNodeIds.has(otherId)) continue
        visitedNodeIds.add(otherId)
        nextFrontier.push(otherId)
      }
    }
    if (nextFrontier.length === 0) break
    frontier = nextFrontier
  }

  // Drop edges whose endpoints aren't both in the visited set so the
  // returned `edges` array stays internally consistent (every endpoint
  // is resolvable inside this response).
  const visibleEdges: Edge[] = []
  for (const edge of collectedEdges.values()) {
    if (visitedNodeIds.has(edge.source) && visitedNodeIds.has(edge.target)) {
      visibleEdges.push(edge)
    }
  }

  const incoming: string[] = []
  const outgoing: string[] = []
  for (const edge of visibleEdges) {
    if (edge.target === nodeId) incoming.push(edge.id)
    if (edge.source === nodeId) outgoing.push(edge.id)
  }

  const neighbours: Node[] = []
  for (const id of visitedNodeIds) {
    if (id === nodeId) continue
    const node = nodes.get(id)
    if (node) neighbours.push(node)
  }

  return {
    revision: computeRevision(doc),
    focal: focal as NeighborhoodResponse["focal"],
    neighbours: neighbours as NeighborhoodResponse["neighbours"],
    edges: visibleEdges as NeighborhoodResponse["edges"],
    incoming,
    outgoing,
  }
}
