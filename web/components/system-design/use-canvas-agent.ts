"use client"

import type { Edge, Node, ReactFlowInstance } from "@xyflow/react"
import { MarkerType } from "@xyflow/react"
import { useCallback, useEffect, useMemo, useRef } from "react"
import * as Y from "yjs"

import type {
  AgentCanvasEdge,
  AgentCanvasNode,
  AgentOp,
} from "@/lib/canvas-ai/types"

import { computeAutoLayout } from "./auto-layout"
import { routeEdges } from "./edge-routing"
import {
  GROUP_DEFAULT_SIZE,
  SYSTEM_EDGE_TYPE,
  SYSTEM_GROUP_TYPE,
  SYSTEM_NODE_TYPE,
  SYSTEM_TEXT_TYPE,
  type IconCategory,
  type IconEntry,
  type IconManifest,
  type SystemEdgeData,
  type SystemGroupData,
  type SystemNodeData,
  type SystemTextData,
} from "./types"

type UseCanvasAgentParams = {
  ydoc: Y.Doc
  ynodes: Y.Map<Node>
  yedges: Y.Map<Edge>
  reactFlow: ReactFlowInstance
  /** Live snapshot getters so the agent always sees the latest state. */
  getNodesSnapshot: () => Node[]
  getEdgesSnapshot: () => Edge[]
  getSelectedNodeIds: () => string[]
  projectName: string
}

export type CanvasAgentApi = {
  getCanvasContext: () => {
    nodes: AgentCanvasNode[]
    edges: AgentCanvasEdge[]
    selectedNodeIds: string[]
    projectName: string
  }
  beginSession: () => void
  /**
   * Apply a single op streamed from the model. Position-less nodes are
   * dropped at a placeholder coordinate; `finishSession` then runs a real
   * dagre layout once the stream completes.
   */
  applyOp: (op: AgentOp) => void
  /** Run dagre on everything the agent created during this session. */
  finishSession: () => void
}

const EDGE_MARKER_END = {
  type: MarkerType.ArrowClosed,
  width: 14,
  height: 14,
  color: "var(--muted-foreground)",
} as const

/**
 * Translates AI agent operations into Yjs mutations on the system-design
 * canvas. Owns:
 *
 * - The icon manifest (lazily fetched once) so the agent can resolve fuzzy
 *   icon hints to actual manifest entries.
 * - A per-session id map so the model can author short ids like `n_api`,
 *   reference them in subsequent edges within the same response, and have
 *   the canvas store them under freshly-generated stable ids.
 * - An auto-layout cursor that drops freshly-spawned nodes in a tidy grid
 *   centered on the current viewport when the model doesn't supply
 *   positions.
 */
