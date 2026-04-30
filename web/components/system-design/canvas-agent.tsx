"use client"

import {
  PlusIcon,
  SparklesIcon,
  SquareIcon,
  XIcon,
} from "lucide-react"
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react"
import ReactMarkdown from "react-markdown"

import type {
  AgentCanvasEdge,
  AgentCanvasNode,
  AgentChatMessage,
  AgentOp,
} from "@/lib/canvas-ai/types"
import { cn } from "@/lib/utils"

type CanvasContext = {
  nodes: AgentCanvasNode[]
  edges: AgentCanvasEdge[]
  selectedNodeIds: string[]
  projectName?: string
}

type ChatMessage = {
  id: string
  role: "user" | "assistant"
  content: string
  /** Number of mutation ops the assistant produced for this turn. */
  opCount?: number
  status?: "thinking" | "writing" | "done" | "error"
  errorText?: string
}

type CanvasAgentProps = {
  /** Snapshot canvas state at the moment a request is sent. */
  getCanvasContext: () => CanvasContext
  /** Called once when a new agent request begins (host can reset id maps). */
  beginSession: () => void
  /** Apply a single canvas mutation op produced by the model. */
  applyOp: (op: AgentOp) => void
  /**
   * Called once a request finishes (success or stop). Hosts use this to
   * run a real auto-layout pass on the freshly-spawned nodes.
   */
  finishSession: () => void
}

const PANEL_WIDTH = 380
const PANEL_HEIGHT = 540
const MARGIN = 16

const STARTER_PROMPTS = [
  "Sketch a typical SaaS architecture",
  "Add a Redis cache between the API and database",
  "Group the backend services together",
  "Wire up an auth flow with OAuth",
]

