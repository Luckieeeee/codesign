"use client"

import { cn } from "@/lib/utils"

type ActionToolbarProps = {
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
  onAddGroup: () => void
  onAddText: () => void
}

/**
 * Floating bottom-right toolbar.
 *
 * Inspired by the dialog-tree editor's pill toolbar — rounded buttons,
 * shadow-lg for depth against the canvas, monochrome icons. The action set
 * here is tier-1 only: undo/redo + spawn group / text. Auto-layout, AI,
 * and other heavy actions can slot in beside these later.
 */
export function ActionToolbar({
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onAddGroup,
  onAddText,
}: ActionToolbarProps) {
  return (
    <div className="absolute right-6 bottom-6 z-10 flex items-center gap-2">
      <div className="flex items-center gap-1 rounded-full border border-border/60 bg-card px-1 py-1 shadow-lg backdrop-blur-md">
        <ToolbarButton
          label="Undo (⌘Z)"
          onClick={onUndo}
          disabled={!canUndo}
          icon={<UndoGlyph />}
        />
        <ToolbarButton
          label="Redo (⌘⇧Z)"
          onClick={onRedo}
          disabled={!canRedo}
          icon={<RedoGlyph />}
        />
      </div>

      <button
        onClick={onAddText}
        title="Add note"
        className="flex items-center gap-1.5 rounded-full border border-border/60 bg-card px-3.5 py-2 text-sm font-medium text-foreground shadow-lg transition-colors hover:bg-muted"
      >
        <TextGlyph />
        Note
      </button>

      <button
        onClick={onAddGroup}
        title="Add group"
        className="flex items-center gap-1.5 rounded-full bg-foreground px-3.5 py-2 text-sm font-medium text-background shadow-lg transition-colors hover:bg-foreground/90"
      >
        <GroupGlyph />
        Group
      </button>
    </div>
  )
}

function ToolbarButton({
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
        "flex size-7 items-center justify-center rounded-full transition-colors",
        disabled
          ? "cursor-not-allowed text-muted-foreground/40"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
    >
      {icon}
    </button>
  )
}

function UndoGlyph() {
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
      <path d="M3 7v6h6" />
      <path d="M3 13a9 9 0 1 0 3-7.7L3 8" />
    </svg>
  )
}

function RedoGlyph() {
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
