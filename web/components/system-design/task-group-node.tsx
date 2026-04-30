"use client"

import { NodeResizer, type NodeProps } from "@xyflow/react"
import { ClipboardListIcon, UserIcon } from "lucide-react"
import { memo } from "react"

import { cn } from "@/lib/utils"

import {
  TASK_BOUNDARY_COLOR_STYLES,
  resolveBoundaryColor,
  type SystemTaskGroupData,
  type TaskStatus,
} from "./types"

const STATUS_LABEL: Record<TaskStatus, string> = {
  "todo": "Todo",
  "in-progress": "In progress",
  "done": "Done",
  "blocked": "Blocked",
}

const STATUS_DOT: Record<TaskStatus, string> = {
  "todo": "bg-muted-foreground/50",
  "in-progress": "bg-amber-500",
  "done": "bg-emerald-500",
  "blocked": "bg-red-500",
}

/**
 * Task group — a coloured boundary box assigned to a teammate.
 *
 * Visually distinct from the generic `SystemGroupNode`:
 * - Solid (rather than dashed) border so it reads as a deliberate task region.
 * - Always shows assignee + status chips in the top-right when set.
 * - No connection handles — task groups describe ownership, not data flow.
 * - Renders behind every other node (`zIndex: -1` set in `collab-flow.tsx`)
 *   so icons sit on top and the colour acts as a backdrop.
 *
 * Children are NOT parented to task groups (the canvas drop handler ignores
 * them in `findGroupAtPosition`). This keeps task groups purely visual: an
 * icon can be moved freely without dragging "its" task region around.
 */
function SystemTaskGroupNodeBase({
  data,
  selected,
}: NodeProps & { data: SystemTaskGroupData }) {
  const label = data.label ?? "Task"
  const colorKey = resolveBoundaryColor(data.color)
  const styles = TASK_BOUNDARY_COLOR_STYLES[colorKey]
  const assignee = data.assignee ?? null
  const status = data.status

  return (
    <div
      className={cn(
        "group relative h-full w-full rounded-2xl border-2 transition-colors",
        styles.fill,
        selected
          ? cn(styles.borderSelected, "ring-1 ring-foreground/20")
          : cn(styles.border, "hover:border-foreground/50")
      )}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={200}
        minHeight={140}
        lineClassName="!border-foreground/30"
        handleClassName="!size-2 !rounded-sm !border !border-background !bg-foreground/40"
      />

      {/* Label chip — sits flush above the top border so the boundary's
          interior is unobstructed by the chip's tail. `top-0 -translate-y-full`
          puts the chip's bottom edge on the border line, with a small gap
          via `-mt-1` so it reads as a header tag rather than touching. */}
      <div className="absolute top-0 left-3 z-10 -translate-y-full -mt-1">
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-[11px] font-medium tracking-wider uppercase",
            "text-muted-foreground transition-colors group-hover:text-foreground",
            selected && "text-foreground"
          )}
        >
          <ClipboardListIcon className="size-3" />
          {label}
        </span>
      </div>

      {/* Assignee + status — top-right, mirrored positioning so the chips
          line up with the label on the same header row above the border. */}
      {(assignee || status) && (
        <div className="absolute top-0 right-3 z-10 flex -translate-y-full -mt-1 items-center gap-1.5">
          {assignee && (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-[11px] font-medium",
                styles.chip
              )}
              title={
                assignee.email
                  ? `Assigned to ${assignee.name} (${assignee.email})`
                  : `Assigned to ${assignee.name}`
              }
            >
              <UserIcon className="size-3" />
              <span className="max-w-[14ch] truncate">{assignee.name}</span>
            </span>
          )}
          {status && (
            <span
              className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-[11px] font-medium"
              title={`Status: ${STATUS_LABEL[status]}`}
            >
              <span className={cn("size-1.5 rounded-full", STATUS_DOT[status])} />
              <span>{STATUS_LABEL[status]}</span>
            </span>
          )}
        </div>
      )}

      {/* Task preview — a soft, centred caption when a task description is set
          but no children obscure it. Keeps the boundary informative even when
          empty. Pointer-events-none so it never steals clicks from icons that
          happen to overlap. */}
      {typeof data.task === "string" && data.task.trim().length > 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6">
          <p className="line-clamp-3 text-center text-xs leading-relaxed text-foreground/70">
            {data.task}
          </p>
        </div>
      )}
    </div>
  )
}

export const SystemTaskGroupNode = memo(SystemTaskGroupNodeBase)