export function CanvasAgent({
  getCanvasContext,
  beginSession,
  applyOp,
  finishSession,
}: CanvasAgentProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [input, setInput] = useState("")
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [statusStage, setStatusStage] = useState<
    "started" | "thinking" | "writing" | null
  >(null)

  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  // Auto-scroll the message list as new tokens arrive.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages])

  // Focus the input when the panel opens.
  useEffect(() => {
    if (!isOpen) return
    const t = window.setTimeout(() => inputRef.current?.focus(), 60)
    return () => window.clearTimeout(t)
  }, [isOpen])

  // Cancel any in-flight request on unmount.
  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  // ---- Drag-to-move ------------------------------------------------------

  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null,
  )
  const dragStartRef = useRef<{
    pointerX: number
    pointerY: number
    originX: number
    originY: number
  } | null>(null)
  const [isDragging, setIsDragging] = useState(false)

  // Resolve initial position once we know the viewport. Using derived state
  // (rather than an effect) avoids a setState-in-effect cascade and gets the
  // panel rendered at its anchor on the very first paint after opening.
  const [hasInitPosition, setHasInitPosition] = useState(false)
  if (
    isOpen &&
    !hasInitPosition &&
    position === null &&
    typeof window !== "undefined"
  ) {
    setHasInitPosition(true)
    setPosition({
      x: Math.max(MARGIN, (window.innerWidth - PANEL_WIDTH) / 2),
      y: Math.max(MARGIN, (window.innerHeight - PANEL_HEIGHT) / 2),
    })
  }

  const onHeaderPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement
      if (target.closest("button")) return
      const el = panelRef.current
      if (!el || !position) return
      ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
      dragStartRef.current = {
        pointerX: event.clientX,
        pointerY: event.clientY,
        originX: position.x,
        originY: position.y,
      }
      setIsDragging(true)
    },
    [position],
  )

  const onHeaderPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const start = dragStartRef.current
      if (!start) return
      const dx = event.clientX - start.pointerX
      const dy = event.clientY - start.pointerY
      const w = typeof window === "undefined" ? 1200 : window.innerWidth
      const h = typeof window === "undefined" ? 800 : window.innerHeight
      const x = clamp(start.originX + dx, MARGIN, w - PANEL_WIDTH - MARGIN)
      const y = clamp(start.originY + dy, MARGIN, h - 80 - MARGIN)
      setPosition({ x, y })
    },
    [],
  )

  const onHeaderPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragStartRef.current) return
      try {
        ;(event.currentTarget as HTMLElement).releasePointerCapture(
          event.pointerId,
        )
      } catch {
        /* ignore */
      }
      dragStartRef.current = null
      setIsDragging(false)
    },
    [],
  )

  // ---- Streaming send ----------------------------------------------------

  const handleStop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  const handleNewChat = useCallback(() => {
    // If a request is in flight, abort it first so its `finally` block
    // doesn't keep streaming into the (now-empty) message list.
    abortRef.current?.abort()
    abortRef.current = null
    setMessages([])
    setInput("")
    setIsStreaming(false)
    setStatusStage(null)
    // Reset the agent’s session bookkeeping so freshly-added ids are
    // tracked separately from any prior turn.
    beginSession()
    window.setTimeout(() => inputRef.current?.focus(), 30)
  }, [beginSession])

  const handleSend = useCallback(async () => {
    const prompt = input.trim()
    if (!prompt || isStreaming) return

    const ctx = getCanvasContext()
    const history: AgentChatMessage[] = messages
      .filter((m) => m.status !== "error")
      .map((m) => ({ role: m.role, content: m.content }))

    const userId = `u-${Date.now()}`
    const assistantId = `a-${Date.now()}`
    const userMsg: ChatMessage = {
      id: userId,
      role: "user",
      content: prompt,
    }
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      opCount: 0,
      status: "thinking",
    }
    setMessages((prev) => [...prev, userMsg, assistantMsg])
    setInput("")
    setIsStreaming(true)
    setStatusStage("started")
    beginSession()

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const response = await fetch("/api/canvas-ai/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          projectName: ctx.projectName,
          nodes: ctx.nodes,
          edges: ctx.edges,
          selectedNodeIds: ctx.selectedNodeIds,
          history,
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errBody = await response.json().catch(() => null)
        throw new Error(
          errBody?.error || `Request failed (${response.status})`,
        )
      }
      if (!response.body) {
        throw new Error("Streaming not supported in this browser")
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let serverError: string | null = null

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let sep: number
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          const dataLines = rawEvent
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.replace(/^data:\s?/, ""))
          if (dataLines.length === 0) continue
          let evt: {
            type?: string
            stage?: string
            delta?: string
            op?: AgentOp
            message?: string
            reply?: string
            ops?: AgentOp[]
          }
          try {
            evt = JSON.parse(dataLines.join("\n"))
          } catch {
            continue
          }

          if (evt.type === "status" && typeof evt.stage === "string") {
            const stage = evt.stage as "started" | "thinking" | "writing"
            setStatusStage(stage)
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      status:
                        stage === "writing" ? "writing" : "thinking",
                    }
                  : m,
              ),
            )
          } else if (
            evt.type === "reply" &&
            typeof evt.delta === "string"
          ) {
            const chunk = evt.delta
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, content: m.content + chunk, status: "writing" }
                  : m,
              ),
            )
          } else if (evt.type === "op" && evt.op) {
            try {
              applyOp(evt.op)
            } catch (err) {
              console.error("applyOp failed:", err, evt.op)
            }
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, opCount: (m.opCount ?? 0) + 1 }
                  : m,
              ),
            )
          } else if (evt.type === "done") {
            // The route's `done` event already includes the canonical
            // reply + ops, but we've been applying them live. Mark the
            // turn complete.
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, status: "done" } : m,
              ),
            )
          } else if (evt.type === "error") {
            serverError = evt.message ?? "AI service error"
          }
        }
      }

      if (serverError) throw new Error(serverError)

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, status: "done" } : m,
        ),
      )
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  status: "done",
                  content: m.content || "_(stopped)_",
                }
              : m,
          ),
        )
      } else {
        const msg =
          err instanceof Error ? err.message : "Failed to reach the AI service"
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  status: "error",
                  errorText: msg,
                  content: m.content,
                }
              : m,
          ),
        )
      }
    } finally {
      abortRef.current = null
      setIsStreaming(false)
      setStatusStage(null)
      // Run a real dagre layout on whatever the model just spawned. Done
      // unconditionally so even partial / aborted streams get tidied up.
      try {
        finishSession()
      } catch (err) {
        console.error("finishSession failed:", err)
      }
    }
  }, [input, isStreaming, getCanvasContext, messages, beginSession, applyOp, finishSession])

  // Keyboard shortcut: ⌘/Ctrl+I toggles the agent.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      const isTyping =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "i") {
        e.preventDefault()
        setIsOpen((v) => !v)
        return
      }
      if (e.key === "Escape" && isOpen && !isTyping) {
        e.preventDefault()
        setIsOpen(false)
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [isOpen])

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        title="Ask the AI design agent (⌘I)"
        className={cn(
          "absolute bottom-6 left-24 z-30 flex items-center gap-2",
          "rounded-full border border-border/60 bg-card px-3.5 py-2 text-sm font-medium text-foreground shadow-lg backdrop-blur-md",
          "transition-colors hover:bg-muted",
        )}
      >
        <span className="flex size-5 items-center justify-center rounded-full bg-foreground text-background">
          <SparklesIcon className="size-3" />
        </span>
        <span>Ask AI agent</span>
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          ⌘I
        </span>
      </button>
    )
  }

  const panelStyle: CSSProperties = position
    ? {
        left: position.x,
        top: position.y,
        width: PANEL_WIDTH,
        height: PANEL_HEIGHT,
        opacity: 1,
      }
    : {
        right: MARGIN,
        bottom: MARGIN,
        width: PANEL_WIDTH,
        height: PANEL_HEIGHT,
        opacity: 0,
      }

  return (
    <div
      ref={panelRef}
      style={panelStyle}
      className={cn(
        "absolute z-40 flex flex-col overflow-hidden rounded-2xl border border-border/70 bg-card shadow-2xl ring-1 ring-black/5 backdrop-blur-md",
        "dark:ring-white/10",
        isDragging && "select-none",
      )}
    >
      {/* Header — drag handle */}
      <div
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
        className="flex cursor-grab items-center justify-between gap-2 border-b border-border/60 bg-muted/40 px-3 py-2 active:cursor-grabbing"
      >
        <div className="flex items-center gap-2">
          <span className="flex size-5 items-center justify-center rounded-full bg-foreground text-background">
            <SparklesIcon className="size-3" />
          </span>
          <span className="text-xs font-semibold text-foreground">
            Design copilot
          </span>
          {statusStage && (
            <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className="size-1.5 animate-pulse rounded-full bg-amber-500" />
              {statusStage === "thinking" && "thinking…"}
              {statusStage === "writing" && "applying changes…"}
              {statusStage === "started" && "started"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleNewChat}
            aria-label="New chat"
            title="New chat"
            className="flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <PlusIcon className="size-3" />
            New
          </button>
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            aria-label="Close"
            className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {messages.length === 0 ? (
          <EmptyState onPick={(p) => setInput(p)} />
        ) : (
          messages.map((m) => <MessageBubble key={m.id} message={m} />)
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-border/60 bg-card/80 p-2">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            }
          }}
          placeholder="Describe a change — e.g. add a Postgres database and connect the API to it"
          rows={2}
          disabled={isStreaming}
          className="w-full resize-none rounded-lg bg-muted/40 px-2.5 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-foreground/20 disabled:opacity-50"
        />
        <div className="mt-1 flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground/60">
            ↵ to send · ⇧↵ for newline · Esc closes
          </span>
          {isStreaming ? (
            <button
              onClick={handleStop}
              className="flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
              <SquareIcon className="size-3" />
              Stop
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="rounded-full bg-foreground px-3 py-1 text-xs font-medium text-background transition-colors hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function EmptyState({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-muted">
        <SparklesIcon className="size-4 text-foreground" />
      </span>
      <p className="text-sm font-medium text-foreground">
        Ask the agent to build, edit, or explain your diagram.
      </p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        It can drop in icons, group services, wire edges with API contracts,
        and refactor existing nodes — all live, while you watch.
      </p>
      <div className="grid w-full grid-cols-1 gap-1.5 pt-1">
        {STARTER_PROMPTS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPick(p)}
            className="rounded-lg border border-border/60 bg-background px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  )
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <div className="ml-6 rounded-2xl bg-foreground/95 px-3 py-2 text-sm leading-relaxed text-background">
        <p className="break-words whitespace-pre-wrap">{message.content}</p>
      </div>
    )
  }
  const isThinking = message.status === "thinking" && !message.content
  const isError = message.status === "error"
  return (
    <div
      className={cn(
        "mr-6 rounded-2xl px-3 py-2 text-sm leading-relaxed",
        isError
          ? "border border-destructive/30 bg-destructive/10 text-destructive"
          : "bg-muted/60 text-foreground",
      )}
    >
      {isThinking ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-block size-2 animate-pulse rounded-full bg-foreground/40" />
          Reading the canvas…
        </div>
      ) : (
        <div className="prose-sm max-w-none break-words">
          <ReactMarkdown
            components={{
              p: ({ children }) => (
                <p className="mb-2 leading-relaxed last:mb-0">{children}</p>
              ),
              strong: ({ children }) => (
                <strong className="font-semibold">{children}</strong>
              ),
              code: ({ children }) => (
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
                  {children}
                </code>
              ),
              ul: ({ children }) => (
                <ul className="my-1.5 list-disc space-y-0.5 pl-5">
                  {children}
                </ul>
              ),
              ol: ({ children }) => (
                <ol className="my-1.5 list-decimal space-y-0.5 pl-5">
                  {children}
                </ol>
              ),
              li: ({ children }) => <li>{children}</li>,
            }}
          >
            {message.content || ""}
          </ReactMarkdown>
          {message.status === "writing" && (
            <span className="ml-0.5 inline-block h-3 w-[2px] animate-pulse bg-current align-middle" />
          )}
        </div>
      )}
      {isError && message.errorText && (
        <p className="mt-1 text-[11px]">{message.errorText}</p>
      )}
      {!isThinking && !isError && (message.opCount ?? 0) > 0 && (
        <div className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="inline-block size-1.5 rounded-full bg-emerald-500" />
          Applied {message.opCount} change{message.opCount === 1 ? "" : "s"} to
          the canvas
        </div>
      )}
    </div>
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
