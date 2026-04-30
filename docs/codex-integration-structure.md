# Codex Integration Structure

This is the Codex-specific layer that should sit on top of the HTTP agent
bridge described in `docs/agent-bridge-plan.md`.

## Official integration surfaces checked

- Codex uses MCP when the needed context or actions live outside the repo.
  Codex supports STDIO and Streamable HTTP MCP servers, and custom MCP
  servers can be added through the app settings or `codex mcp add`.
  Source: https://developers.openai.com/codex/learn/best-practices#use-mcps-for-external-context
- Codex MCP settings apply across the Codex app, CLI, and IDE extension
  because configuration lives in `config.toml`.
  Source: https://developers.openai.com/codex/app/settings#integrations--mcp
- An MCP server exposes tools with JSON Schema contracts, handles tool calls,
  and can optionally return UI components for ChatGPT Apps.
  Source: https://developers.openai.com/apps-sdk/concepts/mcp-server#protocol-building-blocks
- Skills are the right place for reusable Codex workflows: a `SKILL.md` plus
  optional scripts, references, and assets. Plugins are the distribution unit
  when a workflow should bundle skills, app integrations, and MCP servers.
  Sources:
  https://developers.openai.com/codex/concepts/customization#skills
  https://developers.openai.com/codex/plugins#overview
- For a product-owned AI assistant inside Codesign, use the Responses API or
  Agents SDK. Responses supports custom functions and remote MCP servers in an
  agentic loop. Agents SDK is the better fit when we need code-first
  orchestration, handoffs, guardrails, tracing, or sandbox execution.
  Sources:
  https://developers.openai.com/api/docs/guides/migrate-to-responses#responses-benefits
  https://developers.openai.com/api/docs/libraries#install-the-agents-sdk
- Codex App Server is a separate, advanced integration surface for hosting
  Codex threads directly. It includes thread start/resume and approval flows.
  Treat this as later-stage product embedding, not the first integration path.
  Source: https://developers.openai.com/codex/app-server#start-or-resume-a-thread

## Recommendation

Build the integration in layers:

1. **Diagram core:** one canonical graph model, validation, revision tokens,
   edit operations, icon search, layout, and export.
2. **HTTP agent bridge:** the existing planned `/projects/{id}/snapshot`,
   `/state`, `/nodes/{id}`, and `/edit` routes over the live Hocuspocus/Yjs
   document.
3. **Codex skill:** repo-local workflow instructions that teach Codex how to
   inspect, edit, validate, and verify Codesign diagrams.
4. **MCP server:** a thin adapter exposing the same bridge/core operations to
   Codex as well-described tools.
5. **Optional product surfaces:** an in-app assistant via Responses/Agents SDK,
   and later a ChatGPT Apps SDK canvas component if we want the diagram UI
   rendered inside ChatGPT.

The important rule: Codex should operate on structured graph operations, not
raw SVG, free-form coordinates, or uncontrolled React Flow internals.

## Canonical graph model

React Flow can remain the renderer, but the app needs a stable model inside
`node.data` / `edge.data`:

```ts
type DiagramNodeData = {
  label: string
  iconId?: string
  componentKind?:
    | "client"
    | "service"
    | "database"
    | "cache"
    | "queue"
    | "stream"
    | "gateway"
    | "load-balancer"
    | "cdn"
    | "storage"
    | "worker"
    | "external"
    | "boundary"
  description?: string
  provider?: "aws" | "gcp" | "azure" | "kubernetes" | "generic" | "brand"
  tags?: string[]
  properties?: Record<string, unknown>
  __codesign?: {
    author: string
    runId?: string
    at: string
  }
}

type DiagramEdgeData = {
  label?: string
  protocol?: "http" | "grpc" | "websocket" | "tcp" | "udp" | "sql" | "event"
  flowKind?: "sync" | "async" | "stream" | "replication" | "control"
  reliability?: "best-effort" | "at-least-once" | "at-most-once" | "exactly-once"
  __codesign?: {
    author: string
    runId?: string
    at: string
  }
}
```

Add a Zod schema around this model and migrate existing seed nodes into it.
That gives Codex a contract it can safely modify.

## MCP tool surface

Keep the first MCP server small. Suggested v1 tools:

| Tool | Purpose |
| --- | --- |
| `codesign_project_snapshot` | Cheap read: ids, labels, positions, types, current revision |
| `codesign_project_state` | Full read: nodes, edges, data, groups, metadata |
| `codesign_project_neighborhood` | Focused read around one node for context-efficient edits |
| `codesign_project_edit` | Apply an idempotent `ops[]` batch with `baseRevision` |
| `codesign_icons_search` | Search `icons/manifest.json` by provider, category, label, tags |
| `codesign_diagram_validate` | Return architecture issues: dangling edges, missing labels, no ingress, SPOFs, unprotected data stores, unclear async paths |
| `codesign_diagram_export` | Export SVG/PNG/JSON when the renderer exists |

