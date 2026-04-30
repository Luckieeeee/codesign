"use client"

import { useEffect } from "react"

type Handler = (event: KeyboardEvent) => void

type Options = {
  onUndo?: Handler
  onRedo?: Handler
  /** Cmd/Ctrl+D — duplicate current selection. */
  onDuplicate?: Handler
  /** Cmd/Ctrl+A — select all on the canvas. */
  onSelectAll?: Handler
  /** Cmd/Ctrl+L — auto-layout the entire canvas. */
  onAutoLayout?: Handler
  /** Esc — clear selection / close inspector. */
  onEscape?: Handler
}

/**
 * Window-scoped keyboard shortcuts for the canvas.
 *
 * - Skips events when the user is typing into an input/textarea/contenteditable
 *   so Cmd+A doesn't steal "select all my text" inside the inspector.
 * - Delete/Backspace are intentionally NOT handled here — React Flow already
 *   removes selected nodes/edges via its own `deleteKeyCode` and our
 *   onNodesChange/onEdgesChange handlers sync that to Yjs.
 */
export function useFlowKeyboard({
  onUndo,
  onRedo,
  onDuplicate,
  onSelectAll,
  onAutoLayout,
  onEscape,
}: Options) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const inEditable =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)

      const mod = e.metaKey || e.ctrlKey

      if (e.key === "Escape") {
        // Esc fires regardless of focus — that's how users expect to bail
        // out of an inspector field too.
        onEscape?.(e)
        return
      }

      if (inEditable) return

      if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault()
        if (e.shiftKey) onRedo?.(e)
        else onUndo?.(e)
        return
      }
      if (mod && (e.key === "y" || e.key === "Y")) {
        // Windows-style redo.
        e.preventDefault()
        onRedo?.(e)
        return
      }
      if (mod && (e.key === "d" || e.key === "D")) {
        e.preventDefault()
        onDuplicate?.(e)
        return
      }
      if (mod && (e.key === "a" || e.key === "A")) {
        e.preventDefault()
        onSelectAll?.(e)
        return
      }
      if (mod && (e.key === "l" || e.key === "L")) {
        e.preventDefault()
        onAutoLayout?.(e)
        return
      }
    }

    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [onUndo, onRedo, onDuplicate, onSelectAll, onAutoLayout, onEscape])
}
