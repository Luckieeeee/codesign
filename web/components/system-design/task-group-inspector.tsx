"use client"

import { ClipboardListIcon, TrashIcon, XIcon } from "lucide-react"
import { useEffect, useState } from "react"
import type { Node } from "@xyflow/react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select"
import { cn } from "@/lib/utils"

import {
  BOUNDARY_COLORS,
  TASK_BOUNDARY_COLOR_STYLES,
  TASK_STATUSES,
  resolveBoundaryColor,
  type SystemTaskGroupData,
  type TaskAssignee,
  type TaskStatus,
} from "./types"

/**
 * Loaded WorkOS users available as assignees. Fetched lazily by
 * `collab-flow.tsx` and passed in as a prop so this component stays
 * dumb / testable.
 */
export type AssigneeOption = {
  id: string
  name: string
  email: string
}

type Props = {
  node: Node
  /**
   * Members loaded from WorkOS. May be empty while the directory is still
   * loading or if the call failed; we surface a clear empty state in that
   * case rather than blocking the rest of the inspector.
   */
  members: AssigneeOption[]
  membersLoading: boolean
  onPatch: (id: string, patch: Partial<SystemTaskGroupData>) => void
  onDelete: (id: string) => void
  onClose: () => void
}

/**
 * Inspector for `systemTaskGroup` nodes. Distinct from the generic
 * `ContainerInspector` — task groups carry assignee / task / status
 * fields, picked from the WorkOS member directory. Agents are
 * intentionally **not** selectable here.
 */
export function TaskGroupInspector({
  node,
  members,
  membersLoading,
  onPatch,
  onDelete,
  onClose,
}: Props) {
  const data = (node.data as SystemTaskGroupData) ?? { label: "" }
  const [label, setLabel] = useState(data.label ?? "")
  const [task, setTask] = useState(data.task ?? "")
  const colorKey = resolveBoundaryColor(data.color)
  const status: TaskStatus | undefined = data.status
  const assigneeId = data.assignee?.id ?? ""

  // Reset drafts when the selected node changes (derived-state pattern).
  const [lastId, setLastId] = useState(node.id)
  if (lastId !== node.id) {
    setLastId(node.id)
    setLabel(data.label ?? "")
    setTask(data.task ?? "")
  }

  // Self-heal: if the assignee's name in the WorkOS directory has changed
  // since this task was assigned, refresh the denormalised name on the next
  // inspector open. Email kept in sync the same way.
  useEffect(() => {
    if (!data.assignee) return
    const fresh = members.find((m) => m.id === data.assignee?.id)
    if (!fresh) return
    if (
      fresh.name !== data.assignee.name ||
      fresh.email !== data.assignee.email
    ) {
      onPatch(node.id, {
        assignee: { id: fresh.id, name: fresh.name, email: fresh.email },
      })
    }
    // We deliberately depend on the assignee id only — re-running this on
    // every keystroke in the inspector would thrash Yjs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, data.assignee?.id, node.id])

  const handleSelectAssignee = (id: string) => {
    if (id === "") {
      onPatch(node.id, { assignee: null })
      return
    }
    const member = members.find((m) => m.id === id)
    if (!member) return
    const next: TaskAssignee = {
      id: member.id,
      name: member.name,
      email: member.email,
    }
    onPatch(node.id, { assignee: next })
  }

  return (
    <div className="flex h-full flex-col">
      <header
        data-drag-handle
        className="flex items-center justify-between border-b border-border px-3 py-2"
      >
        <div className="flex flex-col">
          <span className="flex items-center gap-1 text-[10px] tracking-wider text-muted-foreground uppercase">
            <ClipboardListIcon className="size-3" />
            Task group
          </span>
          <span className="truncate text-sm font-medium">
            {label || "Untitled task"}
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
            placeholder="Auth migration"
          />
        </Field>

        <Field label="Background colour">
          <div className="flex flex-wrap gap-1.5">
            {BOUNDARY_COLORS.map((c) => {
              const styles = TASK_BOUNDARY_COLOR_STYLES[c]
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

        <Field label="Assignee">
          {membersLoading && members.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              Loading team members…
            </p>
          ) : members.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              No team members available. Add collaborators in WorkOS to
              enable task assignment.
            </p>
          ) : (
            <NativeSelect
              className="w-full"
              value={assigneeId}
              onChange={(e) => handleSelectAssignee(e.target.value)}
            >
              <NativeSelectOption value="">
                — Unassigned —
              </NativeSelectOption>
              {members.map((m) => (
                <NativeSelectOption key={m.id} value={m.id}>
                  {m.name}
                  {m.email && m.name !== m.email ? ` · ${m.email}` : ""}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
        </Field>

        <Field label="Task">
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onBlur={() => onPatch(node.id, { task: task.trim() })}
            rows={4}
            placeholder="What needs to be done in this region?"
            className="rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          />
        </Field>

        <Field label="Status">
          <div className="flex flex-wrap gap-1">
            {TASK_STATUSES.map((s) => {
              const isActive = s === status
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() =>
                    onPatch(node.id, { status: isActive ? undefined : s })
                  }
                  aria-pressed={isActive}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs capitalize transition-colors",
                    isActive
                      ? "border-foreground/40 bg-muted font-medium"
                      : "border-border bg-background text-muted-foreground hover:text-foreground"
                  )}
                >
                  {s.replace("-", " ")}
                </button>
              )
            })}
          </div>
        </Field>

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Task groups render behind every other node, so icons stay on top.
          Use the toolbar visibility toggle to show only your tasks,
          everyone&apos;s tasks, or hide them entirely.
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
          Delete task
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
