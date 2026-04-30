"use client"

import "@xyflow/react/dist/style.css"

import { HocuspocusProvider } from "@hocuspocus/provider"
import {
    Background,
    ConnectionMode,
    Controls,
    MarkerType,
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
    type OnSelectionChangeParams,
} from "@xyflow/react"
import Link from "next/link"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import * as Y from "yjs"

import { ActionToolbar } from "@/components/system-design/action-toolbar"
import { computeAutoLayout } from "@/components/system-design/auto-layout"
import { CanvasAgent } from "@/components/system-design/canvas-agent"
import { ContainerInspector } from "@/components/system-design/container-inspector"
import { EdgeInspector } from "@/components/system-design/edge-inspector"
import { FloatingInspector } from "@/components/system-design/floating-inspector"
import { SystemGroupNode } from "@/components/system-design/group-node"
import { SystemIconNode } from "@/components/system-design/icon-node"
import { IconSidebar } from "@/components/system-design/icon-sidebar"
import { SystemEdge } from "@/components/system-design/labeled-edge"
import { NodeInspector } from "@/components/system-design/node-inspector"
import { SystemTextNode } from "@/components/system-design/text-node"
import { useCanvasAgent } from "@/components/system-design/use-canvas-agent"
import {
    CONTAINER_GROUP_ID,
    CONTAINER_TEXT_ID,
    GROUP_DEFAULT_SIZE,
    ICON_DRAG_MIME,
    SYSTEM_EDGE_TYPE,
    SYSTEM_GROUP_TYPE,
    SYSTEM_NODE_TYPE,
    SYSTEM_TEXT_TYPE,
    type IconEntry,
    type SystemEdgeData,
    type SystemGroupData,
    type SystemNodeData,
    type SystemTextData,
} from "@/components/system-design/types"
import { useFlowKeyboard } from "@/components/system-design/use-flow-keyboard"
import { useYjsUndo } from "@/components/system-design/use-yjs-undo"
import { Button } from "@/components/ui/button"
import {
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup,
} from "@/components/ui/resizable"
import type { Project } from "@/lib/projects"
import { cn } from "@/lib/utils"

type CollaboratorPresence = {
    id: number
    name: string
    color: string
    cursor: { x: number; y: number } | null
}

export type CollabUser = {
    id: string
    name: string
    email: string
}

type CollabFlowProps = {
    project: Project
    user: CollabUser
}

const FLOW_NODES_KEY = "flow:nodes"
const FLOW_EDGES_KEY = "flow:edges"

const DEFAULT_NODES: Node[] = []
const DEFAULT_EDGES: Edge[] = []

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

// Stable per-user color derived from the user id so the same person shows up
// in the same color across reloads / tabs.
const colorForUser = (id: string) => {
    let hash = 0
    for (let i = 0; i < id.length; i += 1) {
        hash = (hash * 31 + id.charCodeAt(i)) | 0
    }
    const idx = Math.abs(hash) % PRESENCE_COLORS.length
    return PRESENCE_COLORS[idx] as string
}

const getWsUrl = () => {
    const fromEnv = process.env.NEXT_PUBLIC_COLLAB_WS_URL
    if (fromEnv && fromEnv.trim().length > 0) return fromEnv
    return "ws://localhost:1234"
}

const EDGE_MARKER_END = {
    type: MarkerType.ArrowClosed,
    width: 14,
    height: 14,
    color: "var(--muted-foreground)",
} as const

// Hand-tuned to roughly center icon tiles under the drop cursor.
const ICON_TILE_HALF_WIDTH = 56
const ICON_TILE_HALF_HEIGHT = 40
const TEXT_TILE_HALF_WIDTH = 70
const TEXT_TILE_HALF_HEIGHT = 16

const NODE_TYPES = {
    [SYSTEM_NODE_TYPE]: SystemIconNode,
    [SYSTEM_GROUP_TYPE]: SystemGroupNode,
    [SYSTEM_TEXT_TYPE]: SystemTextNode,
} as const

const EDGE_TYPES = {
    [SYSTEM_EDGE_TYPE]: SystemEdge,
} as const