Avoid exposing many tiny tools like `moveNodeX`, `setLabel`, `setIcon`,
`setEdgeProtocol`. A single `edit` batch is easier to review, retry,
idempotently replay, and guard with revision checks.

`codesign_project_edit` should accept graph operations like:

```ts
type EditOp =
  | { op: "addNode"; node: { id?: string; position: { x: number; y: number }; data: DiagramNodeData } }
  | { op: "updateNode"; id: string; patch: { position?: { x: number; y: number }; data?: Partial<DiagramNodeData> } }
  | { op: "deleteNode"; id: string; cascadeEdges?: boolean }
  | { op: "addEdge"; edge: { id?: string; source: string; target: string; data?: DiagramEdgeData } }
  | { op: "updateEdge"; id: string; patch: { data?: Partial<DiagramEdgeData>; source?: string; target?: string } }
  | { op: "deleteEdge"; id: string }
```

## Repo layout

Use the existing `web/` app and the planned `flow-core` split:

```txt
docs/
  agent-bridge-plan.md
  codex-integration-structure.md

icons/
  manifest.json
  task-queue.json

web/lib/flow-core/
  document.ts
  graph.ts
  operations.ts
  revision.ts
  snapshot.ts
  types.ts
  errors.ts

web/lib/icon-core/
  manifest.ts
  search.ts
  normalize.ts

web/scripts/agent-bridge/
  routes.ts
  auth.ts
  idempotency.ts
  rate-limit.ts

web/scripts/codesign-mcp/
  server.ts
  tools/
    project-snapshot.ts
    project-state.ts
    project-neighborhood.ts
    project-edit.ts
    icons-search.ts
    diagram-validate.ts

.agents/skills/codesign-diagram/
  SKILL.md
  references/
    graph-model.md
    edit-ops.md
    validation-rules.md
  scripts/
    validate-diagram.ts
    audit-icons.ts
```

If this becomes something teams install across repos, wrap the skill and MCP
server in a Codex plugin later. For now, repo-local `.agents/skills` is enough.

## Codex skill behavior

The skill should teach Codex these routines:

- Read a project snapshot before editing.
- Search the icon manifest before inventing icon ids.
- Prefer `codesign_project_edit` over direct file or canvas mutation.
- Always send `baseRevision` and an idempotency key.
- On `STALE_REVISION`, re-read the snapshot and replan.
- After editing, validate the diagram and summarize what changed.
- For repo artifacts, run `bun run typecheck` and relevant validation scripts.

The skill should also define diagram review heuristics:

- Are ingress, egress, storage, compute, async paths, and trust boundaries clear?
- Are critical components single points of failure?
- Are queues, retries, dead letters, cache invalidation, and rate limits shown?
- Are private data stores protected by auth/network boundaries?
- Are labels specific enough for an engineer to understand data flow?
- Are cloud/vendor icons mixed with generic icons in a consistent visual style?

## In-app assistant

If Codesign itself has an AI panel, use Responses API first unless the workflow
becomes multi-agent. The assistant can call the same internal functions as MCP:

1. `getSnapshot(projectId)`
2. `searchIcons(query, filters)`
3. `proposeEdit(prompt, snapshot)`
4. `applyEdit(projectId, baseRevision, ops, mode: "dryRun" | "commit")`
5. `validateDiagram(projectId)`

Use Agents SDK only when we need planner/reviewer/executor separation,
handoffs, guardrails, tracing, or long-running workflows.

## ChatGPT Apps SDK path

This is useful if the product goal is "open and manipulate a Codesign diagram
inside ChatGPT." It would reuse the same MCP server, but add:

- A tool that returns a UI component resource.
- A hosted React canvas bundle for the embedded iframe.
- A bridge from component actions back into `codesign_project_edit`.

This is later than Codex MCP because it adds UI packaging and auth complexity.

## Build order

1. Finish the HTTP agent bridge from `docs/agent-bridge-plan.md`.
2. Add typed `DiagramNodeData` / `DiagramEdgeData` and icon ids to the current
   React Flow node data model.
3. Implement `web/lib/icon-core/search.ts` over `icons/manifest.json`.
4. Add `codesign_diagram_validate` as a pure local validator.
5. Add a repo-local `.agents/skills/codesign-diagram/SKILL.md`.
6. Add the MCP server as a thin wrapper around HTTP bridge/core functions.
7. Add optional in-app AI assistant using the same core functions.
8. Only then consider plugin packaging or ChatGPT Apps SDK embedding.

## Non-goals for v1

- Do not make Codex edit raw SVG exports.
- Do not expose arbitrary SQL, Supabase, or Yjs mutation tools.
- Do not allow cross-project reads without explicit project scoping.
- Do not let model-generated icons enter the official manifest without review.
- Do not make layout nondeterministic; agents need stable diffs.
