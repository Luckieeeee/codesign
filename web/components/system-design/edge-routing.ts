"use client"

import { Position, type Edge, type Node } from "@xyflow/react"

import {
  GROUP_DEFAULT_SIZE,
  SYSTEM_GROUP_TYPE,
  SYSTEM_NODE_TYPE,
} from "./types"

export type CanvasHandleSide = "top" | "right" | "bottom" | "left"

export const SOURCE_HANDLE_IDS: Record<CanvasHandleSide, string> = {
  top: "top-source",
  right: "right-source",
  bottom: "bottom-source",
  left: "left-source",
}

export const TARGET_HANDLE_IDS: Record<CanvasHandleSide, string> = {
  top: "top-target",
  right: "right-target",
  bottom: "bottom-target",
  left: "left-target",
}

export const CANVAS_HANDLE_SIDES: CanvasHandleSide[] = [
  "top",
  "right",
  "bottom",
  "left",
]

export const positionForSide = (side: CanvasHandleSide): Position => {
  switch (side) {
    case "top":
      return Position.Top
    case "right":
      return Position.Right
    case "bottom":
      return Position.Bottom
    case "left":
      return Position.Left
  }
}

type Rect = { x: number; y: number; width: number; height: number }
type Point = { x: number; y: number }
export type EdgeLabelOffset = { x: number; y: number }
type EdgeRoute = { points: Point[]; label: Point } | null

const ICON_NODE_WIDTH = 112
const ICON_NODE_HEIGHT = 96
const TEXT_NODE_WIDTH = 160
const TEXT_NODE_HEIGHT = 40
const OBSTACLE_PADDING = 30
const ROUTE_CLEARANCE = 44
const ROUTE_STUB = 36

function inferNodeSize(node: Node): { width: number; height: number } {
  const measuredW = node.measured?.width ?? node.width
  const measuredH = node.measured?.height ?? node.height
  if (measuredW && measuredH) return { width: measuredW, height: measuredH }

  if (node.type === SYSTEM_GROUP_TYPE) {
    return {
      width: node.width ?? GROUP_DEFAULT_SIZE.width,
      height: node.height ?? GROUP_DEFAULT_SIZE.height,
    }
  }
  if (node.type === SYSTEM_NODE_TYPE) {
    return { width: ICON_NODE_WIDTH, height: ICON_NODE_HEIGHT }
  }
  return { width: TEXT_NODE_WIDTH, height: TEXT_NODE_HEIGHT }
}

function absoluteRect(
  node: Node,
  nodeIndex: ReadonlyMap<string, Node>,
): Rect {
  const size = inferNodeSize(node)
  let x = node.position.x
  let y = node.position.y
  let cur = node.parentId ? nodeIndex.get(node.parentId) : undefined
  const seen = new Set<string>([node.id])

  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    x += cur.position.x
    y += cur.position.y
    cur = cur.parentId ? nodeIndex.get(cur.parentId) : undefined
  }

  return { x, y, width: size.width, height: size.height }
}

function center(rect: Rect): { x: number; y: number } {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  }
}

function sideFromHandle(handleId: string | null | undefined): CanvasHandleSide | null {
  if (!handleId) return null
  if (handleId.includes("top")) return "top"
  if (handleId.includes("right")) return "right"
  if (handleId.includes("bottom")) return "bottom"
  if (handleId.includes("left")) return "left"
  return null
}

function pointOnSide(rect: Rect, side: CanvasHandleSide): Point {
  switch (side) {
    case "top":
      return { x: rect.x + rect.width / 2, y: rect.y }
    case "right":
      return { x: rect.x + rect.width, y: rect.y + rect.height / 2 }
    case "bottom":
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height }
    case "left":
      return { x: rect.x, y: rect.y + rect.height / 2 }
  }
}

function sideVector(side: CanvasHandleSide): Point {
  switch (side) {
    case "top":
      return { x: 0, y: -1 }
    case "right":
      return { x: 1, y: 0 }
    case "bottom":
      return { x: 0, y: 1 }
    case "left":
      return { x: -1, y: 0 }
  }
}

function endpointPoints(
  edge: Pick<Edge, "source" | "target" | "sourceHandle" | "targetHandle">,
  nodeIndex: ReadonlyMap<string, Node>,
): {
  source: Point
  target: Point
  sourceSide: CanvasHandleSide
  targetSide: CanvasHandleSide
} | null {
  const source = nodeIndex.get(edge.source)
  const target = nodeIndex.get(edge.target)
  if (!source || !target) return null

  const sourceRect = absoluteRect(source, nodeIndex)
  const targetRect = absoluteRect(target, nodeIndex)
  const sides = preferredSides(source, target, nodeIndex)
  const sourceSide = sideFromHandle(edge.sourceHandle) ?? sides.sourceSide
  const targetSide = sideFromHandle(edge.targetHandle) ?? sides.targetSide

  return {
    source: pointOnSide(sourceRect, sourceSide),
    target: pointOnSide(targetRect, targetSide),
    sourceSide,
    targetSide,
  }
}

