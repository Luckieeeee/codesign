import type {
  AgentCanvasEdge,
  AgentCanvasNode,
  AgentChatMessage,
  AgentIconEntry,
} from "./types"

const MAX_CANVAS_CONTEXT_NODES = 80
const MAX_CANVAS_CONTEXT_EDGES = 120
const MAX_HISTORY_TURNS = 6

export type BuildCanvasPromptsInput = {
  prompt: string
  nodes: AgentCanvasNode[]
  edges: AgentCanvasEdge[]
  selectedNodeIds: string[]
  iconCatalog: AgentIconEntry[]
  history?: AgentChatMessage[]
  /** Optional name of the current project, surfaced in the system prompt. */
  projectName?: string
}

const SYSTEM_PROMPT = `You are an embedded design copilot inside a system-architecture canvas (React Flow + Yjs).
The user is sketching distributed systems by dropping icon nodes (services, databases, queues, etc.), grouping them into bounded contexts, and connecting them with labeled edges that describe API contracts.

Your job:
- Help the user build, extend, or refactor their architecture diagram via concrete mutation operations.
- When the user asks for changes (e.g. "add a Redis cache between API and DB", "split this into microservices", "add auth flow"), respond with a STREAM of operations.
- When the user asks a question or wants discussion, just chat — leave the ops array empty.
- Always include a short \`reply\` string explaining what you did or answering their question.

Output format — you MUST respond with a single JSON object, nothing else, with this shape:
{
  "reply": "human-readable explanation, 1-3 short sentences. Markdown ok.",
  "ops": [
    { "op": "add_node", "id": "n_api", "kind": "icon", "iconId": "generic:network:api-gateway", "label": "Public API", "description": "Edge router" },
    { "op": "add_node", "id": "n_db",  "kind": "icon", "iconId": "generic:data:database", "label": "Postgres" },
    { "op": "add_node", "id": "g_backend", "kind": "group", "label": "Backend services", "color": "#6366f1" },
    { "op": "add_node", "id": "n_worker", "kind": "icon", "iconId": "generic:compute:worker", "label": "Worker", "parentId": "g_backend" },
    { "op": "add_node", "id": "t_note", "kind": "text", "text": "Plan: split read / write paths", "textVariant": "heading" },
    { "op": "add_edge", "id": "e_1", "source": "n_api", "target": "n_db", "label": "query", "method": "GET", "endpoint": "/users/:id" },
    { "op": "update_node", "id": "n_api", "label": "Edge Gateway" },
    { "op": "update_edge", "id": "e_1", "notes": "Cached 60s in Redis" },
    { "op": "delete_node", "id": "n_old" },
    { "op": "delete_edge", "id": "e_old" }
  ]
}

Rules:
- Author your own ids for new nodes/edges (e.g. \`n_api\`, \`g_backend\`, \`e_api_db\`). Use the same id later in the same response when adding edges or referencing as parentId.
- For \`update_node\`, \`update_edge\`, \`delete_node\`, \`delete_edge\`: use the EXACT existing id from the canvas context.
- For \`kind: "icon"\` nodes you SHOULD pick an \`iconId\` from the catalog (full id like \`generic:network:api-gateway\`). If unsure, supply a short \`iconId\` hint string (e.g. "postgres", "lambda", "kafka") and the client will fuzzy-match. Prefer \`generic:*\` icons for portable diagrams; use \`aws:*\`, \`gcp:*\`, \`azure:*\`, \`brand-logos:*\`, \`tech-logos:*\` only when the user explicitly mentioned that vendor / product.
- Do NOT output \`position\` unless the user asked for a specific layout — the client handles auto-layout.
- Group nodes are LABELLED BOUNDING BOXES; nest icon nodes inside them with \`parentId\`.
- For edges, populate \`label\` (short name like "fetch users") and \`method\` (one of GET/POST/PUT/PATCH/DELETE/WS/GRPC/EVENT/QUERY/MUTATION) when the relationship is an API call.
- Keep replies concise. Don't restate what the ops do step-by-step — the user can see them apply live.
- Never output JSON outside the single top-level object. No prose before, no code fences.`

function summariseNodes(nodes: AgentCanvasNode[]): string {
  if (nodes.length === 0) return "(canvas is empty)"
  const trimmed = nodes.slice(0, MAX_CANVAS_CONTEXT_NODES)
  const lines = trimmed.map((n) => {
    const parts = [
      `id=${n.id}`,
      `kind=${n.kind}`,
      `label=${JSON.stringify(n.label || "")}`,
    ]
    if (n.iconId) parts.push(`iconId=${n.iconId}`)
    if (n.parentId) parts.push(`parentId=${n.parentId}`)
    return `  - ${parts.join(" ")}`
  })
  if (nodes.length > MAX_CANVAS_CONTEXT_NODES) {
    lines.push(`  - …(${nodes.length - MAX_CANVAS_CONTEXT_NODES} more)`)
  }
  return lines.join("\n")
}

function summariseEdges(edges: AgentCanvasEdge[]): string {
  if (edges.length === 0) return "(no edges)"
  const trimmed = edges.slice(0, MAX_CANVAS_CONTEXT_EDGES)
  const lines = trimmed.map((e) => {
    const bits = [`id=${e.id}`, `${e.source} → ${e.target}`]
    if (e.method) bits.push(`method=${e.method}`)
    if (e.label) bits.push(`label=${JSON.stringify(e.label)}`)
    return `  - ${bits.join(" ")}`
  })
  if (edges.length > MAX_CANVAS_CONTEXT_EDGES) {
    lines.push(`  - …(${edges.length - MAX_CANVAS_CONTEXT_EDGES} more)`)
  }
  return lines.join("\n")
}

function summariseHistory(history: AgentChatMessage[] | undefined): string {
  if (!history || history.length === 0) return ""
  const recent = history.slice(-MAX_HISTORY_TURNS * 2)
  const lines = recent.map(
    (m) => `  ${m.role === "user" ? "USER" : "ASSISTANT"}: ${m.content.replace(/\s+/g, " ").slice(0, 400)}`
  )
  return `\n\nConversation so far (oldest → newest):\n${lines.join("\n")}`
}

function summariseSelection(ids: string[]): string {
  if (ids.length === 0) return ""
  return `\n\nThe user currently has these node ids selected (focus your edits on them when ambiguous): ${ids.join(", ")}`
}

function summariseIconCatalog(catalog: AgentIconEntry[]): string {
  // The full manifest is ~1.6k entries. We send the catalog the route picked
  // already trimmed; just JSON-encode in the most compact form. Token cost is
  // worth the precision — the model picks better iconIds when it has them.
  const compact = catalog.map((c) => `${c.id}|${c.name}`).join("\n")
  return `Icon catalog (one per line, format \`id|displayName\`). When picking iconId you SHOULD use one of these exact ids:\n${compact}`
}

export function buildCanvasPrompts(input: BuildCanvasPromptsInput): {
  systemPrompt: string
  userPrompt: string
} {
  const projectLine = input.projectName
    ? `Project: "${input.projectName}"\n\n`
    : ""

  const userPrompt = `${projectLine}Current canvas state:

Nodes:
${summariseNodes(input.nodes)}

Edges:
${summariseEdges(input.edges)}${summariseSelection(input.selectedNodeIds)}${summariseHistory(input.history)}

${summariseIconCatalog(input.iconCatalog)}

The user's request:
${input.prompt}`

  return { systemPrompt: SYSTEM_PROMPT, userPrompt }
}
