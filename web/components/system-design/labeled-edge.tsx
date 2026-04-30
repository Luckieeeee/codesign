"use client"

import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
} from "@xyflow/react"
import { memo } from "react"

import { cn } from "@/lib/utils"

import type { SystemEdgeData } from "./types"

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
}: EdgeProps & { data?: SystemEdgeData }) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 12,
  })

  const method = data?.method
  const label = data?.label
  const endpoint = data?.endpoint
  const hasMeta = Boolean(label || method || endpoint)

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: "var(--muted-foreground)",
          strokeWidth: selected ? 2 : 1.5,
          opacity: selected ? 1 : 0.7,
          ...style,
        }}
        markerEnd={markerEnd}
      />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan absolute"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: "all",
          }}
        >
          {hasMeta ? (
            <div
              className={cn(
                "flex items-center gap-1 rounded-full border bg-background/95 px-2 py-0.5 text-[10px] font-medium shadow-sm backdrop-blur-sm transition-colors",
                selected
                  ? "border-foreground/40 text-foreground"
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
                "rounded-full border border-dashed border-border bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-opacity",
                selected ? "opacity-100" : "opacity-0 hover:opacity-100"
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