function newNodeId(prefix = "n") {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

function CollabFlowInner({ project, user }: CollabFlowProps) {
    const reactFlow = useReactFlow()
    const containerRef = useRef<HTMLDivElement | null>(null)
    const canvasRef = useRef<HTMLDivElement | null>(null)

    const [nodes, setNodes] = useState<Node[]>(DEFAULT_NODES)
    const [edges, setEdges] = useState<Edge[]>(DEFAULT_EDGES)
    const [collaborators, setCollaborators] = useState<CollaboratorPresence[]>([])
    const [status, setStatus] = useState<
        "connecting" | "connected" | "disconnected"
    >("connecting")
    const [selection, setSelection] = useState<
        | { kind: "node"; id: string }
        | { kind: "edge"; id: string }
        | null
    >(null)

    // Stable Yjs doc + provider for the lifetime of this component instance.
    const ydoc = useMemo(() => new Y.Doc(), [])
    const ynodes = useMemo(() => ydoc.getMap<Node>(FLOW_NODES_KEY), [ydoc])
    const yedges = useMemo(() => ydoc.getMap<Edge>(FLOW_EDGES_KEY), [ydoc])
    const presence = useMemo(
        () => ({ name: user.name, color: colorForUser(user.id) }),
        [user.id, user.name]
    )
    const room = project.id
    const wsUrl = useMemo(() => getWsUrl(), [])

    const providerRef = useRef<HocuspocusProvider | null>(null)
    const applyingRemote = useRef(false)

    const snapshotNodes = useCallback(() => {
        const list: Node[] = []
        ynodes.forEach((value) => list.push(value))
        return sortByGroupParenting(list)
    }, [ynodes])

    const snapshotEdges = useCallback(() => {
        const list: Edge[] = []
        yedges.forEach((value) => list.push(value))
        return list
    }, [yedges])

    // ---- Provider + observers + awareness ------------------------------------

    useEffect(() => {
        const provider = new HocuspocusProvider({
            url: wsUrl,
            name: room,
            document: ydoc,
            onStatus: ({ status }) => {
                if (status === "connected") setStatus("connected")
                else if (status === "connecting") setStatus("connecting")
                else setStatus("disconnected")
            },
        })
        providerRef.current = provider

        provider.awareness?.setLocalStateField("user", {
            name: presence.name,
            color: presence.color,
        })

        const onNodesObserve = () => {
            applyingRemote.current = true
            setNodes(snapshotNodes())
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

        queueMicrotask(() => {
            if (ynodes.size > 0) setNodes(snapshotNodes())
            if (yedges.size > 0) setEdges(snapshotEdges())
        })

        const onAwarenessChange = () => {
            const awareness = provider.awareness
            if (!awareness) return
            const states = awareness.getStates()
            const others: CollaboratorPresence[] = []
            states.forEach((state, clientId) => {
                if (clientId === awareness.clientID) return
                const u = state?.user as { name?: string; color?: string } | undefined
                const cursor = state?.cursor as
                    | { x: number; y: number }
                    | null
                    | undefined
                if (!u?.name || !u?.color) return
                others.push({
                    id: clientId,
                    name: u.name,
                    color: u.color,
                    cursor: cursor ?? null,
                })
            })
            setCollaborators(others)
        }
        provider.awareness?.on("change", onAwarenessChange)

        return () => {
            ynodes.unobserveDeep(onNodesObserve)
            yedges.unobserveDeep(onEdgesObserve)
            provider.awareness?.off("change", onAwarenessChange)
            provider.awareness?.setLocalState(null)
            provider.destroy()
            providerRef.current = null
        }
    }, [
        ydoc,
        ynodes,
        yedges,
        presence,
        room,
        wsUrl,
        snapshotNodes,
        snapshotEdges,
    ])

    // ---- Inspector-driven mutations sync'd to Yjs ---------------------------

    const patchNodeData = useCallback(
        <T extends object>(id: string, patch: Partial<T>) => {
            const current = ynodes.get(id)
            if (!current) return
            const next: Node = {
                ...current,
                data: {
                    ...((current.data as Record<string, unknown>) ?? {}),
                    ...patch,
                },
            }
            ydoc.transact(() => ynodes.set(id, stripNodeRuntime(next)), "local")
        },
        [ydoc, ynodes]
    )

    const patchIconNodeData = useCallback(
        (id: string, patch: Partial<SystemNodeData>) => patchNodeData(id, patch),
        [patchNodeData]
    )
    const patchGroupNodeData = useCallback(
        (id: string, patch: Partial<SystemGroupData>) => patchNodeData(id, patch),
        [patchNodeData]
    )
    const patchTextNodeData = useCallback(
        (id: string, patch: Partial<SystemTextData>) => patchNodeData(id, patch),
        [patchNodeData]
    )

    const patchEdgeData = useCallback(
        (id: string, patch: Partial<SystemEdgeData>) => {
            const current = yedges.get(id)
            if (!current) return
            const next: Edge = {
                ...current,
                data: {
                    ...((current.data as SystemEdgeData | undefined) ?? {}),
                    ...patch,
                },
            }
            ydoc.transact(() => yedges.set(id, next), "local")
        },
        [ydoc, yedges]
    )

    const deleteNode = useCallback(
        (id: string) => {
            ydoc.transact(() => {
                ynodes.delete(id)
                // Drop any incident edges so we don't leave dangling references.
                const drop: string[] = []
                yedges.forEach((edge, edgeId) => {
                    if (edge.source === id || edge.target === id) drop.push(edgeId)
                })
                for (const edgeId of drop) yedges.delete(edgeId)
                // If the deleted node was a group, orphan its children rather than
                // delete them — preserves icon work the user did inside.
                ynodes.forEach((node, nodeId) => {
                    if (node.parentId === id) {
                        const reparented: Node = { ...node }
                        delete (reparented as { parentId?: string }).parentId
                        delete (reparented as { extent?: unknown }).extent
                        ynodes.set(nodeId, reparented)
                    }
                })
            }, "delete-node")
            setSelection((prev) =>
                prev?.kind === "node" && prev.id === id ? null : prev
            )
        },
        [ydoc, ynodes, yedges]
    )

    const deleteEdge = useCallback(
        (id: string) => {
            ydoc.transact(() => yedges.delete(id), "local")
            setSelection((prev) =>
                prev?.kind === "edge" && prev.id === id ? null : prev
            )
        },
        [ydoc, yedges]
    )

    // Stable handler proxy so injecting `onUpdate` into node.data doesn't
    // change function identity on every render (memoised nodes use ref equality).
    const patchRef = useRef(patchNodeData)
    useEffect(() => {
        patchRef.current = patchNodeData
    }, [patchNodeData])
    const stableNodeUpdate = useCallback(
        <T extends object>(id: string, patch: Partial<T>) =>
            patchRef.current(id, patch),
        []
    )

    // Decorate nodes with the inline-edit handler before passing to React Flow.
    // We never write the handler back into Yjs — it lives in the React layer
    // only, since Yjs maps must hold serialisable values.
    const nodesForFlow = useMemo(
        () =>
            nodes.map((node) => ({
                ...node,
                data: {
                    ...((node.data as Record<string, unknown>) ?? {}),
                    onUpdate: stableNodeUpdate,
                },
            })),
        [nodes, stableNodeUpdate]
    )

    // ---- React Flow change handlers -----------------------------------------

    const onNodesChange = useCallback(
        (changes: NodeChange[]) => {
            const next = applyNodeChanges(changes, nodes)
            setNodes(next)

            if (applyingRemote.current) return

            // Selection / dimension changes are presentation-only — they
            // don't belong in the shared document. Without this filter,
            // clicking a node would broadcast `selected: true` to every
            // other client and pop their inspector open too.
            const persistable = changes.filter(
                (c) => c.type !== "select" && c.type !== "dimensions"
            )
            if (persistable.length === 0) return

            ydoc.transact(() => {
                for (const change of persistable) {
                    if (change.type === "remove") {
                        ynodes.delete(change.id)
                        const drop: string[] = []
                        yedges.forEach((edge, edgeId) => {
                            if (edge.source === change.id || edge.target === change.id)
                                drop.push(edgeId)
                        })
                        for (const edgeId of drop) yedges.delete(edgeId)
                        // Orphan children if the removed node was a group.
                        ynodes.forEach((node, nodeId) => {
                            if (node.parentId === change.id) {
                                const reparented: Node = { ...node }
                                delete (reparented as { parentId?: string }).parentId
                                delete (reparented as { extent?: unknown }).extent
                                ynodes.set(nodeId, reparented)
                            }
                        })
                        continue
                    }
                    if (change.type === "add") {
                        ynodes.set(change.item.id, stripNodeRuntime(change.item))
                        continue
                    }
                    const id =
                        "id" in change && typeof change.id === "string" ? change.id : null
                    if (!id) continue
                    const merged = next.find((n) => n.id === id)
                    if (merged) ynodes.set(id, stripNodeRuntime(merged))
                }
            }, "local")
        },
        [nodes, ydoc, ynodes, yedges]
    )

    const onEdgesChange = useCallback(
        (changes: EdgeChange[]) => {
            const next = applyEdgeChanges(changes, edges)
            setEdges(next)

            if (applyingRemote.current) return

            // Same rationale as onNodesChange — selection is local-only.
            const persistable = changes.filter((c) => c.type !== "select")
            if (persistable.length === 0) return

            ydoc.transact(() => {
                for (const change of persistable) {
                    if (change.type === "remove") {
                        yedges.delete(change.id)
                        continue
                    }
                    if (change.type === "add") {
                        yedges.set(change.item.id, stripEdgeRuntime(change.item))
                        continue
                    }
                    const id =
                        "id" in change && typeof change.id === "string" ? change.id : null
                    if (!id) continue
                    const merged = next.find((e) => e.id === id)
                    if (merged) yedges.set(id, stripEdgeRuntime(merged))
                }
            }, "local")
        },
        [edges, ydoc, yedges]
    )

    const onConnect = useCallback(
        (connection: Connection) => {
            const newEdge: Edge = {
                ...connection,
                id: `e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                type: SYSTEM_EDGE_TYPE,
                markerEnd: { ...EDGE_MARKER_END },
                data: {} satisfies SystemEdgeData,
            }
            const next = addEdge(newEdge, edges)
            setEdges(next)
            ydoc.transact(() => {
                for (const edge of next) {
                    if (!yedges.has(edge.id)) yedges.set(edge.id, edge)
                }
            }, "local")
            setSelection({ kind: "edge", id: newEdge.id })
        },
        [edges, ydoc, yedges]
    )

    const onSelectionChange = useCallback(
        ({ nodes: selNodes, edges: selEdges }: OnSelectionChangeParams) => {
            // Only show inspector when exactly one thing is selected. Multi-select
            // is for bulk move / delete; the inspector wouldn't know which to edit.
            if (selEdges.length === 1 && selNodes.length === 0) {
                setSelection({ kind: "edge", id: selEdges[0].id })
            } else if (selNodes.length === 1 && selEdges.length === 0) {
                setSelection({ kind: "node", id: selNodes[0].id })
            } else {
                setSelection(null)
            }
        },
        []
    )

    // ---- Node creation helpers ----------------------------------------------

    /**
     * Spawn a node from an icon entry at a given flow-space position.
     * Detects whether the position falls inside a group node and parents the
     * new node accordingly. Returns the created node id.
     */
    const spawnFromIcon = useCallback(
        (icon: IconEntry, position: { x: number; y: number }) => {
            // Are we dropping a brand-new container (group / text) instead of an
            // icon-backed node? Branch up-front so the rest of the function can
            // assume we're spawning an icon node.
            if (icon.id === CONTAINER_GROUP_ID) {
                const id = newNodeId("g")
                const node: Node = {
                    id,
                    type: SYSTEM_GROUP_TYPE,
                    position: {
                        x: position.x - GROUP_DEFAULT_SIZE.width / 2,
                        y: position.y - GROUP_DEFAULT_SIZE.height / 2,
                    },
                    width: GROUP_DEFAULT_SIZE.width,
                    height: GROUP_DEFAULT_SIZE.height,
                    // Groups must paint behind their children. React Flow uses
                    // `selectable: true` plus a dedicated z order for parent nodes.
                    data: { label: "Group" } satisfies SystemGroupData,
                }
                ydoc.transact(() => ynodes.set(id, node), "local")
                setSelection({ kind: "node", id })
                return id
            }
            if (icon.id === CONTAINER_TEXT_ID) {
                const id = newNodeId("t")
                const node: Node = {
                    id,
                    type: SYSTEM_TEXT_TYPE,
                    position: {
                        x: position.x - TEXT_TILE_HALF_WIDTH,
                        y: position.y - TEXT_TILE_HALF_HEIGHT,
                    },
                    data: { text: "", variant: "body" } satisfies SystemTextData,
                }
                ydoc.transact(() => ynodes.set(id, node), "local")
                setSelection({ kind: "node", id })
                return id
            }

            // Real icon node — try to drop into a group at this position.
            const parent = findGroupAtPosition(reactFlow.getNodes(), position)
            const localPos = parent
                ? {
                    x: position.x - parent.position.x - ICON_TILE_HALF_WIDTH,
                    y: position.y - parent.position.y - ICON_TILE_HALF_HEIGHT,
                }
                : {
                    x: position.x - ICON_TILE_HALF_WIDTH,
                    y: position.y - ICON_TILE_HALF_HEIGHT,
                }

            const id = newNodeId("n")
            const nodeData: SystemNodeData = {
                iconId: icon.id,
                iconPath: icon.path,
                iconCategory: icon.category,
                label: icon.name,
            }
            const node: Node = {
                id,
                type: SYSTEM_NODE_TYPE,
                position: localPos,
                data: nodeData,
                ...(parent
                    ? { parentId: parent.id, extent: "parent" as const }
                    : {}),
            }
            ydoc.transact(() => ynodes.set(id, node), "local")
            setSelection({ kind: "node", id })
            return id
        },
        [ydoc, ynodes, reactFlow]
    )

    // ---- Drag-and-drop from the icon sidebar --------------------------------

    const onCanvasDragOver = useCallback(
        (event: React.DragEvent<HTMLDivElement>) => {
            // Must call preventDefault to make this a valid drop target.
            if (event.dataTransfer.types.includes(ICON_DRAG_MIME)) {
                event.preventDefault()
                event.dataTransfer.dropEffect = "copy"
            }
        },
        []
    )

    const onCanvasDrop = useCallback(
        (event: React.DragEvent<HTMLDivElement>) => {
            const raw = event.dataTransfer.getData(ICON_DRAG_MIME)
            if (!raw) return
            event.preventDefault()
            let icon: IconEntry
            try {
                icon = JSON.parse(raw) as IconEntry
            } catch {
                return
            }
            const position = reactFlow.screenToFlowPosition({
                x: event.clientX,
                y: event.clientY,
            })
            spawnFromIcon(icon, position)
        },
        [reactFlow, spawnFromIcon]
    )

    // ---- Toolbar / button actions -------------------------------------------

    const addGroupAtViewportCenter = useCallback(() => {
        const center = reactFlow.screenToFlowPosition({
            x: window.innerWidth / 2,
            y: window.innerHeight / 2,
        })
        spawnFromIcon(
            {
                id: CONTAINER_GROUP_ID,
                name: "Group",
                path: "",
                category: "generic",
            },
            center
        )
    }, [reactFlow, spawnFromIcon])

    const addTextAtViewportCenter = useCallback(() => {
        const center = reactFlow.screenToFlowPosition({
            x: window.innerWidth / 2,
            y: window.innerHeight / 2,
        })
        spawnFromIcon(
            {
                id: CONTAINER_TEXT_ID,
                name: "Note",
                path: "",
                category: "generic",
            },
            center
        )
    }, [reactFlow, spawnFromIcon])

    const [shareCopied, setShareCopied] = useState(false)
    const shareTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const copyShareLink = useCallback(async () => {
        if (typeof window === "undefined") return
        try {
            await navigator.clipboard.writeText(window.location.href)
        } catch {
            // Clipboard API requires a user gesture + secure context. Bail
            // silently — the user can copy from the URL bar as a fallback.
            return
        }
        setShareCopied(true)
        if (shareTimeoutRef.current) clearTimeout(shareTimeoutRef.current)
        shareTimeoutRef.current = setTimeout(() => setShareCopied(false), 2000)
    }, [])

    useEffect(
        () => () => {
            if (shareTimeoutRef.current) clearTimeout(shareTimeoutRef.current)
        },
        []
    )

    // ---- Undo / redo + keyboard shortcuts -----------------------------------

    const { undo, redo, canUndo, canRedo } = useYjsUndo({
        ydoc,
        ynodes: ynodes as Y.Map<unknown>,
        yedges: yedges as Y.Map<unknown>,
    })

    const duplicateSelection = useCallback(() => {
        const selectedNodes = reactFlow.getNodes().filter((n) => n.selected)
        if (selectedNodes.length === 0) return
        const idMap = new Map<string, string>()
        ydoc.transact(() => {
            // First pass — generate new ids and insert clones.
            for (const node of selectedNodes) {
                const newId = newNodeId(node.id.startsWith("g") ? "g" : "n")
                idMap.set(node.id, newId)
                const clone: Node = {
                    ...node,
                    id: newId,
                    position: {
                        x: node.position.x + 24,
                        y: node.position.y + 24,
                    },
                    selected: false,
                    data: { ...((node.data as Record<string, unknown>) ?? {}) },
                }
                // Re-parent the clone if the parent itself is being duplicated;
                // otherwise drop the parent ref so the clone sits at the top level.
                if (clone.parentId && !idMap.has(clone.parentId)) {
                    delete (clone as { parentId?: string }).parentId
                    delete (clone as { extent?: unknown }).extent
                }
                ynodes.set(newId, stripNodeRuntime(clone))
            }
            // Re-link clones whose parent was also cloned (second pass — needed
            // because parents may sort after their children in `selectedNodes`).
            for (const [origId, newId] of idMap) {
                const cloned = ynodes.get(newId)
                if (!cloned?.parentId) continue
                const newParentId = idMap.get(cloned.parentId)
                if (!newParentId) continue
                ynodes.set(newId, { ...cloned, parentId: newParentId })
                void origId
            }
            // Duplicate edges where both endpoints were cloned, so the user gets a
            // self-contained copy of the selected subgraph.
            yedges.forEach((edge, edgeId) => {
                const newSource = idMap.get(edge.source)
                const newTarget = idMap.get(edge.target)
                if (!newSource || !newTarget) return
                const newEdgeId = `e-${Date.now()}-${Math.random()
                    .toString(36)
                    .slice(2, 6)}`
                yedges.set(newEdgeId, {
                    ...edge,
                    id: newEdgeId,
                    source: newSource,
                    target: newTarget,
                })
                void edgeId
            })
        }, "duplicate")
    }, [reactFlow, ydoc, ynodes, yedges])

    const selectAll = useCallback(() => {
        setNodes((prev) => prev.map((n) => ({ ...n, selected: true })))
        setEdges((prev) => prev.map((e) => ({ ...e, selected: true })))
    }, [])

    const clearSelection = useCallback(() => {
        setNodes((prev) =>
            prev.some((n) => n.selected)
                ? prev.map((n) => (n.selected ? { ...n, selected: false } : n))
                : prev
        )
        setEdges((prev) =>
            prev.some((e) => e.selected)
                ? prev.map((e) => (e.selected ? { ...e, selected: false } : e))
                : prev
        )
        setSelection(null)
    }, [])

    // ---- Manual auto-layout (toolbar + ⌘L) ---------------------------------

    /**
     * Lay out the canvas using dagre. If a subset is selected, only those
     * nodes are repositioned (existing layout for the rest is preserved);
     * otherwise the whole graph is laid out around the viewport center.
     */
    const runAutoLayout = useCallback(() => {
        const allNodes: Node[] = []
        ynodes.forEach((n) => allNodes.push(n))
        if (allNodes.length === 0) return
        const allEdges: Edge[] = []
        yedges.forEach((e) => allEdges.push(e))

        const selected = allNodes.filter((n) => n.selected).map((n) => n.id)
        const scope = selected.length > 1 ? new Set(selected) : undefined

        let anchor = { x: 0, y: 0 }
        if (typeof window !== "undefined") {
            try {
                anchor = reactFlow.screenToFlowPosition({
                    x: window.innerWidth / 2,
                    y: window.innerHeight / 2,
                })
            } catch {
                /* fall back to (0,0) */
            }
        }

        const patches = computeAutoLayout(allNodes, allEdges, {
            direction: "LR",
            scope,
            anchor,
        })
        if (patches.size === 0) return

        ydoc.transact(() => {
            for (const [id, patch] of patches) {
                const current = ynodes.get(id)
                if (!current) continue
                const next: Node = {
                    ...current,
                    position: patch.position,
                    ...(patch.width !== undefined ? { width: patch.width } : {}),
                    ...(patch.height !== undefined
                        ? { height: patch.height }
                        : {}),
                }
                ynodes.set(id, stripNodeRuntime(next))
            }
        }, "auto-layout")

        // Re-fit the viewport so the user can see the result. Defer one
        // frame so React Flow has a chance to apply the new positions.
        window.setTimeout(() => {
            try {
                reactFlow.fitView({ padding: 0.4, duration: 400 })
            } catch {
                /* ignore — fitView occasionally throws if there are no nodes */
            }
        }, 0)
    }, [ydoc, ynodes, yedges, reactFlow])

    useFlowKeyboard({
        onUndo: undo,
        onRedo: redo,
        onDuplicate: duplicateSelection,
        onSelectAll: selectAll,
        onAutoLayout: runAutoLayout,
        onEscape: clearSelection,
    })

    // ---- AI agent (floating chat) -------------------------------------------

    // Snapshot getters use refs so the agent always sees the latest state at
    // request time without retriggering its memoised callbacks.
    const nodesRef = useRef(nodes)
    const edgesRef = useRef(edges)
    useEffect(() => {
        nodesRef.current = nodes
    }, [nodes])
    useEffect(() => {
        edgesRef.current = edges
    }, [edges])

    const agentApi = useCanvasAgent({
        ydoc,
        ynodes: ynodes as Y.Map<Node>,
        yedges: yedges as Y.Map<Edge>,
        reactFlow,
        getNodesSnapshot: useCallback(() => nodesRef.current, []),
        getEdgesSnapshot: useCallback(() => edgesRef.current, []),
        getSelectedNodeIds: useCallback(
            () => nodesRef.current.filter((n) => n.selected).map((n) => n.id),
            []
        ),
        projectName: project.name,
    })

    // ---- Awareness pointer tracking -----------------------------------------

    const onPointerMove = useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            const provider = providerRef.current
            if (!provider) return
            const bounds = canvasRef.current?.getBoundingClientRect()
            if (!bounds) return
            provider.awareness?.setLocalStateField("cursor", {
                x: (event.clientX - bounds.left) / bounds.width,
                y: (event.clientY - bounds.top) / bounds.height,
            })
        },
        []
    )

    const onPointerLeave = useCallback(() => {
        const provider = providerRef.current
        if (!provider) return
        provider.awareness?.setLocalStateField("cursor", null)
    }, [])

    // ---- Inspector resolution -----------------------------------------------

    const selectedNode =
        selection?.kind === "node"
            ? nodes.find((n) => n.id === selection.id) ?? null
            : null
    const selectedEdge =
        selection?.kind === "edge"
            ? edges.find((e) => e.id === selection.id) ?? null
            : null

    const renderInspector = () => {
        if (selectedEdge) {
            return (
                <EdgeInspector
                    edge={selectedEdge}
                    onPatch={patchEdgeData}
                    onDelete={deleteEdge}
                    onClose={clearSelection}
                />
            )
        }
        if (selectedNode) {
            if (selectedNode.type === SYSTEM_NODE_TYPE) {
                return (
                    <NodeInspector
                        node={selectedNode}
                        onPatch={patchIconNodeData}
                        onDelete={deleteNode}
                        onClose={clearSelection}
                    />
                )
            }
            if (
                selectedNode.type === SYSTEM_GROUP_TYPE ||
                selectedNode.type === SYSTEM_TEXT_TYPE
            ) {
                return (
                    <ContainerInspector
                        node={selectedNode}
                        onPatchGroup={patchGroupNodeData}
                        onPatchText={patchTextNodeData}
                        onDelete={deleteNode}
                        onClose={clearSelection}
                    />
                )
            }
        }
        return null
    }

    const inspector = renderInspector()

    return (
        <div ref={containerRef} className="h-svh w-svw overflow-hidden">
            <ResizablePanelGroup orientation="horizontal">
                {/* Left rail: icon library + containers. Always present.
            v4 sizes: numbers = pixels, strings ending in `%` = percentages.
            Percentages keep the layout responsive to window width. */}
                <ResizablePanel
                    id="library"
                    defaultSize="18%"
                    minSize="12%"
                    maxSize="32%"
                    className="bg-background"
                >
                    <IconSidebar side="left" />
                </ResizablePanel>

                <ResizableHandle />

                {/* Canvas — takes whatever's left of the icon library panel.
                    The inspector floats above this panel, not beside it. */}
                <ResizablePanel id="canvas" defaultSize="82%">
                    <div
                        ref={canvasRef}
                        className="relative h-full w-full"
                        onPointerMove={onPointerMove}
                        onPointerLeave={onPointerLeave}
                        onDragOver={onCanvasDragOver}
                        onDrop={onCanvasDrop}
                    >
                        <ReactFlow
                            nodes={nodesForFlow}
                            edges={edges}
                            nodeTypes={NODE_TYPES}
                            edgeTypes={EDGE_TYPES}
                            onNodesChange={onNodesChange}
                            onEdgesChange={onEdgesChange}
                            onConnect={onConnect}
                            onSelectionChange={onSelectionChange}
                            // Drag-to-pan by default. Hold Shift to lasso-select
                            // (or middle-click drag, which is also still pan).
                            // Meta / Shift / Control act as additive-select
                            // modifiers when clicking individual nodes.
                            connectionMode={ConnectionMode.Loose}
                            multiSelectionKeyCode={["Meta", "Shift", "Control"]}
                            selectionKeyCode="Shift"
                            panOnDrag
                            deleteKeyCode={["Backspace", "Delete"]}
                            defaultEdgeOptions={{
                                type: SYSTEM_EDGE_TYPE,
                                markerEnd: { ...EDGE_MARKER_END },
                            }}
                            fitView
                            fitViewOptions={{ padding: 0.4 }}
                            minZoom={0.2}
                            maxZoom={2.5}
                            proOptions={{ hideAttribution: true }}
                            className="bg-background"
                        >
                            <Background gap={32} size={1} color="var(--border)" />
                            <Controls
                                showInteractive={false}
                                position="bottom-left"
                                className={cn(
                                    "!rounded-xl !border-border/50 !bg-background/90 !shadow-sm !backdrop-blur-md",
                                    "[&>button]:!border-border/30 [&>button]:!bg-transparent [&>button]:!text-muted-foreground",
                                    "[&>button:hover]:!bg-muted [&>button:hover]:!text-foreground"
                                )}
                            />

                            <Panel position="top-left">
                                <div className="flex items-center gap-2 rounded-full border border-border/60 bg-card px-2 py-1 shadow-sm backdrop-blur-md">
                                    <Button
                                        size="xs"
                                        variant="ghost"
                                        nativeButton={false}
                                        render={<Link href="/projects" />}
                                    >
                                        ← Projects
                                    </Button>
                                    <span className="h-3 w-px bg-border" aria-hidden />
                                    <span className="text-xs font-medium">{project.name}</span>
                                    <span className="h-3 w-px bg-border" aria-hidden />
                                    <span
                                        className={cn(
                                            "size-1.5 rounded-full",
                                            status === "connected" && "bg-emerald-500",
                                            status === "connecting" && "animate-pulse bg-amber-500",
                                            status === "disconnected" && "bg-rose-500"
                                        )}
                                        aria-hidden
                                        title={status}
                                    />
                                    <span className="pr-1 text-[11px] capitalize text-muted-foreground">
                                        {status}
                                    </span>
                                </div>
                            </Panel>

                            <Panel position="top-right">
                                <div className="flex items-center gap-2 rounded-full border border-border/60 bg-card px-2 py-1 shadow-sm backdrop-blur-md">
                                    <PresenceStack me={presence} others={collaborators} />
                                    <Button size="xs" variant="ghost" onClick={copyShareLink}>
                                        {shareCopied ? "Link copied" : "Share"}
                                    </Button>
                                </div>
                            </Panel>
                        </ReactFlow>

                        {/* Centered empty-state hint — sits above the canvas, ignores
                pointer events so users can still pan/zoom underneath. */}
                        {nodes.length === 0 && status !== "connecting" && (
                            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                                <div className="flex max-w-sm flex-col items-center gap-2 rounded-2xl border border-dashed border-border bg-background/80 px-6 py-5 text-center shadow-sm backdrop-blur">
                                    <span className="text-sm font-medium">
                                        Start with a system component
                                    </span>
                                    <span className="text-xs leading-relaxed text-muted-foreground">
                                        Drag any icon from the left sidebar onto the canvas. Drop
                                        a{" "}
                                        <span className="font-medium text-foreground">Group</span>{" "}
                                        to bound a region, then drop icons inside. Click an edge
                                        to describe the API call between two components.
                                    </span>
                                </div>
                            </div>
                        )}

                        <ActionToolbar
                            onUndo={undo}
                            onRedo={redo}
                            canUndo={canUndo}
                            canRedo={canRedo}
                            onAddGroup={addGroupAtViewportCenter}
                            onAddText={addTextAtViewportCenter}
                            onAutoLayout={runAutoLayout}
                            canAutoLayout={nodes.length > 0}
                        />

                        <CanvasAgent
                            getCanvasContext={agentApi.getCanvasContext}
                            beginSession={agentApi.beginSession}
                            applyOp={agentApi.applyOp}
                            finishSession={agentApi.finishSession}
                        />

                        {/* Floating inspector — anchored top-right of the
                            canvas, draggable by its header. Mounted only
                            when something is selected; the panelKey reset
                            drops it back to its anchor on each new selection
                            so it can't get lost. */}
                        {inspector && selection && (
                            <FloatingInspector
                                panelKey={`${selection.kind}:${selection.id}`}
                            >
                                {inspector}
                            </FloatingInspector>
                        )}

                        <RemoteCursors collaborators={collaborators} />
                    </div>
                </ResizablePanel>
            </ResizablePanelGroup>
        </div>
    )
}

/**
 * React Flow needs parent group nodes to appear in the array *before* their
 * children, otherwise child positions are interpreted as absolute and they
 * leap out of the group on first render. Yjs maps don't preserve insertion
 * order across clients, so we sort defensively after every snapshot.
 */
function sortByGroupParenting(list: Node[]): Node[] {
    const groups: Node[] = []
    const others: Node[] = []
    for (const n of list) {
        if (n.type === SYSTEM_GROUP_TYPE) groups.push(n)
        else others.push(n)
    }
    return [...groups, ...others]
}

/**
 * Find the topmost group whose bounding box contains the given flow-space
 * position. Used to decide whether a freshly-dropped icon should be
 * parented to a group.
 */
function findGroupAtPosition(
    nodes: Node[],
    pos: { x: number; y: number }
): Node | null {
    // Iterate in reverse so the most recently added group wins ties (matches
    // the visual stacking order).
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
        const n = nodes[i]
        if (n.type !== SYSTEM_GROUP_TYPE) continue
        const w = n.width ?? n.measured?.width ?? GROUP_DEFAULT_SIZE.width
        const h = n.height ?? n.measured?.height ?? GROUP_DEFAULT_SIZE.height
        if (
            pos.x >= n.position.x &&
            pos.x <= n.position.x + w &&
            pos.y >= n.position.y &&
            pos.y <= n.position.y + h
        ) {
            return n
        }
    }
    return null
}

/**
 * Strip per-client UI state (selection, dragging, resizing) and runtime
 * handler functions from a node before storing it in Yjs.
 *
 * Yjs maps require JSON-friendly values, and these flags are inherently
 * local — broadcasting `selected: true` would pop the inspector for every
 * collaborator the moment one user clicked a node.
 */
function stripNodeRuntime(node: Node): Node {
    const cleaned: Node = { ...node }
    delete (cleaned as { selected?: boolean }).selected
    delete (cleaned as { dragging?: boolean }).dragging
    delete (cleaned as { resizing?: boolean }).resizing
    if (cleaned.data && typeof cleaned.data === "object") {
        const data = cleaned.data as Record<string, unknown>
        if (typeof data.onUpdate === "function") {
            const { onUpdate: _drop, ...rest } = data
            void _drop
            cleaned.data = rest
        }
    }
    return cleaned
}

/** Same idea for edges — selection state is per-client only. */
function stripEdgeRuntime(edge: Edge): Edge {
    const cleaned: Edge = { ...edge }
    delete (cleaned as { selected?: boolean }).selected
    return cleaned
}

function PresenceStack({
    me,
    others,
}: {
    me: { name: string; color: string }
    others: CollaboratorPresence[]
}) {
    const all = [
        { id: -1, name: me.name, color: me.color, isMe: true },
        ...others,
    ]
    return (
        <div className="flex -space-x-2">
            {all.slice(0, 5).map((u) => (
                <div
                    key={u.id}
                    title={`${u.name}${"isMe" in u && u.isMe ? " (you)" : ""}`}
                    className="flex size-6 items-center justify-center rounded-full border-2 border-background text-[10px] font-semibold text-white"
                    style={{ backgroundColor: u.color }}
                >
                    {u.name
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
            {collaborators.map((u) =>
                u.cursor ? (
                    <div
                        key={u.id}
                        className="absolute -translate-x-1 -translate-y-1 transition-transform duration-75"
                        style={{
                            left: `${u.cursor.x * 100}%`,
                            top: `${u.cursor.y * 100}%`,
                            color: u.color,
                        }}
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M5 3l14 8-6 1-3 6-5-15z" />
                        </svg>
                        <div
                            className="-mt-2 ml-3 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium text-white"
                            style={{ backgroundColor: u.color }}
                        >
                            {u.name}
                        </div>
                    </div>
                ) : null
            )}
        </div>
    )
}

export function CollabFlow(props: CollabFlowProps) {
    return (
        <ReactFlowProvider>
            <CollabFlowInner {...props} />
        </ReactFlowProvider>
    )
}
