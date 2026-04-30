import dagre from "@dagrejs/dagre"
import type { Edge, Node } from "@xyflow/react"

import { GROUP_DEFAULT_SIZE, SYSTEM_GROUP_TYPE } from "./types"

/**
 * Auto-layout for the system-design canvas.
 *
 * Uses dagre per-subgraph (root + each group). Group nodes are recursively
 * laid out from the leaves up:
 *   1. Layout each group's direct children.
 *   2. Resize the group to fit the children + padding.
 *   3. Layout the parent's level using the freshly-sized group as a node.
 *
 * Returns a map of `nodeId -> { position, width?, height? }` patches that
 * the caller can apply through Yjs in a single transaction.
 */

export type LayoutDirection = "LR" | "TB"

export type LayoutOptions = {
  direction?: LayoutDirection
  /** Horizontal spacing between sibling nodes within a rank. */
  nodeSep?: number
  /** Vertical spacing between ranks. */
  rankSep?: number
  /** Padding inside groups, in flow units. */
  groupPadding?: number
  /** Subset of node ids to lay out. Anything outside is treated as fixed. */
  scope?: ReadonlySet<string>
  /** Anchor point in flow space — the laid-out content is centered here. */
  anchor?: { x: number; y: number }
}

export type LayoutPatch = {
  position: { x: number; y: number }
  width?: number
  height?: number
}

const DEFAULT_NODE_SEP = 60
const DEFAULT_RANK_SEP = 110
const DEFAULT_GROUP_PADDING = 36
const GROUP_HEADER_HEIGHT = 24

const ICON_NODE_WIDTH = 112
const ICON_NODE_HEIGHT = 96
const TEXT_NODE_WIDTH = 160
const TEXT_NODE_HEIGHT = 40

function inferNodeSize(node: Node): { width: number; height: number } {
  // Prefer measured dimensions when React Flow has reported them.
  const measuredW = node.measured?.width ?? node.width
  const measuredH = node.measured?.height ?? node.height
  if (measuredW && measuredH) return { width: measuredW, height: measuredH }

  if (node.type === SYSTEM_GROUP_TYPE) {
    return {
      width: node.width ?? GROUP_DEFAULT_SIZE.width,
      height: node.height ?? GROUP_DEFAULT_SIZE.height,
    }
  }
  if (node.type === "systemText") {
    return { width: TEXT_NODE_WIDTH, height: TEXT_NODE_HEIGHT }
  }
  return { width: ICON_NODE_WIDTH, height: ICON_NODE_HEIGHT }
}

/**
 * Run dagre on a flat list of nodes + the edges between them. Returns a
 * map from id to top-left position (relative to the dagre origin) plus a
 * bounding-box of the entire layout.
 */
function runDagre(
  nodes: Array<{ id: string; width: number; height: number }>,
  edges: Array<{ source: string; target: string }>,
  options: { direction: LayoutDirection; nodeSep: number; rankSep: number },
): {
  positions: Map<string, { x: number; y: number; w: number; h: number }>
  width: number
  height: number
} {
  const g = new dagre.graphlib.Graph({ multigraph: true })
  g.setGraph({
    rankdir: options.direction,
    nodesep: options.nodeSep,
    ranksep: options.rankSep,
    marginx: 0,
    marginy: 0,
  })
  g.setDefaultEdgeLabel(() => ({}))

  for (const n of nodes) {
    g.setNode(n.id, { width: n.width, height: n.height })
  }
  // Dagre needs both endpoints to be in the graph; skip dangling refs.
  const ids = new Set(nodes.map((n) => n.id))
  let edgeCounter = 0
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue
    if (e.source === e.target) continue
    g.setEdge(e.source, e.target, {}, `e${edgeCounter++}`)
  }

  dagre.layout(g)

  const positions = new Map<
    string,
    { x: number; y: number; w: number; h: number }
  >()
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const n of nodes) {
    const laid = g.node(n.id) as
      | { x: number; y: number; width: number; height: number }
      | undefined
    if (!laid) continue
    const x = laid.x - laid.width / 2
    const y = laid.y - laid.height / 2
    positions.set(n.id, { x, y, w: laid.width, h: laid.height })
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x + laid.width > maxX) maxX = x + laid.width
    if (y + laid.height > maxY) maxY = y + laid.height
  }
  if (positions.size === 0) {
    return { positions, width: 0, height: 0 }
  }
  // Translate so layout starts at (0, 0).
  for (const [id, pos] of positions) {
    positions.set(id, {
      x: pos.x - minX,
      y: pos.y - minY,
      w: pos.w,
      h: pos.h,
    })
  }
  return { positions, width: maxX - minX, height: maxY - minY }
}

/**
 * Compute layout patches for the given nodes + edges.
 *
 * Patches encode top-left positions (matching React Flow's coordinate
 * system) relative to each node's parent. Groups also receive an updated
 * `width` / `height` to fit their children with consistent padding.
 */
