/**
 * Operation types the AI agent emits to mutate the system-design canvas.
 *
 * The model streams a JSON object of shape `{ "ops": [ ...op objects ] }`.
 * Each op corresponds to a single mutation on the React Flow / Yjs document.
 * Ids are author-supplied so the model can reference newly-created nodes in
 * subsequent edge ops within the same response.
 */

export type AgentNodeKind = "icon" | "group" | "text"

export type AgentPosition = { x: number; y: number }

export type AgentAddNodeOp = {
  op: "add_node"
  id: string
  kind: AgentNodeKind
  /**
   * For `kind: "icon"` only. Either an exact manifest id (e.g.
   * `generic:network:api-gateway`) or a free-form hint we'll fuzzy-match
   * against the manifest client-side (e.g. "postgres", "lambda").
   */
  iconId?: string
  label?: string
  description?: string
  /** For text nodes — the body content. */
  text?: string
  textVariant?: "heading" | "body"
  /** For group nodes — accent colour swatch (hex). */
  color?: string
  /** Optional explicit placement. If omitted, the client auto-lays-out. */
  position?: AgentPosition
  width?: number
  height?: number
  /** Reference an existing group id (or another node added in this response). */
  parentId?: string
}

export type AgentAddEdgeOp = {
  op: "add_edge"
  id: string
  source: string
  target: string
  label?: string
  method?: string
  endpoint?: string
  notes?: string
  request?: string
  response?: string
}

export type AgentUpdateNodeOp = {
  op: "update_node"
  id: string
  label?: string
  description?: string
  text?: string
  iconId?: string
  color?: string
  position?: AgentPosition
}

export type AgentUpdateEdgeOp = {
  op: "update_edge"
  id: string
  label?: string
  method?: string
  endpoint?: string
  notes?: string
  request?: string
  response?: string
}

export type AgentDeleteNodeOp = { op: "delete_node"; id: string }
export type AgentDeleteEdgeOp = { op: "delete_edge"; id: string }

export type AgentOp =
  | AgentAddNodeOp
  | AgentAddEdgeOp
  | AgentUpdateNodeOp
  | AgentUpdateEdgeOp
  | AgentDeleteNodeOp
  | AgentDeleteEdgeOp

/** Compact view of an existing node sent to the model as context. */
export type AgentCanvasNode = {
  id: string
  kind: AgentNodeKind
  label: string
  iconId?: string
  parentId?: string
  position?: AgentPosition
}

export type AgentCanvasEdge = {
  id: string
  source: string
  target: string
  label?: string
  method?: string
}

/** Compact icon entry sent to the model so it can pick by id. */
export type AgentIconEntry = {
  id: string
  name: string
}

export type AgentChatMessage = {
  role: "user" | "assistant"
  content: string
}
