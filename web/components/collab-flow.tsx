"use client"

import "@xyflow/react/dist/style.css"

import {
  Background,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { WebsocketProvider } from "y-websocket"
import * as Y from "yjs"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type CollaboratorPresence = {
  id: number
  name: string
  color: string
  cursor: { x: number; y: number } | null
}

const FLOW_NODES_KEY = "flow:nodes"
const FLOW_EDGES_KEY = "flow:edges"

const DEFAULT_NODES: Node[] = [
  {
    id: "1",
    position: { x: 0, y: 0 },
    data: { label: "👋 Welcome — drag me!" },
    type: "input",
  },
  {
    id: "2",
    position: { x: 220, y: 120 },
    data: { label: "I sync in real-time" },
  },
  {
    id: "3",
    position: { x: 480, y: 0 },
    data: { label: "Open another tab to play" },
    type: "output",
  },
]

const DEFAULT_EDGES: Edge[] = [
  { id: "e1-2", source: "1", target: "2", animated: true },
  { id: "e2-3", source: "2", target: "3", animated: true },
]

const PRESENCE_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
] as const

const ANIMALS = [
  "Otter",
  "Fox",
  "Panda",
  "Falcon",
  "Tiger",
  "Octopus",
  "Wolf",
  "Hedgehog",
  "Penguin",
  "Koala",
] as const

const ADJECTIVES = [
  "Curious",
  "Lucid",
  "Quiet",
  "Brisk",
  "Glowing",
  "Stellar",
  "Mellow",
  "Nimble",
] as const

const PRESENCE_STORAGE_KEY = "codesign:presence"

const randomFrom = <T,>(arr: readonly T[]): T =>
  arr[Math.floor(Math.random() * arr.length)] as T

const loadOrCreatePresence = () => {
  if (typeof window === "undefined") {
    return { name: "Guest", color: PRESENCE_COLORS[0] as string }
  }
  try {
    const cached = window.localStorage.getItem(PRESENCE_STORAGE_KEY)
    if (cached) {
      const parsed = JSON.parse(cached) as { name: string; color: string }
      if (parsed?.name && parsed?.color) return parsed
    }
  } catch {
    // ignore
  }
  const presence = {
    name: `${randomFrom(ADJECTIVES)} ${randomFrom(ANIMALS)}`,
    color: randomFrom(PRESENCE_COLORS),
  }
  try {
    window.localStorage.setItem(PRESENCE_STORAGE_KEY, JSON.stringify(presence))
  } catch {
    // ignore
  }
  return presence
}

const getRoom = () => {
  if (typeof window === "undefined") return "default-room"
  const params = new URLSearchParams(window.location.search)
  return params.get("room") ?? "default-room"
}

const getWsUrl = () => {
  const fromEnv = process.env.NEXT_PUBLIC_COLLAB_WS_URL
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv
  return "ws://localhost:1234"
}

