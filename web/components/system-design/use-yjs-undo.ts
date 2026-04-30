"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import * as Y from "yjs"

/**
 * Wire a `Y.UndoManager` to the project's nodes + edges Y.Maps.
 *
 * Filters by transaction origin so we only undo *local* edits — remote
 * users' changes are never rolled back by a Cmd+Z on this client. The
 * "local" string matches the origin we pass to `ydoc.transact(...)` from
 * the local change handlers.
 *
 * Returns:
 *   - `undo` / `redo` — call these from a keyboard handler / button.
 *   - `canUndo` / `canRedo` — reactive flags for disabled state.
 */
export function useYjsUndo({
  ydoc,
  ynodes,
  yedges,
}: {
  ydoc: Y.Doc
  ynodes: Y.Map<unknown>
  yedges: Y.Map<unknown>
}) {
  const undoManager = useMemo(
    () =>
      new Y.UndoManager([ynodes, yedges], {
        // Group sequential edits within 500ms into a single undo step. Helps
        // when dragging a node — we don't want every position tick to be its
        // own history entry.
        captureTimeout: 500,
        // Only track our local-origin transactions. Anything else (remote
        // sync messages, server seeds) is left alone.
        trackedOrigins: new Set(["local", "delete-node", "duplicate"]),
      }),
    [ynodes, yedges]
  )

  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  useEffect(() => {
    const update = () => {
      setCanUndo(undoManager.undoStack.length > 0)
      setCanRedo(undoManager.redoStack.length > 0)
    }
    undoManager.on("stack-item-added", update)
    undoManager.on("stack-item-popped", update)
    undoManager.on("stack-cleared", update)
    return () => {
      undoManager.off("stack-item-added", update)
      undoManager.off("stack-item-popped", update)
      undoManager.off("stack-cleared", update)
      undoManager.destroy()
    }
  }, [undoManager])

  // Expose stable ref-backed callbacks so consumers can put `undo`/`redo`
  // into a keyboard shortcut effect dep array without re-binding handlers
  // every time the manager updates internal state.
  const undoRef = useRef(() => undoManager.undo())
  const redoRef = useRef(() => undoManager.redo())
  useEffect(() => {
    undoRef.current = () => undoManager.undo()
    redoRef.current = () => undoManager.redo()
  }, [undoManager])

  const undo = () => undoRef.current()
  const redo = () => redoRef.current()

  // Keep `ydoc` in the closure so consumers that also need the doc can pull
  // a stable reference via this hook (avoids a separate prop drill).
  void ydoc

  return { undo, redo, canUndo, canRedo }
}
