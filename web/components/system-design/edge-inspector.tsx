"use client"

import { ChevronDownIcon, TrashIcon, XIcon } from "lucide-react"
import { useState } from "react"
import type { Edge } from "@xyflow/react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

import { HTTP_METHODS, type SystemEdgeData } from "./types"

type EdgeInspectorProps = {
  edge: Edge
  onPatch: (id: string, patch: Partial<SystemEdgeData>) => void
  onDelete: (id: string) => void
  onClose: () => void
}

/**
 * Right-rail inspector for editing the contract of a selected edge.
 *
 * Holds local draft state so typing isn't gated on Yjs round-trips — every
 * field commits to Yjs onBlur (and method commits immediately on change).
 */
export function EdgeInspector({
  edge,
  onPatch,
  onDelete,
  onClose,
}: EdgeInspectorProps) {
  const data = (edge.data as SystemEdgeData | undefined) ?? {}

  const [label, setLabel] = useState(data.label ?? "")
  const [method, setMethod] = useState(data.method ?? "")
  const [endpoint, setEndpoint] = useState(data.endpoint ?? "")
  const [notes, setNotes] = useState(data.notes ?? "")
  const [request, setRequest] = useState(data.request ?? "")
  const [response, setResponse] = useState(data.response ?? "")

  // When a different edge is selected, swap drafts in. We key on edge.id
  // only — typing into a field shouldn't be clobbered by an echoing Yjs
  // update. Done as derived state (the React 19 "no setState in effect"
  // rule rules out the usual useEffect dance).
  const [lastEdgeId, setLastEdgeId] = useState(edge.id)
  if (lastEdgeId !== edge.id) {
    setLastEdgeId(edge.id)
    setLabel(data.label ?? "")
    setMethod(data.method ?? "")
    setEndpoint(data.endpoint ?? "")
    setNotes(data.notes ?? "")
    setRequest(data.request ?? "")
    setResponse(data.response ?? "")
  }

  const commit = (patch: Partial<SystemEdgeData>) => onPatch(edge.id, patch)

  return (
    <div className="flex h-full flex-col">
      <header
        data-drag-handle
        className="flex items-center justify-between border-b border-border px-3 py-2"
      >
        <div className="flex min-w-0 flex-col">
          <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
            Edge
          </span>
          <span className="truncate text-sm font-medium">
            {label || endpoint || "Untitled connection"}
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
            onBlur={() => commit({ label })}
            placeholder="fetchProject"
          />
        </Field>

        <div className="grid grid-cols-[7rem_1fr] gap-2">
          <Field label="Method">
            <MethodSelect
              value={method}
              onChange={(value) => {
                setMethod(value)
                commit({ method: value })
              }}
            />
          </Field>
          <Field label="Endpoint">
            <Input
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              onBlur={() => commit({ endpoint })}
              placeholder="/api/projects/:id"
              className="font-mono text-[12px]"
            />
          </Field>
        </div>

        <Field label="Notes">
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => commit({ notes })}
            placeholder="What this call does, when it fires, who calls it…"
            rows={3}
          />
        </Field>

        <Field label="Request">
          <Textarea
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            onBlur={() => commit({ request })}
            placeholder='{"projectId": "abc"}'
            rows={4}
            className="font-mono text-[12px]"
          />
        </Field>

        <Field label="Response">
          <Textarea
            value={response}
            onChange={(e) => setResponse(e.target.value)}
            onBlur={() => commit({ response })}
            placeholder='{"id": "abc", "name": "..." }'
            rows={4}
            className="font-mono text-[12px]"
          />
        </Field>
      </div>

      <footer className="flex items-center justify-between border-t border-border px-3 py-2">
        <span className="font-mono text-[10px] text-muted-foreground/60">
          {edge.id}
        </span>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => onDelete(edge.id)}
        >
          <TrashIcon className="size-3.5" />
          Delete edge
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

/**
 * Plain native <select> styled to match base-ui inputs. We avoid the
 * shadcn/base-ui select here because its portal sometimes fights with React
 * Flow's own portals when both are mounted in panels.
 */
function MethodSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "h-8 w-full appearance-none rounded-lg border border-input bg-transparent px-2.5 pr-7 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
          "dark:bg-input/30"
        )}
      >
        <option value="">—</option>
        {HTTP_METHODS.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
    </div>
  )
}