export function computeAutoLayout(
  nodes: Node[],
  edges: Edge[],
  options: LayoutOptions = {},
): Map<string, LayoutPatch> {
  const direction = options.direction ?? "LR"
  const nodeSep = options.nodeSep ?? DEFAULT_NODE_SEP
  const rankSep = options.rankSep ?? DEFAULT_RANK_SEP
  const groupPadding = options.groupPadding ?? DEFAULT_GROUP_PADDING
  const scope = options.scope

  const patches = new Map<string, LayoutPatch>()
  if (nodes.length === 0) return patches

  // Build a parent → children map. Anything missing a parentId is treated
  // as a root-level node.
  const childrenByParent = new Map<string | null, Node[]>()
  for (const n of nodes) {
    const key = n.parentId ?? null
    const list = childrenByParent.get(key) ?? []
    list.push(n)
    childrenByParent.set(key, list)
  }

  // Edges keyed by parent (containing both endpoints) so each subgraph only
  // sees its own internal connections. Edges that cross subgraph boundaries
  // become root-level edges between the two parent groups.
  const nodeIndex = new Map(nodes.map((n) => [n.id, n]))
  const edgesByParent = new Map<string | null, Edge[]>()
  const rootCrossEdges: Edge[] = []
  for (const e of edges) {
    const s = nodeIndex.get(e.source)
    const t = nodeIndex.get(e.target)
    if (!s || !t) continue
    if ((s.parentId ?? null) === (t.parentId ?? null)) {
      const key = s.parentId ?? null
      const list = edgesByParent.get(key) ?? []
      list.push(e)
      edgesByParent.set(key, list)
    } else {
      rootCrossEdges.push(e)
    }
  }

  /**
   * Recursive helper: layout the subgraph at `parentKey`, returning the
   * effective size to use for the parent (after fitting children).
   */
  function layoutSubgraph(parentKey: string | null): {
    width: number
    height: number
  } {
    const directChildren = childrenByParent.get(parentKey) ?? []
    if (directChildren.length === 0) {
      // A leaf group — preserve its current size.
      if (!parentKey) return { width: 0, height: 0 }
      const parentNode = nodeIndex.get(parentKey)
      return inferNodeSize(parentNode!)
    }

    // First, recurse into any group children so their sizes reflect their
    // own laid-out contents before we lay out at this level.
    const sizedChildren = directChildren.map((child) => {
      if (child.type === SYSTEM_GROUP_TYPE) {
        const fit = layoutSubgraph(child.id)
        return { node: child, ...fit }
      }
      const size = inferNodeSize(child)
      return { node: child, width: size.width, height: size.height }
    })

    const dagreNodes = sizedChildren.map(({ node, width, height }) => ({
      id: node.id,
      width,
      height,
    }))

    // For root, also consider edges between top-level groups.
    const subEdges = [
      ...(edgesByParent.get(parentKey) ?? []),
      ...(parentKey === null ? rootCrossEdges.map((e) => collapseToRoot(e)) : []),
    ].filter((e): e is Edge => e !== null)

    const { positions, width, height } = runDagre(dagreNodes, subEdges, {
      direction,
      nodeSep,
      rankSep,
    })

    // For groups: apply padding and shift child positions by the padding so
    // they don't bleed into the dashed border / label chip.
    const yOffset =
      parentKey === null ? 0 : groupPadding + GROUP_HEADER_HEIGHT
    const xOffset = parentKey === null ? 0 : groupPadding

    const inScope = (id: string) => !scope || scope.has(id)

    for (const { node, width: w, height: h } of sizedChildren) {
      const laid = positions.get(node.id)
      if (!laid) continue

      // Patch the node's position relative to its parent.
      if (inScope(node.id)) {
        patches.set(node.id, {
          position: {
            x: laid.x + xOffset,
            y: laid.y + yOffset,
          },
          // Resized groups get a fresh width/height so they fit their
          // (newly-laid-out) children.
          ...(node.type === SYSTEM_GROUP_TYPE
            ? { width: w, height: h }
            : {}),
        })
      } else if (node.type === SYSTEM_GROUP_TYPE && patches.has(node.id)) {
        // Out of scope but we resized it during the recursion — keep the
        // size patch but drop any layout-driven repositioning by reading
        // back the pre-existing position later.
      }
    }

    if (parentKey === null) {
      // Center the whole layout on the requested anchor (or at origin).
      const anchor = options.anchor ?? { x: 0, y: 0 }
      const cx = anchor.x - width / 2
      const cy = anchor.y - height / 2
      for (const { node } of sizedChildren) {
        const patch = patches.get(node.id)
        if (!patch) continue
        patches.set(node.id, {
          ...patch,
          position: {
            x: patch.position.x + cx,
            y: patch.position.y + cy,
          },
        })
      }
      return { width, height }
    }

    // For nested groups, return the bounding box plus padding so the
    // parent layout reserves enough space for us.
    return {
      width: width + groupPadding * 2,
      height: height + groupPadding * 2 + GROUP_HEADER_HEIGHT,
    }
  }

  /**
   * Collapse an edge that crosses subgraphs to point at the top-level
   * ancestor groups, so dagre can use it when laying out at the root.
   */
  function collapseToRoot(edge: Edge): Edge | null {
    const ancestor = (id: string): string | null => {
      let cur: Node | undefined = nodeIndex.get(id)
      let last: string | null = null
      while (cur) {
        last = cur.id
        if (!cur.parentId) return last
        cur = nodeIndex.get(cur.parentId)
      }
      return last
    }
    const s = ancestor(edge.source)
    const t = ancestor(edge.target)
    if (!s || !t || s === t) return null
    return { ...edge, source: s, target: t }
  }

  layoutSubgraph(null)
  return patches
}
