"use client"

import { TrashIcon, XIcon } from "lucide-react"
import { useState } from "react"
import type { Node } from "@xyflow/react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

import type { SystemGroupData, SystemTextData } from "./types"
import {
  BOUNDARY_COLORS,
  BOUNDARY_COLOR_STYLES,
  SYSTEM_GROUP_TYPE,
  SYSTEM_TEXT_TYPE,
  resolveBoundaryColor,
} from "./types"

type Props = {
  node: Node
  onPatchGroup: (id: string, patch: Partial<SystemGroupData>) => void
  onPatchText: (id: string, patch: Partial<SystemTextData>) => void
  onDelete: (id: string) => void
  onClose: () => void
}

/**
 * Inspector shared by group + text nodes. Both are simple enough that a
 * single component covers them, switched by `node.type`.
 */
export function ContainerInspector({
  node,
  onPatchGroup,
  onPatchText,
  onDelete,
  onClose,
}: Props) {
  if (node.type === SYSTEM_GROUP_TYPE) {
    return (
      <GroupInner
        node={node}
        onPatch={onPatchGroup}
        onDelete={onDelete}
        onClose={onClose}
      />
    )
  }
  if (node.type === SYSTEM_TEXT_TYPE) {
    return (
      <TextInner
        node={node}
        onPatch={onPatchText}
        onDelete={onDelete}
        onClose={onClose}
      />
    )
  }
  return null
}

function GroupInner({
  node,
  onPatch,
  onDelete,
  onClose,
}: {
  node: Node
  onPatch: (id: string, patch: Partial<SystemGroupData>) => void
  onDelete: (id: string) => void
  onClose: () => void
}) {
  const data = (node.data as SystemGroupData) ?? { label: "" }
  const [label, setLabel] = useState(data.label ?? "")
  const colorKey = resolveBoundaryColor(data.color)

  // Reset draft when the selected group changes (derived-state pattern).
  const [lastId, setLastId] = useState(node.id)
  if (lastId !== node.id) {
    setLastId(node.id)
    setLabel(data.label ?? "")
  }

  return (
    <div className="flex h-full flex-col">
      <header
        data-drag-handle
        className="flex items-center justify-between border-b border-border px-3 py-2"
      >
        <div className="flex flex-col">
          <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
            Container · Group
          </span>
          <span className="truncate text-sm font-medium">
            {label || "Untitled group"}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label="Close inspector"
        >
          <XIcon className="size-3.5" />
        </Button>
      </header>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-3">
        <Field label="Label">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={() => onPatch(node.id, { label: label.trim() })}
            placeholder="Backend services"
          />
        </Field>

        <Field label="Background colour">
          <div className="flex flex-wrap gap-1.5">
            {BOUNDARY_COLORS.map((c) => {
              const styles = BOUNDARY_COLOR_STYLES[c]
              const isActive = c === colorKey
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => onPatch(node.id, { color: c })}
                  aria-label={`Set boundary colour to ${c}`}
                  aria-pressed={isActive}
                  title={c}
                  className={cn(
                    "size-6 rounded-md border-2 transition-all",
                    styles.fill,
                    isActive
                      ? cn(styles.borderSelected, "ring-2 ring-foreground/30")
                      : cn(styles.border, "hover:scale-110")
                  )}
                />
              )
            })}
          </div>
        </Field>

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Drop icons inside the dashed box to nest them. Drag the corners to
          resize. Children move with the group. For task assignments, use
          a Task Group instead.
        </p>
      </div>

      <footer className="flex items-center justify-between border-t border-border px-3 py-2">
        <span className="font-mono text-[10px] text-muted-foreground/60">
          {node.id}
        </span>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => onDelete(node.id)}
        >
          <TrashIcon className="size-3.5" />
          Delete group
        </Button>
      </footer>
    </div>
  )
}

function TextInner({
  node,
  onPatch,
  onDelete,
  onClose,
}: {
  node: Node
  onPatch: (id: string, patch: Partial<SystemTextData>) => void
  onDelete: (id: string) => void
  onClose: () => void
}) {
  const data = (node.data as SystemTextData) ?? { text: "" }
  const [text, setText] = useState(data.text ?? "")
  const variant = data.variant ?? "body"

  const [lastId, setLastId] = useState(node.id)
  if (lastId !== node.id) {
    setLastId(node.id)
    setText(data.text ?? "")
  }

  return (
    <div className="flex h-full flex-col">
      <header
        data-drag-handle
        className="flex items-center justify-between border-b border-border px-3 py-2"
      >
        <div className="flex flex-col">
          <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
            Container · Text
          </span>
          <span className="truncate text-sm font-medium">
            {text || "Untitled note"}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label="Close inspector"
        >
          <XIcon className="size-3.5" />
        </Button>
      </header>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-3">
        <Field label="Text">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => onPatch(node.id, { text })}
            rows={6}
            className="rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          />
        </Field>

        <Field label="Style">
          <div className="flex gap-1">
            {(["heading", "body"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => onPatch(node.id, { variant: v })}
                className={
                  v === variant
                    ? "rounded-md border border-foreground/40 bg-muted px-2.5 py-1 text-xs font-medium capitalize"
                    : "rounded-md border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground capitalize hover:text-foreground"
                }
              >
                {v}
              </button>
            ))}
          </div>
        </Field>
      </div>

      <footer className="flex items-center justify-between border-t border-border px-3 py-2">
        <span className="font-mono text-[10px] text-muted-foreground/60">
          {node.id}
        </span>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => onDelete(node.id)}
        >
          <TrashIcon className="size-3.5" />
          Delete note
        </Button>
      </footer>
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
        {label}
      </span>
      {children}
    </label>
  )
}
