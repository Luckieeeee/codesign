"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { cn } from "@/lib/utils"

const PANEL_WIDTH = 340
const MARGIN = 16

type FloatingInspectorProps = {
  /** Stable key — when it changes the panel resets to its default position. */
  panelKey: string
  children: React.ReactNode
  /** Right offset (px) from the canvas edge for the default position. */
  defaultRight?: number
  /** Top offset (px) from the canvas edge for the default position. */
  defaultTop?: number
}

/**
 * Floating, draggable inspector panel.
 *
 * - Anchored top-right of its parent (which should be `relative`) on first
 *   mount, then absolute-positioned.
 * - Drag by any descendant tagged with `data-drag-handle` (the inspector's
 *   `<header>`). Form fields stay clickable.
 * - Resets position when `panelKey` changes — switching between an edge and
 *   a node selection drops the panel back at its anchor so users can find
 *   it again.
 * - Stops short of the viewport edges via `clampPosition`.
 */
export function FloatingInspector({
  panelKey,
  children,
  defaultRight = MARGIN,
  defaultTop = 56,
}: FloatingInspectorProps) {
  const elementRef = useRef<HTMLDivElement | null>(null)

  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null
  )
  const [isDragging, setIsDragging] = useState(false)

  // Reset position whenever the panel switches to a different selection.
  // Done as derived state so we don't render once with stale state before
  // the reset lands.
  const [lastKey, setLastKey] = useState(panelKey)
  if (lastKey !== panelKey) {
    setLastKey(panelKey)
    setPosition(null)
  }

  // Resolve the initial absolute position once we know the parent's size.
  useEffect(() => {
    if (position !== null) return
    const el = elementRef.current
    const parent = el?.offsetParent as HTMLElement | null
    if (!el || !parent) return
    const parentRect = parent.getBoundingClientRect()
    const x = Math.max(MARGIN, parentRect.width - PANEL_WIDTH - defaultRight)
    setPosition({ x, y: defaultTop })
  }, [position, defaultRight, defaultTop])

  // Drag handling lives on the panel root — we only start a drag when the
  // pointerdown originated on a `[data-drag-handle]` element. Pointer
  // events make this work for touch + pen too.
  const dragStartRef = useRef<{
    pointerX: number
    pointerY: number
    originX: number
    originY: number
  } | null>(null)

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement
      // Bail if the user clicked something interactive inside the header.
      if (
        target.closest("button, input, textarea, a, select, [role='button']")
      )
        return
      if (!target.closest("[data-drag-handle]")) return

      const el = elementRef.current
      if (!el || !position) return
      event.preventDefault()
      el.setPointerCapture(event.pointerId)
      dragStartRef.current = {
        pointerX: event.clientX,
        pointerY: event.clientY,
        originX: position.x,
        originY: position.y,
      }
      setIsDragging(true)
    },
    [position]
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const start = dragStartRef.current
      if (!start) return
      const el = elementRef.current
      const parent = el?.offsetParent as HTMLElement | null
      if (!el || !parent) return
      const parentRect = parent.getBoundingClientRect()
      const dx = event.clientX - start.pointerX
      const dy = event.clientY - start.pointerY
      setPosition(
        clampPosition(
          { x: start.originX + dx, y: start.originY + dy },
          parentRect.width,
          parentRect.height,
          el.offsetWidth,
          el.offsetHeight
        )
      )
    },
    []
  )

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragStartRef.current) return
      elementRef.current?.releasePointerCapture(event.pointerId)
      dragStartRef.current = null
      setIsDragging(false)
    },
    []
  )

  // Re-clamp on parent resize so the panel never escapes the viewport.
  useEffect(() => {
    const el = elementRef.current
    const parent = el?.offsetParent as HTMLElement | null
    if (!el || !parent) return
    const observer = new ResizeObserver(() => {
      setPosition((prev) => {
        if (!prev) return prev
        const parentRect = parent.getBoundingClientRect()
        return clampPosition(
          prev,
          parentRect.width,
          parentRect.height,
          el.offsetWidth,
          el.offsetHeight
        )
      })
    })
    observer.observe(parent)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={elementRef}
      style={{
        position: "absolute",
        left: position?.x ?? -9999,
        top: position?.y ?? -9999,
        width: PANEL_WIDTH,
        // Hide until the first measure lands so users never see the (0, 0) flash.
        opacity: position ? 1 : 0,
      }}
      className={cn(
        "z-30 flex max-h-[calc(100%-2rem)] flex-col overflow-hidden",
        "rounded-xl border border-border/70 bg-background shadow-xl backdrop-blur-md",
        "transition-shadow",
        isDragging && "shadow-2xl ring-1 ring-foreground/10"
      )}
      onPointerDown={(event) => {
        // Stop propagation so React Flow doesn't treat the click as a
        // pane-click (which would deselect on every interaction inside the
        // panel), then run our own drag-start logic.
        event.stopPropagation()
        onPointerDown(event)
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  )
}

function clampPosition(
  pos: { x: number; y: number },
  parentWidth: number,
  parentHeight: number,
  panelWidth: number,
  panelHeight: number
) {
  const maxX = Math.max(MARGIN, parentWidth - panelWidth - MARGIN)
  const maxY = Math.max(MARGIN, parentHeight - panelHeight - MARGIN)
  return {
    x: Math.min(Math.max(MARGIN, pos.x), maxX),
    y: Math.min(Math.max(MARGIN, pos.y), maxY),
  }
}
