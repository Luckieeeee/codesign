"use client"

import { Handle, Position, type NodeProps } from "@xyflow/react"
import { memo, useCallback, useEffect, useRef, useState } from "react"

import { cn } from "@/lib/utils"

import type { SystemNodeData } from "./types"

/**
 * A single icon-backed node on the system-design canvas.
 *
 * Visuals: 64×64 icon tile + editable label underneath, plus connection
 * handles on all four sides so users can pull edges in any direction.
 *
 * The label is editable inline (double-click). All other metadata
 * (description, group, etc.) is edited via the right-side inspector.
 */
function SystemIconNodeBase({
  id,
  data,
  selected,
}: NodeProps & { data: SystemNodeData }) {
  const { iconPath, label } = data
  const onUpdate = (data as unknown as {
    onUpdate?: (id: string, patch: Partial<SystemNodeData>) => void
  }).onUpdate

  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState(label)
  const inputRef = useRef<HTMLInputElement>(null)

  // Keep local draft in sync when remote edits land.
  const [seenLabel, setSeenLabel] = useState(label)
  if (!isEditing && seenLabel !== label) {
    setSeenLabel(label)
    setDraft(label)
  }

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [isEditing])

  const commit = useCallback(() => {
    setIsEditing(false)
    const next = draft.trim()
    if (next !== label) onUpdate?.(id, { label: next })
  }, [draft, id, label, onUpdate])

  const cancel = useCallback(() => {
    setIsEditing(false)
    setDraft(label)
  }, [label])

  return (
    <div
      className={cn(
        "group relative flex w-[112px] flex-col items-center gap-1.5 rounded-2xl px-2 py-2 transition-colors",
        // Subtle ring when selected, near-invisible otherwise.
        selected
          ? "ring-2 ring-foreground/40"
          : "ring-1 ring-transparent hover:ring-border"
      )}
      onDoubleClick={(e) => {
        e.stopPropagation()
        setIsEditing(true)
      }}
    >
      {/* Connection handles — invisible by default, hint on hover. */}
      <Handle
        type="target"
        position={Position.Top}
        className={cn(
          "!h-2 !w-2 !border-background !bg-foreground/40 opacity-0 transition-opacity",
          "group-hover:opacity-100"
        )}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className={cn(
          "!h-2 !w-2 !border-background !bg-foreground/40 opacity-0 transition-opacity",
          "group-hover:opacity-100"
        )}
      />
      <Handle
        type="target"
        position={Position.Left}
        id="left-target"
        className={cn(
          "!h-2 !w-2 !border-background !bg-foreground/40 opacity-0 transition-opacity",
          "group-hover:opacity-100"
        )}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="right-source"
        className={cn(
          "!h-2 !w-2 !border-background !bg-foreground/40 opacity-0 transition-opacity",
          "group-hover:opacity-100"
        )}
      />

      <div
        className={cn(
          "relative flex size-16 items-center justify-center rounded-xl border bg-card shadow-sm transition-shadow",
          "group-hover:shadow-md"
        )}
      >
        {/* Plain <img> — Next/Image needs explicit remote/local config and
            our svgs are tiny, static, same-origin. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={iconPath}
          alt={label}
          width={40}
          height={40}
          draggable={false}
          className="pointer-events-none size-10 object-contain"
          // Some monochrome icons rely on currentColor — tint them with the
          // foreground colour so they're visible on light & dark themes.
          style={{ color: "var(--foreground)" }}
        />
      </div>

      {isEditing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit()
            else if (e.key === "Escape") cancel()
          }}
          className="nodrag nopan w-full rounded-md border border-border bg-background px-1.5 py-0.5 text-center text-[11px] font-medium outline-none focus:border-foreground/40"
        />
      ) : (
        <div
          className="line-clamp-2 max-w-full text-center text-[11px] leading-tight font-medium text-foreground/90"
          title={label}
        >
          {label || <span className="text-muted-foreground">Untitled</span>}
        </div>
      )}
    </div>
  )
}

// Memoised — React Flow re-renders every node on most changes; the icon tree
// is heavy enough to want this.
export const SystemIconNode = memo(SystemIconNodeBase)