function inflate(rect: Rect, padding: number): Rect {
  return {
    x: rect.x - padding,
    y: rect.y - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
  }
}

function pointInsideRect(point: Point, rect: Rect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  )
}

function segmentIntersectsRect(a: Point, b: Point, rect: Rect): boolean {
  if (pointInsideRect(a, rect) || pointInsideRect(b, rect)) return true

  const minX = Math.min(a.x, b.x)
  const maxX = Math.max(a.x, b.x)
  const minY = Math.min(a.y, b.y)
  const maxY = Math.max(a.y, b.y)
  if (
    maxX < rect.x ||
    minX > rect.x + rect.width ||
    maxY < rect.y ||
    minY > rect.y + rect.height
  ) {
    return false
  }

  if (a.x === b.x) return a.x >= rect.x && a.x <= rect.x + rect.width
  if (a.y === b.y) return a.y >= rect.y && a.y <= rect.y + rect.height

  const edges: Array<[Point, Point]> = [
    [
      { x: rect.x, y: rect.y },
      { x: rect.x + rect.width, y: rect.y },
    ],
    [
      { x: rect.x + rect.width, y: rect.y },
      { x: rect.x + rect.width, y: rect.y + rect.height },
    ],
    [
      { x: rect.x + rect.width, y: rect.y + rect.height },
      { x: rect.x, y: rect.y + rect.height },
    ],
    [
      { x: rect.x, y: rect.y + rect.height },
      { x: rect.x, y: rect.y },
    ],
  ]

  return edges.some(([c, d]) => segmentsIntersect(a, b, c, d))
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const ccw = (p1: Point, p2: Point, p3: Point) =>
    (p3.y - p1.y) * (p2.x - p1.x) > (p2.y - p1.y) * (p3.x - p1.x)
  return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d)
}

function routeLabel(points: Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 }
  if (points.length === 1) return points[0]

  const lengths: number[] = []
  let total = 0
  for (let i = 1; i < points.length; i += 1) {
    const length = Math.hypot(
      points[i].x - points[i - 1].x,
      points[i].y - points[i - 1].y,
    )
    lengths.push(length)
    total += length
  }
  if (total === 0) return points[Math.floor(points.length / 2)]

  let walked = 0
  const midpoint = total / 2
  for (let i = 1; i < points.length; i += 1) {
    const segmentLength = lengths[i - 1]
    if (walked + segmentLength >= midpoint) {
      const t = (midpoint - walked) / segmentLength
      return {
        x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
        y: points[i - 1].y + (points[i].y - points[i - 1].y) * t,
      }
    }
    walked += segmentLength
  }
  return points[points.length - 1]
}

function compactPoints(points: Point[]): Point[] {
  const deduped = points.filter(
    (point, index) =>
      index === 0 ||
      point.x !== points[index - 1].x ||
      point.y !== points[index - 1].y,
  )
  return deduped.filter((point, index) => {
    if (index === 0 || index === deduped.length - 1) return true
    const prev = deduped[index - 1]
    const next = deduped[index + 1]
    return !(
      (prev.x === point.x && point.x === next.x) ||
      (prev.y === point.y && point.y === next.y)
    )
  })
}

function midpointForEdge(
  edge: Pick<Edge, "source" | "target">,
  nodeIndex: ReadonlyMap<string, Node>,
): { x: number; y: number; dx: number; dy: number } | null {
  const source = nodeIndex.get(edge.source)
  const target = nodeIndex.get(edge.target)
  if (!source || !target) return null

  const s = center(absoluteRect(source, nodeIndex))
  const t = center(absoluteRect(target, nodeIndex))
  return {
    x: (s.x + t.x) / 2,
    y: (s.y + t.y) / 2,
    dx: t.x - s.x,
    dy: t.y - s.y,
  }
}

function preferredSides(
  source: Node,
  target: Node,
  nodeIndex: ReadonlyMap<string, Node>,
): { sourceSide: CanvasHandleSide; targetSide: CanvasHandleSide } {
  const s = center(absoluteRect(source, nodeIndex))
  const t = center(absoluteRect(target, nodeIndex))
  const dx = t.x - s.x
  const dy = t.y - s.y

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceSide: "right", targetSide: "left" }
      : { sourceSide: "left", targetSide: "right" }
  }

  return dy >= 0
    ? { sourceSide: "bottom", targetSide: "top" }
    : { sourceSide: "top", targetSide: "bottom" }
}

