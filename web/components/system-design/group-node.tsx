"use client"

import { Handle, NodeResizer, type NodeProps } from "@xyflow/react"
import { memo, useCallback, useEffect, useRef, useState } from "react"

import { cn } from "@/lib/utils"

import {
  CANVAS_HANDLE_SIDES,
  SOURCE_HANDLE_IDS,
  TARGET_HANDLE_IDS,
  positionForSide,
} from "./edge-routing"
import {
  BOUNDARY_COLOR_STYLES,
  resolveBoundaryColor,
  type SystemGroupData,
} from "./types"

/**
 * Resizable container / boundary node — the *generic* one.
 *
 * Behaves like a plain React Flow group: child nodes (those with
 * `parentId === <thisGroupId>`) move with it and clip to its bounds.
 *
 * Visual: dashed border + low-opacity tinted fill (the `data.color` palette
 * key) + a label chip in the top-left. Connection handles on all four
 * sides so groups themselves can be connected (e.g. "VPC A → VPC B").
 *
 * If you want to assign a region of the canvas to a teammate, use the
 * separate `systemTaskGroup` node type instead — task semantics live there,
 * not here.
 */
function SystemGroupNodeBase({
  id,
  data,
  selected,
}: NodeProps & { data: SystemGroupData }) {
  const onUpdate = (data as unknown as {
    onUpdate?: (id: string, patch: Partial<SystemGroupData>) => void
  }).onUpdate
  const label = data.label ?? "Group"
  const colorKey = resolveBoundaryColor(data.color)
  const styles = BOUNDARY_COLOR_STYLES[colorKey]

  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState(label)
  const inputRef = useRef<HTMLInputElement>(null)

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

  return (
    <div
      className={cn(
        "group relative h-full w-full rounded-2xl border-2 border-dashed transition-colors",
        styles.fill,
        selected
          ? cn(styles.borderSelected, "ring-1 ring-foreground/20")
          : cn(styles.border, "hover:border-foreground/40")
      )}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={160}
        minHeight={120}
        // Match the dashed border colour while resizing.
        lineClassName="!border-foreground/30"
        handleClassName="!size-2 !rounded-sm !border !border-background !bg-foreground/40"
      />

      {/* Side handles, hover-only so they don't clutter when many groups exist. */}
      {CANVAS_HANDLE_SIDES.map((side) => (
        <Handle
          key={`target-${side}`}
          type="target"
          position={positionForSide(side)}
          id={TARGET_HANDLE_IDS[side]}
          className={handleClassName}
        />
      ))}
      {CANVAS_HANDLE_SIDES.map((side) => (
        <Handle
          key={`source-${side}`}
          type="source"
          position={positionForSide(side)}
          id={SOURCE_HANDLE_IDS[side]}
          className={handleClassName}
        />
      ))}

      {/* Label chip — sits inside the top edge so it doesn't shift with
          children. Double-click to rename. */}
      <div
        className="absolute -top-3 left-3 z-10"
        onDoubleClick={(e) => {
          e.stopPropagation()
          setIsEditing(true)
        }}
      >
        {isEditing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit()
              else if (e.key === "Escape") {
                setIsEditing(false)
                setDraft(label)
              }
            }}
            className="nodrag nopan rounded-md border border-border bg-background px-2 py-0.5 text-[11px] font-medium tracking-wider uppercase outline-none focus:border-foreground/40"
          />
        ) : (
          <span
            className={cn(
              "inline-flex items-center rounded-md border border-border bg-background px-2 py-0.5 text-[11px] font-medium tracking-wider uppercase",
              "text-muted-foreground transition-colors group-hover:text-foreground",
              selected && "text-foreground"
            )}
          >
            {label}
          </span>
        )}
      </div>
    </div>
  )
}

export const SystemGroupNode = memo(SystemGroupNodeBase)

const handleClassName =
  "!h-2 !w-2 !border-background !bg-foreground/40 opacity-0 transition-opacity group-hover:opacity-100"