function CollabFlowInner() {
  const reactFlow = useReactFlow()
  const containerRef = useRef<HTMLDivElement | null>(null)

  const [nodes, setNodes] = useState<Node[]>(DEFAULT_NODES)
  const [edges, setEdges] = useState<Edge[]>(DEFAULT_EDGES)
  const [collaborators, setCollaborators] = useState<CollaboratorPresence[]>([])
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">(
    "connecting",
  )

  // Stable Yjs doc + provider for the lifetime of this component instance.
  const ydoc = useMemo(() => new Y.Doc(), [])
  const ynodes = useMemo(() => ydoc.getMap<Node>(FLOW_NODES_KEY), [ydoc])
  const yedges = useMemo(() => ydoc.getMap<Edge>(FLOW_EDGES_KEY), [ydoc])
  const presence = useMemo(loadOrCreatePresence, [])
  const room = useMemo(getRoom, [])
  const wsUrl = useMemo(getWsUrl, [])

  const providerRef = useRef<WebsocketProvider | null>(null)
  // Track whether a sync change is being applied so we don't echo it back to Yjs.
  const applyingRemote = useRef(false)

  const snapshotNodes = useCallback(() => {
    const list: Node[] = []
    ynodes.forEach((value) => {
      list.push(value)
    })
    return list
  }, [ynodes])

  const snapshotEdges = useCallback(() => {
    const list: Edge[] = []
    yedges.forEach((value) => {
      list.push(value)
    })
    return list
  }, [yedges])

  // Wire up the provider + observers + awareness once.
  useEffect(() => {
    const provider = new WebsocketProvider(wsUrl, room, ydoc, { connect: true })
    providerRef.current = provider

    provider.on("status", (event: { status: string }) => {
      if (event.status === "connected") setStatus("connected")
      else if (event.status === "connecting") setStatus("connecting")
      else setStatus("disconnected")
    })

    provider.awareness.setLocalStateField("user", {
      name: presence.name,
      color: presence.color,
    })

    // Seed initial document on first connection if it's empty.
    const seedIfEmpty = () => {
      if (ynodes.size === 0 && yedges.size === 0) {
        ydoc.transact(() => {
          for (const node of DEFAULT_NODES) ynodes.set(node.id, node)
          for (const edge of DEFAULT_EDGES) yedges.set(edge.id, edge)
        }, "seed")
      }
    }
    const onSync = (synced: boolean) => {
      if (synced) seedIfEmpty()
    }
    provider.on("sync", onSync)

    const onNodesObserve = () => {
      applyingRemote.current = true
      setNodes(snapshotNodes())
      // Release on next tick so React commits before we accept local changes again.
      queueMicrotask(() => {
        applyingRemote.current = false
      })
    }
    const onEdgesObserve = () => {
      applyingRemote.current = true
      setEdges(snapshotEdges())
      queueMicrotask(() => {
        applyingRemote.current = false
      })
    }

    ynodes.observeDeep(onNodesObserve)
    yedges.observeDeep(onEdgesObserve)

    // Hydrate from existing remote state immediately (in case we joined late).
    if (ynodes.size > 0) setNodes(snapshotNodes())
    if (yedges.size > 0) setEdges(snapshotEdges())

    const onAwarenessChange = () => {
      const states = provider.awareness.getStates()
      const others: CollaboratorPresence[] = []
      states.forEach((state, clientId) => {
        if (clientId === provider.awareness.clientID) return
        const user = state?.user as { name?: string; color?: string } | undefined
        const cursor = state?.cursor as { x: number; y: number } | null | undefined
        if (!user?.name || !user?.color) return
        others.push({
          id: clientId,
          name: user.name,
          color: user.color,
          cursor: cursor ?? null,
        })
      })
      setCollaborators(others)
    }
    provider.awareness.on("change", onAwarenessChange)

    return () => {
      ynodes.unobserveDeep(onNodesObserve)
      yedges.unobserveDeep(onEdgesObserve)
      provider.off("sync", onSync)
      provider.awareness.off("change", onAwarenessChange)
      provider.awareness.setLocalState(null)
      provider.destroy()
      providerRef.current = null
    }
  }, [ydoc, ynodes, yedges, presence, room, wsUrl, snapshotNodes, snapshotEdges])

  // ---- React Flow change handlers -----------------------------------------

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // Compute next state locally for snappy UX.
      const next = applyNodeChanges(changes, nodes)
      setNodes(next)

      if (applyingRemote.current) return

      ydoc.transact(() => {
        for (const change of changes) {
          if (change.type === "remove") {
            ynodes.delete(change.id)
            continue
          }
          if (change.type === "add") {
            ynodes.set(change.item.id, change.item)
            continue
          }
          // For position / dimensions / select / replace, write the merged node.
          const id =
            "id" in change && typeof change.id === "string" ? change.id : null
          if (!id) continue
          const merged = next.find((n) => n.id === id)
          if (merged) ynodes.set(id, merged)
        }
      }, "local")
    },
    [nodes, ydoc, ynodes],
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const next = applyEdgeChanges(changes, edges)
      setEdges(next)

      if (applyingRemote.current) return

      ydoc.transact(() => {
        for (const change of changes) {
          if (change.type === "remove") {
            yedges.delete(change.id)
            continue
          }
          if (change.type === "add") {
            yedges.set(change.item.id, change.item)
            continue
          }
          const id =
            "id" in change && typeof change.id === "string" ? change.id : null
          if (!id) continue
          const merged = next.find((e) => e.id === id)
          if (merged) yedges.set(id, merged)
        }
      }, "local")
    },
    [edges, ydoc, yedges],
  )

  const onConnect = useCallback(
    (connection: Connection) => {
      const next = addEdge({ ...connection, animated: true }, edges)
      setEdges(next)
      ydoc.transact(() => {
        // The new edge is the one not present before.
        for (const edge of next) {
          if (!yedges.has(edge.id)) yedges.set(edge.id, edge)
        }
      }, "local")
    },
    [edges, ydoc, yedges],
  )

  // ---- Toolbar actions -----------------------------------------------------

  const addNode = useCallback(() => {
    const id = `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const center = reactFlow.screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    })
    const node: Node = {
      id,
      position: {
        x: center.x + (Math.random() - 0.5) * 80,
        y: center.y + (Math.random() - 0.5) * 80,
      },
      data: { label: `Node ${ynodes.size + 1}` },
    }
    ynodes.set(id, node)
  }, [reactFlow, ynodes])

  const resetFlow = useCallback(() => {
    ydoc.transact(() => {
      ynodes.clear()
      yedges.clear()
      for (const node of DEFAULT_NODES) ynodes.set(node.id, node)
      for (const edge of DEFAULT_EDGES) yedges.set(edge.id, edge)
    }, "reset")
  }, [ydoc, ynodes, yedges])

  const copyShareLink = useCallback(async () => {
    if (typeof window === "undefined") return
    const url = new URL(window.location.href)
    url.searchParams.set("room", room)
    try {
      await navigator.clipboard.writeText(url.toString())
    } catch {
      // ignore
    }
  }, [room])

  // ---- Cursor broadcasting -------------------------------------------------

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const provider = providerRef.current
      if (!provider) return
      const bounds = containerRef.current?.getBoundingClientRect()
      if (!bounds) return
      provider.awareness.setLocalStateField("cursor", {
        x: (event.clientX - bounds.left) / bounds.width,
        y: (event.clientY - bounds.top) / bounds.height,
      })
    },
    [],
  )

  const onPointerLeave = useCallback(() => {
    const provider = providerRef.current
    if (!provider) return
    provider.awareness.setLocalStateField("cursor", null)
  }, [])

  // -------------------------------------------------------------------------

  return (
    <div
      ref={containerRef}
      className="relative h-svh w-svw"
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} />
        <MiniMap pannable zoomable />
        <Controls />

        <Panel position="top-left">
          <div className="flex items-center gap-2 rounded-md border bg-background/90 p-2 shadow-sm backdrop-blur">
            <span
              className={cn(
                "size-2 rounded-full",
                status === "connected" && "bg-emerald-500",
                status === "connecting" && "animate-pulse bg-amber-500",
                status === "disconnected" && "bg-rose-500",
              )}
              aria-hidden
            />
            <span className="text-xs font-medium capitalize">{status}</span>
            <span className="text-xs text-muted-foreground">·</span>
            <span className="text-xs text-muted-foreground">room: {room}</span>
          </div>
        </Panel>

        <Panel position="top-right">
          <div className="flex items-center gap-2 rounded-md border bg-background/90 p-2 shadow-sm backdrop-blur">
            <PresenceStack me={presence} others={collaborators} />
            <Button size="sm" variant="outline" onClick={copyShareLink}>
              Copy link
            </Button>
            <Button size="sm" onClick={addNode}>
              + Node
            </Button>
            <Button size="sm" variant="ghost" onClick={resetFlow}>
              Reset
            </Button>
          </div>
        </Panel>
      </ReactFlow>

      <RemoteCursors collaborators={collaborators} />
    </div>
  )
}

function PresenceStack({
  me,
  others,
}: {
  me: { name: string; color: string }
  others: CollaboratorPresence[]
}) {
  const all = [{ id: -1, name: me.name, color: me.color, isMe: true }, ...others]
  return (
    <div className="flex -space-x-2">
      {all.slice(0, 5).map((user) => (
        <div
          key={user.id}
          title={`${user.name}${"isMe" in user && user.isMe ? " (you)" : ""}`}
          className="flex size-6 items-center justify-center rounded-full border-2 border-background text-[10px] font-semibold text-white"
          style={{ backgroundColor: user.color }}
        >
          {user.name
            .split(" ")
            .map((part) => part[0])
            .join("")
            .slice(0, 2)
            .toUpperCase()}
        </div>
      ))}
      {all.length > 5 && (
        <div className="flex size-6 items-center justify-center rounded-full border-2 border-background bg-muted text-[10px] font-semibold">
          +{all.length - 5}
        </div>
      )}
    </div>
  )
}

function RemoteCursors({
  collaborators,
}: {
  collaborators: CollaboratorPresence[]
}) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {collaborators.map((user) =>
        user.cursor ? (
          <div
            key={user.id}
            className="absolute -translate-x-1 -translate-y-1 transition-transform duration-75"
            style={{
              left: `${user.cursor.x * 100}%`,
              top: `${user.cursor.y * 100}%`,
              color: user.color,
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M5 3l14 8-6 1-3 6-5-15z" />
            </svg>
            <div
              className="ml-3 -mt-2 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium text-white"
              style={{ backgroundColor: user.color }}
            >
              {user.name}
            </div>
          </div>
        ) : null,
      )}
    </div>
  )
}

export function CollabFlow() {
  return (
    <ReactFlowProvider>
      <CollabFlowInner />
    </ReactFlowProvider>
  )
}