function edgeObstacles(
  edge: Pick<Edge, "source" | "target">,
  nodeIndex: ReadonlyMap<string, Node>,
): Rect[] {
  const obstacles: Rect[] = []
  for (const node of nodeIndex.values()) {
    if (node.id === edge.source || node.id === edge.target) continue
    if (node.type === SYSTEM_GROUP_TYPE) continue
    obstacles.push(inflate(absoluteRect(node, nodeIndex), OBSTACLE_PADDING))
  }
  return obstacles
}

function nearestHorizontalLane(referenceY: number, above: number, below: number) {
  return Math.abs(referenceY - above) <= Math.abs(referenceY - below)
    ? above
    : below
}

function nearestVerticalLane(referenceX: number, left: number, right: number) {
  return Math.abs(referenceX - left) <= Math.abs(referenceX - right)
    ? left
    : right
}

function buildObstacleRoute(
  edge: Pick<Edge, "source" | "target" | "sourceHandle" | "targetHandle">,
  nodeIndex: ReadonlyMap<string, Node>,
): EdgeRoute {
  const endpoints = endpointPoints(edge, nodeIndex)
  if (!endpoints) return null

  const { source, sourceSide, target, targetSide } = endpoints
  const obstacles = edgeObstacles(edge, nodeIndex).filter((rect) =>
    segmentIntersectsRect(source, target, rect),
  )
  if (obstacles.length === 0) return null

  const sourceOut = sideVector(sourceSide)
  const targetOut = sideVector(targetSide)
  const sourceStub = {
    x: source.x + sourceOut.x * ROUTE_STUB,
    y: source.y + sourceOut.y * ROUTE_STUB,
  }
  const targetStub = {
    x: target.x + targetOut.x * ROUTE_STUB,
    y: target.y + targetOut.y * ROUTE_STUB,
  }
  const dx = target.x - source.x
  const dy = target.y - source.y

  if (Math.abs(dx) >= Math.abs(dy)) {
    const above = Math.min(...obstacles.map((rect) => rect.y)) - ROUTE_CLEARANCE
    const below =
      Math.max(...obstacles.map((rect) => rect.y + rect.height)) +
      ROUTE_CLEARANCE
    const left =
      Math.min(source.x, target.x, ...obstacles.map((rect) => rect.x)) -
      ROUTE_CLEARANCE
    const right =
      Math.max(
        source.x,
        target.x,
        ...obstacles.map((rect) => rect.x + rect.width),
      ) + ROUTE_CLEARANCE

    if (sourceOut.y !== 0 && targetOut.y !== 0 && sourceOut.y !== targetOut.y) {
      const connectorX = nearestVerticalLane(sourceStub.x, left, right)
      const points = compactPoints([
        source,
        sourceStub,
        { x: connectorX, y: sourceStub.y },
        { x: connectorX, y: targetStub.y },
        targetStub,
        target,
      ])
      return { points: points.slice(1, -1), label: routeLabel(points) }
    }

    const routeY =
      sourceOut.y > 0
        ? below
        : sourceOut.y < 0
          ? above
          : targetOut.y > 0
            ? below
            : targetOut.y < 0
              ? above
              : nearestHorizontalLane(source.y, above, below)
    const points = compactPoints([
      source,
      sourceStub,
      { x: sourceStub.x, y: routeY },
      { x: targetStub.x, y: routeY },
      targetStub,
      target,
    ])
    return { points: points.slice(1, -1), label: routeLabel(points) }
  }

  const left = Math.min(...obstacles.map((rect) => rect.x)) - ROUTE_CLEARANCE
  const right =
    Math.max(...obstacles.map((rect) => rect.x + rect.width)) +
    ROUTE_CLEARANCE
  const above =
    Math.min(source.y, target.y, ...obstacles.map((rect) => rect.y)) -
    ROUTE_CLEARANCE
  const below =
    Math.max(
      source.y,
      target.y,
      ...obstacles.map((rect) => rect.y + rect.height),
    ) + ROUTE_CLEARANCE

  if (sourceOut.x !== 0 && targetOut.x !== 0 && sourceOut.x !== targetOut.x) {
    const connectorY = nearestHorizontalLane(sourceStub.y, above, below)
    const points = compactPoints([
      source,
      sourceStub,
      { x: sourceStub.x, y: connectorY },
      { x: targetStub.x, y: connectorY },
      targetStub,
      target,
    ])
    return { points: points.slice(1, -1), label: routeLabel(points) }
  }

  const routeX =
    sourceOut.x > 0
      ? right
      : sourceOut.x < 0
        ? left
        : targetOut.x > 0
          ? right
          : targetOut.x < 0
            ? left
            : nearestVerticalLane(source.x, left, right)
  const points = compactPoints([
    source,
    sourceStub,
    { x: routeX, y: sourceStub.y },
    { x: routeX, y: targetStub.y },
    targetStub,
    target,
  ])
  return { points: points.slice(1, -1), label: routeLabel(points) }
}

