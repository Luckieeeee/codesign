"use client"

import { Group } from "lucide-react"

import { cn } from "@/lib/utils"

import { TASK_VISIBILITY_OPTIONS, type TaskVisibility } from "./types"

type ActionToolbarProps = {
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
  onAddGroup: () => void
  onAddText: () => void
  onAddTaskGroup: () => void
  onAutoLayout: () => void
  canAutoLayout: boolean
  taskVisibility: TaskVisibility
  onChangeTaskVisibility: (next: TaskVisibility) => void
}

const TASK_VISIBILITY_LABEL: Record<TaskVisibility, string> = {
  all: "All",
  mine: "Mine",
  none: "None",
}

const TASK_VISIBILITY_TITLE: Record<TaskVisibility, string> = {
  all: "Showing every task region",
  mine: "Showing only tasks assigned to you",
  none: "Hiding all task regions",
}

/**
 * Floating bottom-right command bar.
 *
 * Inspired by OpenAI's recent design language (Codex CLI, GPT-5 composer):
 * one unified surface with hairline internal dividers, restrained
 * typography, a muted-track segmented control, and exactly one accent
 * button for the primary "+ Group" action. This replaces the previous row
 * of four heavily-shadowed floating pills.
 */
export function ActionToolbar({
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onAddGroup,
  onAddText,
  onAddTaskGroup,
  onAutoLayout,
  canAutoLayout,
  taskVisibility,
  onChangeTaskVisibility,
}: ActionToolbarProps) {
  return (
    <div
      role="toolbar"
      aria-label="Canvas actions"
      className={cn(
        "absolute right-6 bottom-6 z-10 flex h-10 items-center gap-0.5 rounded-xl",
        "border border-black/[0.06] bg-card/95 p-1 shadow-sm backdrop-blur-md",
        "dark:border-white/10",
      )}
    >
      {/* History */}
      <IconButton
        label="Undo (⌘Z)"
        onClick={onUndo}
        disabled={!canUndo}
        icon={<UndoGlyph />}
      />
      <IconButton
        label="Redo (⌘⇧Z)"
        onClick={onRedo}
        disabled={!canRedo}
        icon={<RedoGlyph />}
      />

      <Divider />

      {/* Auto-layout */}
      <IconButton
        label="Auto-layout (⌘L)"
        onClick={onAutoLayout}
        disabled={!canAutoLayout}
        icon={<LayoutGlyph />}
      />

      <Divider />

      {/* Task visibility — local view filter, doesn't affect collaborators. */}
      <SegmentedControl
        ariaLabel="Task visibility"
        value={taskVisibility}
        options={TASK_VISIBILITY_OPTIONS}
        onChange={onChangeTaskVisibility}
        renderLabel={(opt) => TASK_VISIBILITY_LABEL[opt]}
        renderTitle={(opt) => TASK_VISIBILITY_TITLE[opt]}
      />

      <Divider />

      {/* Spawn — secondary actions */}
      <TextButton onClick={onAddText} title="Add note" icon={<TextGlyph />}>
        Note
      </TextButton>
      <TextButton
        onClick={onAddTaskGroup}
        title="Add task group"
        icon={<TaskGlyph />}
      >
        Task
      </TextButton>

      {/* Primary — the only accent in the bar. */}
      <button
        type="button"
        onClick={onAddGroup}
        title="Add group"
        className={cn(
          "ml-0.5 flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium",
          "bg-foreground text-background transition-colors hover:bg-foreground/90",
        )}
      >
        <Group className="size-3.5" />
        Group
      </button>
    </div>
  )
}

function Divider() {
  return (
    <span
      aria-hidden
      className="mx-0.5 h-5 w-px bg-border/70 dark:bg-white/10"
    />
  )
}

function IconButton({
  label,
  onClick,
  disabled,
  icon,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  icon: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        "flex size-8 items-center justify-center rounded-lg transition-colors",
        disabled
          ? "cursor-not-allowed text-muted-foreground/40"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {icon}
    </button>
  )
}

function TextButton({
  onClick,
  title,
  icon,
  children,
}: {
  onClick: () => void
  title: string
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium",
        "text-foreground/80 transition-colors hover:bg-muted hover:text-foreground",
      )}
    >
      {icon}
      {children}
    </button>
  )
}

/**
 * OpenAI-style segmented control: muted track, white "card" on the active
 * segment with a hairline shadow. Reads cleanly at small sizes and avoids
 * the inverted black-pill pattern, which would clash with the primary
 * "+ Group" button living in the same bar.
 */
function SegmentedControl<T extends string>({
  ariaLabel,
  value,
  options,
  onChange,
  renderLabel,
  renderTitle,
}: {
  ariaLabel: string
  value: T
  options: readonly T[]
  onChange: (next: T) => void
  renderLabel: (opt: T) => string
  renderTitle?: (opt: T) => string
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex h-8 items-center gap-0.5 rounded-lg bg-muted/60 p-0.5 dark:bg-white/[0.04]"
    >
      {options.map((option) => {
        const isActive = option === value
        return (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            aria-pressed={isActive}
            title={renderTitle?.(option)}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-all",
              isActive
                ? "bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)] dark:bg-white/10"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {renderLabel(option)}
          </button>
        )
      })}
    </div>
  )
}

function UndoGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 7v6h6" />
      <path d="M3 13a9 9 0 1 0 3-7.7L3 8" />
    </svg>
  )
}

function RedoGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 7v6h-6" />
      <path d="M21 13a9 9 0 1 1-3-7.7L21 8" />
    </svg>
  )
}

function GroupGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect
        x="3"
        y="3"
        width="18"
        height="18"
        rx="2"
        strokeDasharray="3 3"
      />
      <rect x="7" y="7" width="4" height="4" rx="1" />
      <rect x="13" y="13" width="4" height="4" rx="1" />
    </svg>
  )
}

function TaskGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* Clipboard outline + two checked task lines — distinct from the
          dashed-rectangle Group glyph so the two buttons are not confused. */}
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 4h6v3H9z" />
      <path d="M9 12h6" />
      <path d="M9 16h4" />
    </svg>
  )
}

function TextGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 7V5h16v2" />
      <path d="M9 5v14" />
      <path d="M15 5v14" />
      <path d="M7 19h4" />
      <path d="M13 19h4" />
    </svg>
  )
}

function LayoutGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* Three nodes connected left → middle → right + middle → bottom-right */}
      <rect x="2" y="9" width="6" height="6" rx="1.5" />
      <rect x="16" y="3" width="6" height="6" rx="1.5" />
      <rect x="16" y="15" width="6" height="6" rx="1.5" />
      <path d="M8 12 L16 6" />
      <path d="M8 12 L16 18" />
    </svg>
  )
}
