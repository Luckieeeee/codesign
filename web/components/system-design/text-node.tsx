"use client"

import { type NodeProps } from "@xyflow/react"
import { memo, useCallback, useEffect, useRef, useState } from "react"

import { cn } from "@/lib/utils"

import type { SystemTextData } from "./types"

/**
 * Free-floating text annotation. Used for headings, callouts, region labels.
 * No connection handles — this is decoration, not a participant in the graph.
 *
 * Double-click to edit. Renders nothing (just the empty draft) when text is
 * empty so users can spot the placeholder and remove the node.
 */
function SystemTextNodeBase({
  id,
  data,
  selected,
}: NodeProps & { data: SystemTextData }) {
  const onUpdate = (data as unknown as {
    onUpdate?: (id: string, patch: Partial<SystemTextData>) => void
  }).onUpdate
  const text = data.text ?? ""
  const variant = data.variant ?? "body"

  const [isEditing, setIsEditing] = useState(text === "")
  const [draft, setDraft] = useState(text)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const [seenText, setSeenText] = useState(text)
  if (!isEditing && seenText !== text) {
    setSeenText(text)
    setDraft(text)
  }

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [isEditing])

  const commit = useCallback(() => {
    setIsEditing(false)
    const next = draft
    if (next !== text) onUpdate?.(id, { text: next })
  }, [draft, id, text, onUpdate])

  const sizeClass =
    variant === "heading"
      ? "text-2xl font-semibold tracking-tight"
      : "text-sm"

  return (
    <div
      className={cn(
        "group relative min-w-[140px] max-w-[420px] rounded-lg px-3 py-2 transition-colors",
        selected
          ? "bg-background/90 ring-2 ring-foreground/30"
          : "ring-1 ring-transparent hover:ring-border"
      )}
      onDoubleClick={(e) => {
        e.stopPropagation()
        setIsEditing(true)
      }}
    >
      {isEditing ? (
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            // Enter without shift commits; shift+enter inserts a newline.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              commit()
            } else if (e.key === "Escape") {
              setIsEditing(false)
              setDraft(text)
            }
          }}
          rows={1}
          placeholder={variant === "heading" ? "Heading…" : "Note…"}
          className={cn(
            "nodrag nopan w-full resize-none border-none bg-transparent p-0 outline-none placeholder:text-muted-foreground/60",
            sizeClass,
            "field-sizing-content"
          )}
        />
      ) : (
        <p
          className={cn(
            sizeClass,
            text ? "text-foreground" : "text-muted-foreground italic"
          )}
        >
          {text || "Double-click to edit"}
        </p>
      )}
    </div>
  )
}

export const SystemTextNode = memo(SystemTextNodeBase)