export function useCanvasAgent({
  ydoc,
  ynodes,
  yedges,
  reactFlow,
  getNodesSnapshot,
  getEdgesSnapshot,
  getSelectedNodeIds,
  projectName,
}: UseCanvasAgentParams): CanvasAgentApi {
  // --- Icon manifest ------------------------------------------------------
  const manifestRef = useRef<IconManifest | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch("/icons-manifest.json", { cache: "force-cache" })
      .then((res) => (res.ok ? (res.json() as Promise<IconManifest>) : null))
      .then((data) => {
        if (!cancelled && data) manifestRef.current = data
      })
      .catch(() => {
        /* fall back to placeholder icon when an icon hint can't be resolved */
      })
    return () => {
      cancelled = true
    }
  }, [])

  // --- Session state (reset between agent requests) -----------------------
  const sessionRef = useRef<{
    /** Maps author-supplied ids (e.g. "n_api") → real canvas ids. */
    idMap: Map<string, string>
    /** Real ids of every node created during this session. */
    addedNodeIds: Set<string>
    /** Anchor point in flow space for the final dagre layout. */
    layoutAnchor: { x: number; y: number } | null
    /** Counter for the placeholder grid used while ops are still streaming. */
    placeholderSlot: number
  }>({
    idMap: new Map(),
    addedNodeIds: new Set(),
    layoutAnchor: null,
    placeholderSlot: 0,
  })

  const beginSession = useCallback(() => {
    sessionRef.current = {
      idMap: new Map(),
      addedNodeIds: new Set(),
      layoutAnchor: null,
      placeholderSlot: 0,
    }
  }, [])

  // --- Context exporter ---------------------------------------------------
  const getCanvasContext = useCallback(() => {
    const nodes = getNodesSnapshot().map<AgentCanvasNode>((n) => {
      const data = (n.data ?? {}) as Record<string, unknown>
      const kind: AgentCanvasNode["kind"] =
        n.type === SYSTEM_GROUP_TYPE
          ? "group"
          : n.type === SYSTEM_TEXT_TYPE
            ? "text"
            : "icon"
      return {
        id: n.id,
        kind,
        label:
          (typeof data.label === "string" && data.label) ||
          (typeof data.text === "string" && data.text) ||
          "",
        iconId:
          typeof data.iconId === "string" ? (data.iconId as string) : undefined,
        parentId: n.parentId,
        position: { x: n.position.x, y: n.position.y },
      }
    })
    const edges = getEdgesSnapshot().map<AgentCanvasEdge>((e) => {
      const data = (e.data ?? {}) as Record<string, unknown>
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        label: typeof data.label === "string" ? data.label : undefined,
        method: typeof data.method === "string" ? data.method : undefined,
      }
    })
    return {
      nodes,
      edges,
      selectedNodeIds: getSelectedNodeIds(),
      projectName,
    }
  }, [getNodesSnapshot, getEdgesSnapshot, getSelectedNodeIds, projectName])

  // --- Auto-layout helpers -----------------------------------------------

  /**
   * Anchor for new content. Defaults to the visible canvas center; we lock
   * it in at session start so all nodes from one response cluster together
   * even if the user pans away mid-stream.
   */
  const ensureLayoutAnchor = useCallback(() => {
    const session = sessionRef.current
    if (session.layoutAnchor) return session.layoutAnchor
    let anchor: { x: number; y: number } | null = null
    if (typeof window !== "undefined") {
      try {
        anchor = reactFlow.screenToFlowPosition({
          x: window.innerWidth / 2,
          y: window.innerHeight / 2,
        })
      } catch {
        anchor = null
      }
    }
    if (!anchor) anchor = { x: 0, y: 0 }
    session.layoutAnchor = anchor
    return anchor
  }, [reactFlow])

  /**
   * Throwaway position used while ops are still streaming in. Far enough
   * off-anchor that the user sees them but they don't collide with the
   * existing graph; replaced by a real layout in `finishSession`.
   */
  const nextPlaceholderPosition = useCallback(() => {
    const anchor = ensureLayoutAnchor()
    const session = sessionRef.current
    const slot = session.placeholderSlot
    session.placeholderSlot += 1
    // Tight horizontal stack — purely visual feedback. Real layout follows.
    return {
      x: anchor.x + slot * 30,
      y: anchor.y + slot * 24,
    }
  }, [ensureLayoutAnchor])

  // --- Id mapping ---------------------------------------------------------

  /** Translate an author-supplied id to a real canvas id. */
  const resolveExistingId = useCallback(
    (authorId: string): string | null => {
      if (!authorId) return null
      const mapped = sessionRef.current.idMap.get(authorId)
      if (mapped) return mapped
      // Author may have referenced an existing canvas id verbatim.
      if (ynodes.has(authorId) || yedges.has(authorId)) return authorId
      return null
    },
    [ynodes, yedges],
  )

  const newCanvasId = useCallback((prefix: string) => {
    return `${prefix}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 6)}`
  }, [])

  // --- Icon resolution ----------------------------------------------------

  const resolveIcon = useCallback(
    (hint: string | undefined): IconEntry | null => {
      const manifest = manifestRef.current
      if (!manifest || !hint) return null
      const trimmed = hint.trim()
      if (!trimmed) return null

      // Exact id match across all categories.
      for (const list of Object.values(manifest.byCategory)) {
        const direct = list.find((e) => e.id === trimmed)
        if (direct) return direct
      }

      const lowered = trimmed.toLowerCase()
      const tokens = lowered.split(/[^a-z0-9]+/i).filter(Boolean)

      type Scored = { entry: IconEntry; score: number }
      const scored: Scored[] = []

      // Search generic + cloud providers first; users almost always prefer
      // those over a random brand logo for the same word.
      const orderedCategories: IconCategory[] = [
        "generic",
        "aws",
        "gcp",
        "azure",
        "kubernetes",
        "tech-logos",
        "brand-logos",
        "brand-logos-extra",
        "open-libs",
      ]
      for (const cat of orderedCategories) {
        const list = manifest.byCategory[cat]
        if (!list) continue
        for (const entry of list) {
          const haystack = `${entry.id} ${entry.name} ${
            entry.subcategory ?? ""
          }`.toLowerCase()
          let score = 0
          for (const tok of tokens) {
            if (haystack.includes(tok)) score += 1
          }
          if (entry.name.toLowerCase() === lowered) score += 5
          if (haystack === lowered) score += 5
          if (score > 0) scored.push({ entry, score })
        }
      }
      if (scored.length === 0) return null
      scored.sort((a, b) => b.score - a.score)
      return scored[0].entry
    },
    [],
  )

  const placeholderIcon: IconEntry = useMemo(
    () => ({
      id: "generic:primitives:service",
      name: "Service",
      path: "/icons/generic/primitives/service.svg",
      category: "generic",
    }),
    [],
  )

  // --- The applyOp dispatcher --------------------------------------------

  const applyOp = useCallback(
    (op: AgentOp) => {
      switch (op.op) {
        case "add_node": {
          const realId = newCanvasId(
            op.kind === "group" ? "g" : op.kind === "text" ? "t" : "n",
          )
          if (op.id) sessionRef.current.idMap.set(op.id, realId)
          sessionRef.current.addedNodeIds.add(realId)

          // Author-supplied positions win; otherwise drop a placeholder
          // — finishSession will run a real dagre pass once we know all
          // the nodes + edges from this response.
          const position = op.position ?? nextPlaceholderPosition()

          // Resolve a parent if one was specified (must already exist on
          // the canvas, OR have been created earlier in this same session).
          const parentRealId = op.parentId
            ? resolveExistingId(op.parentId)
            : null

          if (op.kind === "text") {
            const data: SystemTextData = {
              text: op.text ?? op.label ?? "",
              variant: op.textVariant ?? "body",
            }
            const node: Node = {
              id: realId,
              type: SYSTEM_TEXT_TYPE,
              position,
              data,
              ...(parentRealId
                ? { parentId: parentRealId, extent: "parent" as const }
                : {}),
            }
            ydoc.transact(() => ynodes.set(realId, node), "agent")
            return
          }

          if (op.kind === "group") {
            const data: SystemGroupData = {
              label: op.label ?? "Group",
              ...(op.color ? { color: op.color } : {}),
            }
            const node: Node = {
              id: realId,
              type: SYSTEM_GROUP_TYPE,
              position,
              width: op.width ?? GROUP_DEFAULT_SIZE.width,
              height: op.height ?? GROUP_DEFAULT_SIZE.height,
              data,
              ...(parentRealId
                ? { parentId: parentRealId, extent: "parent" as const }
                : {}),
            }
            ydoc.transact(() => ynodes.set(realId, node), "agent")
            return
          }

          // kind === "icon"
          const icon = resolveIcon(op.iconId) ?? placeholderIcon
          const data: SystemNodeData = {
            iconId: icon.id,
            iconPath: icon.path,
            iconCategory: icon.category,
            label: op.label ?? icon.name,
            ...(op.description ? { description: op.description } : {}),
          }
          const node: Node = {
            id: realId,
            type: SYSTEM_NODE_TYPE,
            position,
            data,
            ...(parentRealId
              ? { parentId: parentRealId, extent: "parent" as const }
              : {}),
          }
          ydoc.transact(() => ynodes.set(realId, node), "agent")
          return
        }

        case "add_edge": {
          const source = resolveExistingId(op.source)
          const target = resolveExistingId(op.target)
          if (!source || !target) {
            console.warn("agent add_edge: unresolved endpoint", op)
            return
          }
          const realId = newCanvasId("e")
          if (op.id) sessionRef.current.idMap.set(op.id, realId)
          const data: SystemEdgeData = {
            ...(op.label ? { label: op.label } : {}),
            ...(op.method ? { method: op.method } : {}),
            ...(op.endpoint ? { endpoint: op.endpoint } : {}),
            ...(op.notes ? { notes: op.notes } : {}),
            ...(op.request ? { request: op.request } : {}),
            ...(op.response ? { response: op.response } : {}),
          }
          const edge: Edge = {
            id: realId,
            source,
            target,
            type: SYSTEM_EDGE_TYPE,
            markerEnd: { ...EDGE_MARKER_END },
            data,
          }
          const nodes: Node[] = []
          ynodes.forEach((node) => nodes.push(node))
          const [routedEdge] = routeEdges([edge], nodes, {
            rerouteHandles: false,
          })
          ydoc.transact(() => yedges.set(realId, routedEdge), "agent")
          return
        }

        case "update_node": {
          const realId = resolveExistingId(op.id)
          if (!realId) {
            console.warn("agent update_node: unknown id", op.id)
            return
          }
          const current = ynodes.get(realId)
          if (!current) return
          const data = (current.data ?? {}) as Record<string, unknown>
          const nextData: Record<string, unknown> = { ...data }
          if (op.label !== undefined) nextData.label = op.label
          if (op.description !== undefined) nextData.description = op.description
          if (op.text !== undefined) nextData.text = op.text
          if (op.color !== undefined) nextData.color = op.color
          if (op.iconId !== undefined) {
            const icon = resolveIcon(op.iconId)
            if (icon) {
              nextData.iconId = icon.id
              nextData.iconPath = icon.path
              nextData.iconCategory = icon.category
            }
          }
          const next: Node = {
            ...current,
            data: nextData,
            ...(op.position
              ? { position: { x: op.position.x, y: op.position.y } }
              : {}),
          }
          ydoc.transact(() => ynodes.set(realId, next), "agent")
          return
        }

        case "update_edge": {
          const realId = resolveExistingId(op.id)
          if (!realId) {
            console.warn("agent update_edge: unknown id", op.id)
            return
          }
          const current = yedges.get(realId)
          if (!current) return
          const data = (current.data ?? {}) as SystemEdgeData
          const nextData: SystemEdgeData = { ...data }
          if (op.label !== undefined) nextData.label = op.label
          if (op.method !== undefined) nextData.method = op.method
          if (op.endpoint !== undefined) nextData.endpoint = op.endpoint
          if (op.notes !== undefined) nextData.notes = op.notes
          if (op.request !== undefined) nextData.request = op.request
          if (op.response !== undefined) nextData.response = op.response
          const next: Edge = { ...current, data: nextData }
          ydoc.transact(() => yedges.set(realId, next), "agent")
          return
        }

        case "delete_node": {
          const realId = resolveExistingId(op.id)
          if (!realId) return
          ydoc.transact(() => {
            ynodes.delete(realId)
            const drop: string[] = []
            yedges.forEach((edge, edgeId) => {
              if (edge.source === realId || edge.target === realId)
                drop.push(edgeId)
            })
            for (const edgeId of drop) yedges.delete(edgeId)
            // Orphan any children — preserves work the user did inside.
            ynodes.forEach((node, nodeId) => {
              if (node.parentId === realId) {
                const reparented: Node = { ...node }
                delete (reparented as { parentId?: string }).parentId
                delete (reparented as { extent?: unknown }).extent
                ynodes.set(nodeId, reparented)
              }
            })
          }, "agent")
          return
        }

        case "delete_edge": {
          const realId = resolveExistingId(op.id)
          if (!realId) return
          ydoc.transact(() => yedges.delete(realId), "agent")
          return
        }
      }
    },
    [
      ydoc,
      ynodes,
      yedges,
      newCanvasId,
      nextPlaceholderPosition,
      resolveExistingId,
      resolveIcon,
      placeholderIcon,
    ],
  )

  // --- Finish session: run dagre on everything the agent created ----------

  const finishSession = useCallback(() => {
    const session = sessionRef.current
    if (session.addedNodeIds.size === 0) return

    // Take a fresh snapshot from Yjs (not the stale React state) so we
    // include every op we just dispatched, even if React hasn't flushed.
    const allNodes: Node[] = []
    ynodes.forEach((n) => allNodes.push(n))
    const allEdges: Edge[] = []
    yedges.forEach((e) => allEdges.push(e))

    // Anchor: existing graph stays put; lay out new content into the
    // visible canvas center. If the entire canvas is new, use the session
    // anchor we recorded at the start.
    const anchor = ensureLayoutAnchor()

    const patches = computeAutoLayout(allNodes, allEdges, {
      direction: "LR",
      scope: session.addedNodeIds,
      anchor,
    })
    if (patches.size === 0) return

    const nextNodes = allNodes.map((node) => {
      const patch = patches.get(node.id)
      if (!patch) return node
      return {
        ...node,
        position: patch.position,
        ...(patch.width !== undefined ? { width: patch.width } : {}),
        ...(patch.height !== undefined ? { height: patch.height } : {}),
      }
    })
    const nextEdges = routeEdges(allEdges, nextNodes, { rerouteHandles: true })

    ydoc.transact(() => {
      for (const node of nextNodes) {
        if (patches.has(node.id)) ynodes.set(node.id, node)
      }
      for (const edge of nextEdges) {
        yedges.set(edge.id, edge)
      }
    }, "agent-layout")
  }, [ydoc, ynodes, yedges, ensureLayoutAnchor])

  return { getCanvasContext, beginSession, applyOp, finishSession }
}
