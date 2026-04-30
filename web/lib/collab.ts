export const FLOW_NODES_KEY = "flow:nodes"

export const FLOW_EDGES_KEY = "flow:edges"

export const PRESENCE_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
] as const

export function colorForUser(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0
  }
  const idx = Math.abs(hash) % PRESENCE_COLORS.length
  return PRESENCE_COLORS[idx] as string
}

export function getWsUrl(): string {
  const fromEnv = process.env.NEXT_PUBLIC_COLLAB_WS_URL
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv
  return "ws://localhost:1234"
}

export type PresenceKind = "human" | "agent"

export type PresenceMe = {
  name: string
  color: string
  kind: PresenceKind
}

export type CollaboratorPresence = {
  id: number
  name: string
  color: string
  kind: PresenceKind
  cursor: { x: number; y: number } | null
}
