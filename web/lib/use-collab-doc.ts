"use client"

import { HocuspocusProvider } from "@hocuspocus/provider"
import type { Edge, Node } from "@xyflow/react"
import { useEffect, useMemo, useRef, useState } from "react"
import * as Y from "yjs"

import { sortByGroupParenting } from "@/components/system-design/flow-types"
import {
  FLOW_EDGES_KEY,
  FLOW_NODES_KEY,
  colorForUser,
  getWsUrl,
  type CollaboratorPresence,
  type PresenceKind,
  type PresenceMe,
} from "@/lib/collab"

export type CollabDocUser = {
  id: string
  name: string
  kind: PresenceKind
}

export type CollabStatus = "connecting" | "connected" | "disconnected"

export type UseCollabDocResult = {
  ydoc: Y.Doc
  ynodes: Y.Map<Node>
  yedges: Y.Map<Edge>
  providerRef: React.MutableRefObject<HocuspocusProvider | null>
  status: CollabStatus
  nodes: Node[]
  edges: Edge[]
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>
  setEdges: React.Dispatch<React.SetStateAction<Edge[]>>
  collaborators: CollaboratorPresence[]
  presence: PresenceMe
  applyingRemote: React.MutableRefObject<boolean>
}

export function useCollabDoc({
  projectId,
  user,
  passive = false,
}: {
  projectId: string
  user: CollabDocUser
  passive?: boolean
}): UseCollabDocResult {
  const ydoc = useMemo(() => new Y.Doc(), [])
  const ynodes = useMemo(() => ydoc.getMap<Node>(FLOW_NODES_KEY), [ydoc])
  const yedges = useMemo(() => ydoc.getMap<Edge>(FLOW_EDGES_KEY), [ydoc])

  const presence = useMemo<PresenceMe>(
    () => ({
      name: user.name,
      color: colorForUser(user.id),
      kind: user.kind,
    }),
    [user.id, user.name, user.kind]
  )

  const wsUrl = useMemo(() => getWsUrl(), [])

  const [status, setStatus] = useState<CollabStatus>("connecting")
  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [collaborators, setCollaborators] = useState<CollaboratorPresence[]>([])

  const providerRef = useRef<HocuspocusProvider | null>(null)
  const applyingRemote = useRef(false)

  useEffect(() => {
    const snapshotNodes = (): Node[] => {
      const list: Node[] = []
      ynodes.forEach((value) => list.push(value))
      return sortByGroupParenting(list)
    }
    const snapshotEdges = (): Edge[] => {
      const list: Edge[] = []
      yedges.forEach((value) => list.push(value))
      return list
    }

    const p = new HocuspocusProvider({
      url: wsUrl,
      name: projectId,
      document: ydoc,
      onStatus: ({ status: s }) => {
        if (s === "connected") setStatus("connected")
        else if (s === "connecting") setStatus("connecting")
        else setStatus("disconnected")
      },
    })
    providerRef.current = p

    if (!passive) {
      p.awareness?.setLocalStateField("user", {
        name: presence.name,
        color: presence.color,
        kind: presence.kind,
      })
    }

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
      const awareness = p.awareness
      if (!awareness) return
      const states = awareness.getStates()
      const others: CollaboratorPresence[] = []
      states.forEach((state, clientId) => {
        if (clientId === awareness.clientID) return
        const u = state?.user as
          | { name?: string; color?: string; kind?: PresenceKind }
          | undefined
        const cursor = state?.cursor as
          | { x: number; y: number }
          | null
          | undefined
        if (!u?.name || !u?.color) return
        others.push({
          id: clientId,
          name: u.name,
          color: u.color,
          kind: u.kind === "agent" ? "agent" : "human",
          cursor: cursor ?? null,
        })
      })
      setCollaborators(others)
    }
    p.awareness?.on("change", onAwarenessChange)

    return () => {
      ynodes.unobserveDeep(onNodesObserve)
      yedges.unobserveDeep(onEdgesObserve)
      p.awareness?.off("change", onAwarenessChange)
      if (!passive) p.awareness?.setLocalState(null)
      p.destroy()
      if (providerRef.current === p) providerRef.current = null
    }
  }, [ydoc, ynodes, yedges, presence, projectId, wsUrl, passive])

  return {
    ydoc,
    ynodes,
    yedges,
    providerRef,
    status,
    nodes,
    edges,
    setNodes,
    setEdges,
    collaborators,
    presence,
    applyingRemote,
  }
}
