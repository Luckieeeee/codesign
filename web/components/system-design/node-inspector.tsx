"use client"

import { TrashIcon, XIcon } from "lucide-react"
import { useState } from "react"
import type { Node } from "@xyflow/react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

import type { SystemNodeData } from "./types"

type NodeInspectorProps = {
  node: Node
  onPatch: (id: string, patch: Partial<SystemNodeData>) => void
  onDelete: (id: string) => void
  onClose: () => void
}

/**
 * Right-rail inspector for a selected node. Mirrors EdgeInspector — local
 * drafts, commit on blur, single delete action in the footer.
 */
export function NodeInspector({
  node,
  onPatch,
  onDelete,
  onClose,
}: NodeInspectorProps) {
  const data = (node.data as SystemNodeData | undefined) ?? {
    iconId: "",
    iconPath: "",
    iconCategory: "generic",
    label: "",
  }

  const [label, setLabel] = useState(data.label ?? "")
  const [description, setDescription] = useState(data.description ?? "")
  const [group, setGroup] = useState(data.group ?? "")

  // Swap drafts in when the selected node changes. Derived-state pattern
  // because React 19 forbids setState in an effect body.
  const [lastNodeId, setLastNodeId] = useState(node.id)
  if (lastNodeId !== node.id) {
    setLastNodeId(node.id)
    setLabel(data.label ?? "")
    setDescription(data.description ?? "")
    setGroup(data.group ?? "")
  }

  const commit = (patch: Partial<SystemNodeData>) => onPatch(node.id, patch)

  return (
    <div className="flex h-full flex-col">
      <header
        data-drag-handle
        className="flex items-center justify-between border-b border-border px-3 py-2"
      >
        <div className="flex min-w-0 items-center gap-2">
          {data.iconPath && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={data.iconPath}
              alt=""
              className="size-6 shrink-0 object-contain"
              style={{ color: "var(--foreground)" }}
            />
          )}
          <div className="flex min-w-0 flex-col">
            <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
              Node · {String(data.iconCategory ?? "generic")}
            </span>
            <span className="truncate text-sm font-medium">
              {label || "Untitled"}
            </span>
          </div>
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
            onBlur={() => commit({ label: label.trim() })}
            placeholder="API Gateway"
          />
        </Field>

        <Field label="Group">
          <Input
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            onBlur={() => commit({ group: group.trim() })}
            placeholder="frontend / backend / data / infra…"
          />
        </Field>

        <Field label="Description">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => commit({ description })}
            placeholder="What does this component do? Latency, scale, auth model…"
            rows={6}
          />
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
          Delete node
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