export function getPreferredEdgeHandles(
  edge: Pick<Edge, "source" | "target">,
  nodes: Node[],
): { sourceHandle: string; targetHandle: string } | null {
  const nodeIndex = new Map(nodes.map((node) => [node.id, node]))
  const source = nodeIndex.get(edge.source)
  const target = nodeIndex.get(edge.target)
  if (!source || !target) return null

  const { sourceSide, targetSide } = preferredSides(source, target, nodeIndex)
  return {
    sourceHandle: SOURCE_HANDLE_IDS[sourceSide],
    targetHandle: TARGET_HANDLE_IDS[targetSide],
  }
}

export function routeEdgeToNearestHandles(edge: Edge, nodes: Node[]): Edge {
  const handles = getPreferredEdgeHandles(edge, nodes)
  if (!handles) return edge
  if (
    edge.sourceHandle === handles.sourceHandle &&
    edge.targetHandle === handles.targetHandle
  ) {
    return edge
  }
  return { ...edge, ...handles }
}

export function edgeNeedsRouting(edge: Edge): boolean {
  return !edge.sourceHandle || !edge.targetHandle
}

export function routeEdges(
  edges: Edge[],
  nodes: Node[],
  options: { rerouteHandles?: boolean; assignLabelOffsets?: boolean } = {},
): Edge[] {
  const nodeIndex = new Map(nodes.map((node) => [node.id, node]))
  const rerouteHandles = options.rerouteHandles ?? false
  const assignLabelOffsets = options.assignLabelOffsets ?? true

  let routed = edges.map((edge) => {
    if (!rerouteHandles && !edgeNeedsRouting(edge)) return edge
    const handles = getPreferredEdgeHandles(edge, nodes)
    if (!handles) return edge
    return { ...edge, ...handles }
  })

  const routesById = new Map<string, EdgeRoute>()
  routed = routed.map((edge) => {
    const route = buildObstacleRoute(edge, nodeIndex)
    routesById.set(edge.id, route)

    const data = (edge.data ?? {}) as Record<string, unknown>
    const {
      _routePoints: _dropPoints,
      _routeLabel: _dropLabel,
      ...rest
    } = data
    void _dropPoints
    void _dropLabel

    if (!route) {
      if (data._routePoints === undefined && data._routeLabel === undefined) {
        return edge
      }
      return { ...edge, data: rest }
    }

    return {
      ...edge,
      data: {
        ...rest,
        _routePoints: route.points,
        _routeLabel: route.label,
      },
    }
  })

  if (!assignLabelOffsets) return routed

  const buckets = new Map<string, Edge[]>()
  for (const edge of routed) {
    const route = routesById.get(edge.id)
    const mid = route
      ? { ...route.label, dx: 0, dy: 0 }
      : midpointForEdge(edge, nodeIndex)
    if (!mid) continue
    const key = `${Math.round(mid.x / 96)}:${Math.round(mid.y / 56)}`
    const list = buckets.get(key) ?? []
    list.push(edge)
    buckets.set(key, list)
  }

  const offsetsById = new Map<string, EdgeLabelOffset>()
  for (const bucket of buckets.values()) {
    if (bucket.length === 1) {
      offsetsById.set(bucket[0].id, { x: 0, y: 0 })
      continue
    }

    const sorted = [...bucket].sort((a, b) => a.id.localeCompare(b.id))
    sorted.forEach((edge, index) => {
      const route = routesById.get(edge.id)
      const mid = route
        ? { ...route.label, dx: 0, dy: 0 }
        : midpointForEdge(edge, nodeIndex)
      if (!mid) return
      const length = Math.hypot(mid.dx, mid.dy) || 1
      const normal =
        mid.dx === 0 && mid.dy === 0
          ? { x: 0, y: 1 }
          : { x: -mid.dy / length, y: mid.dx / length }
      const centeredIndex = index - (sorted.length - 1) / 2
      const distance = centeredIndex * 34
      offsetsById.set(edge.id, {
        x: Math.round(normal.x * distance),
        y: Math.round(normal.y * distance),
      })
    })
  }

  routed = routed.map((edge) => {
    const offset = offsetsById.get(edge.id) ?? { x: 0, y: 0 }
    const data = (edge.data ?? {}) as Record<string, unknown>
    const current = data._labelOffset as EdgeLabelOffset | undefined
    if (current?.x === offset.x && current?.y === offset.y) return edge
    return {
      ...edge,
      data: {
        ...data,
        _labelOffset: offset,
      },
    }
  })

  return routed
}
