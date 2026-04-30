"use client"

import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from "@xyflow/react"
import {
  memo,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react"

import { cn } from "@/lib/utils"

import type { SystemEdgeData } from "./types"

type SystemEdgeRuntimeData = SystemEdgeData & {
  onSelectEdge?: (id: string) => void
  _highlighted?: boolean
  _selectionActive?: boolean
}

/**
 * The system-design edge.
 *
 * Two visual states:
 *   - With a label / method  → pill rendered at the midpoint, click-through
 *     to select the edge (so the inspector opens).
 *   - Without metadata       → invisible chip that still lets you click the
 *     midpoint to select.
 *
 * All editing happens in the right-side `EdgeInspector`, not on the canvas
 * itself — keeps the canvas tidy when 50+ edges are visible.
 */
function SystemEdgeBase({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  data,
  style,
  markerEnd,
}: EdgeProps & { data?: SystemEdgeRuntimeData }) {
  const routePoints = data?._routePoints ?? []
  const routeLabel = data?._routeLabel
  const [bezierPath, bezierLabelX, bezierLabelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    curvature: 0.28,
  })
  const routedPoints = [
    { x: sourceX, y: sourceY },
    ...routePoints,
    { x: targetX, y: targetY },
  ]
  const edgePath =
    routePoints.length > 0 ? buildRoundedOrthogonalPath(routedPoints) : bezierPath
  const labelX = routeLabel?.x ?? bezierLabelX
  const labelY = routeLabel?.y ?? bezierLabelY

  const method = data?.method
  const label = data?.label
  const endpoint = data?.endpoint
  const hasMeta = Boolean(label || method || endpoint)
  const labelOffset = data?._labelOffset ?? { x: 0, y: 0 }
  const highlighted = selected || data?._highlighted === true
  const selectionActive = data?._selectionActive === true
  const strokeColor = highlighted
    ? "var(--foreground)"
    : "var(--muted-foreground)"
  const strokeWidth = selected ? 3.4 : highlighted ? 2.8 : 1.5
  const opacity = highlighted ? 1 : selectionActive ? 0.32 : 0.65
  // Edges connected to selected/parented nodes can be elevated above 1000 by
  // React Flow, so selected-node labels need to clear that stack explicitly.
  const labelZIndex = highlighted ? 2000 : 10
  const labelOpacity = selectionActive && !highlighted ? 0.38 : 1

  const selectEdge = () => data?.onSelectEdge?.(id)
  const stopPointerPropagation = (event: PointerEvent<HTMLDivElement>) => {
    event.stopPropagation()
  }
  const handleLabelClick = (event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation()
    selectEdge()
  }
  const handleLabelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    event.stopPropagation()
    selectEdge()
  }

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          ...style,
          stroke: strokeColor,
          strokeWidth,
          opacity,
        }}
        markerEnd={markerEnd}
      />
      <EdgeLabelRenderer>
        <div
          role="button"
          tabIndex={0}
          aria-label="Select edge"
          className={cn(
            "nodrag nopan absolute z-10 cursor-pointer outline-none",
            "focus-visible:ring-2 focus-visible:ring-ring/40"
          )}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX + labelOffset.x}px, ${labelY + labelOffset.y}px)`,
            pointerEvents: "all",
            zIndex: labelZIndex,
            opacity: labelOpacity,
          }}
          onPointerDown={stopPointerPropagation}
          onClick={handleLabelClick}
          onKeyDown={handleLabelKeyDown}
        >
          {hasMeta ? (
            <div
              className={cn(
                "flex max-w-[16rem] items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-[10px] font-medium shadow-md ring-2 ring-background transition-colors",
                highlighted
                  ? "border-foreground/50 text-foreground"
                  : "border-border text-foreground/80 hover:border-foreground/30"
              )}
              title={endpoint || label || method}
            >
              {method && (
                <span
                  className={cn(
                    "rounded-full px-1.5 py-px text-[9px] font-semibold tracking-wide tabular-nums",
                    methodPalette(String(method))
                  )}
                >
                  {method}
                </span>
              )}
              {label && <span className="max-w-[12rem] truncate">{label}</span>}
              {!label && endpoint && (
                <span className="max-w-[14rem] truncate font-mono text-[10px]">
                  {endpoint}
                </span>
              )}
            </div>
          ) : (
            <div
              className={cn(
                "rounded-full border border-dashed border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground shadow-sm ring-2 ring-background transition-opacity",
                highlighted ? "opacity-100" : "opacity-0 hover:opacity-100"
              )}
            >
              edit
            </div>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}

export const SystemEdge = memo(SystemEdgeBase)

function buildRoundedOrthogonalPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return ""
  if (points.length === 1) return `M ${points[0].x},${points[0].y}`

  const compact = points.filter(
    (point, index) =>
      index === 0 ||
      point.x !== points[index - 1].x ||
      point.y !== points[index - 1].y,
  )

  let path = `M ${compact[0].x},${compact[0].y}`
  const radius = 14

  for (let i = 1; i < compact.length; i += 1) {
    const current = compact[i]
    const next = compact[i + 1]
    if (!next) {
      path += ` L ${current.x},${current.y}`
      continue
    }

    const prev = compact[i - 1]
    const prevLength = Math.hypot(current.x - prev.x, current.y - prev.y)
    const nextLength = Math.hypot(next.x - current.x, next.y - current.y)
    const r = Math.min(radius, prevLength / 2, nextLength / 2)

    if (r <= 0) {
      path += ` L ${current.x},${current.y}`
      continue
    }

    const before = {
      x: current.x - ((current.x - prev.x) / prevLength) * r,
      y: current.y - ((current.y - prev.y) / prevLength) * r,
    }
    const after = {
      x: current.x + ((next.x - current.x) / nextLength) * r,
      y: current.y + ((next.y - current.y) / nextLength) * r,
    }

    path += ` L ${before.x},${before.y} Q ${current.x},${current.y} ${after.x},${after.y}`
  }

  return path
}

/**
 * Method-coloured chip. Tailwind palette but kept neutral on light/dark —
 * just enough hue to scan a diagram at a glance.
 */
function methodPalette(method: string): string {
  switch (method.toUpperCase()) {
    case "GET":
    case "QUERY":
      return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
    case "POST":
    case "MUTATION":
      return "bg-blue-500/10 text-blue-700 dark:text-blue-300"
    case "PUT":
    case "PATCH":
      return "bg-amber-500/10 text-amber-700 dark:text-amber-300"
    case "DELETE":
      return "bg-rose-500/10 text-rose-700 dark:text-rose-300"
    case "WS":
      return "bg-violet-500/10 text-violet-700 dark:text-violet-300"
    case "GRPC":
      return "bg-cyan-500/10 text-cyan-700 dark:text-cyan-300"
    case "EVENT":
      return "bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300"
    default:
      return "bg-muted text-muted-foreground"
  }
}
