"use client"

import {
  AlignHorizontalSpaceAround,
  Group,
  Redo2,
  Type,
  Undo2,
} from "lucide-react"

import { cn } from "@/lib/utils"

type ActionToolbarProps = {
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
  onAddGroup: () => void
  onAddText: () => void
  onAutoLayout: () => void
  canAutoLayout: boolean
}

/**
 * Floating bottom-right toolbar.
 *
 * Inspired by the dialog-tree editor's pill toolbar — rounded buttons,
 * shadow-lg for depth against the canvas, monochrome icons. The action set
 * here is tier-1 only: undo/redo + spawn group / text + auto-layout. AI
 * and other heavy actions can slot in beside these later.
 */
export function ActionToolbar({
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onAddGroup,
  onAddText,
  onAutoLayout,
  canAutoLayout,
}: ActionToolbarProps) {
  return (
    <div className="absolute right-6 bottom-6 z-10 flex items-center gap-2">
      <div className="flex items-center gap-1 rounded-full border border-border/60 bg-card px-1 py-1 shadow-lg backdrop-blur-md">
        <ToolbarButton
          label="Undo (⌘Z)"
          onClick={onUndo}
          disabled={!canUndo}
          icon={<Undo2 className="size-3.5" />}
        />
        <ToolbarButton
          label="Redo (⌘⇧Z)"
          onClick={onRedo}
          disabled={!canRedo}
          icon={<Redo2 className="size-3.5" />}
        />
        <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />
        <ToolbarButton
          label="Auto-layout (⌘L)"
          onClick={onAutoLayout}
          disabled={!canAutoLayout}
          icon={<AlignHorizontalSpaceAround className="size-3.5" />}
        />
      </div>

      <button
        onClick={onAddText}
        title="Add note"
        className="flex items-center gap-1.5 rounded-full border border-border/60 bg-card px-3.5 py-2 text-sm font-medium text-foreground shadow-lg transition-colors hover:bg-muted"
      >
        <Type className="size-3.5" />
        Note
      </button>

      <button
        onClick={onAddGroup}
        title="Add group"
        className="flex items-center gap-1.5 rounded-full bg-foreground px-3.5 py-2 text-sm font-medium text-background shadow-lg transition-colors hover:bg-foreground/90"
      >
        <Group className="size-3.5" />
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
