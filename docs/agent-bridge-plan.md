# Plan: HTTP Agent Bridge for the codesign React Flow / Yjs canvas

> **Phase 1 (this plan): the external HTTP agent bridge.** It mutates the
> live `Y.Doc` *through* the existing Hocuspocus server, so live broadcast
> to browsers and Supabase persistence are inherited for free.
>
> Codex / MCP / SKILL.md / in-app tRPC / AI-assist mutations are deferred
> to Phase 2 (a follow-up roadmap is at the end of this doc).

## Verified current state of `codesign/web`

Confirmed by reading `web/scripts/collab-server.ts` and
`web/components/collab-flow.tsx`:

- **Yjs sync runs on Hocuspocus**, not raw y-websocket.
  - Server uses `new Hocuspocus({ name: "codesign", extensions: [...] })`
    with `@hocuspocus/extension-database` (fetch/store base64 blobs to
    Supabase `project_documents.state_b64`).
  - Browser uses `@hocuspocus/provider`'s `HocuspocusProvider`.
  - Single port (default `1234`) serves **both** the WS upgrade for
    Hocuspocus **and** an HTTP API at `/api/projects/*` via
    `node:http.createServer`. We mount agent routes inside that same
    handler — no second port.
- **Document name = `projectId`** (a slug like `my-project-3`). Browsers
  open `HocuspocusProvider({ name: project.id })`; the Database extension
  is keyed on `project_id`. Same id = same `Y.Doc`.
- **The graph state is two `Y.Map`s** on the doc: `flow:nodes` and
  `flow:edges`. Each value is a whole React Flow node/edge object —
  updating one node means replacing that map entry. **Nested `data` keys
  are not independently CRDT-merged** — strict revision checks are what
  make multi-writer safe, not magic convergence.
- Persistence is wired via Hocuspocus's Database extension; **anything
  that mutates the live doc is auto-persisted** on the standard debounce.
- `Y.transact` is *not* a SQL transaction — it batches notifications and
  bundles updates into one broadcast, but throwing mid-callback does
  **not** roll back prior writes inside that callback. **We avoid the
  problem by validating against a plain-JS projection first and only
  writing to the live `Y.Map`s after every op has been validated** — so
  a failure produces zero writes, no rollback needed. (See
  `Edit operations § Why not Y.UndoManager`.)

## Reference: Anthill's implementation

`/Users/sidvas/Documents/anthill/collab/src/agent-bridge.ts` is the
working blueprint. Key techniques we lift verbatim:

- **`hocuspocus.openDirectConnection(documentName, ctx)`** returns a
  `DirectConnection` with `.document` (the live `Y.Doc`) and
  `.transact(fn)`. The bridge **caches one warm connection per doc** in
  a `Map<docId, Promise<DirectConnection>>`.
- **`computeRevision(doc) = "rev1_" + fnv(Y.encodeStateVector(doc))`** —
  a string token that bumps on **every** update (browser drag, agent op,
  another agent's edit). This is the only correct stale-detection unit.
- **`Y.UndoManager` (deliberately NOT used by us)**: Anthill uses
  UndoManager to roll back partial writes inside a failed batch. We
  diverge here — the validate-then-commit two-phase design avoids
  emitting any partial writes in the first place. See
  `Edit operations § Why not Y.UndoManager` for the full reasoning.
  We still copy the rest of Anthill's blueprint verbatim.
- **`IdempotencyCache`** — TTL'd LRU keyed by an opaque key, storing
  `{ bodyHash, response }`. Same key + same body → cached response;
  same key + different body → `409 IDEMPOTENCY_KEY_REUSED_DIFFERENT_BODY`.
- **`X-Agent-*` header set**: `X-Agent-Token`, `X-Agent-Id` (required),
  `X-Agent-Name`, `X-Agent-Run-Id`, `Idempotency-Key`.
- **Stale-revision check FIRST**, before op validation, so a stale
  agent gets `409 STALE_REVISION` instead of a misleading
  `404 NODE_NOT_FOUND`.

What we change vs Anthill: payload is **graph-shaped** (nodes + edges)
instead of Plate blocks; provenance is **namespaced** under
`data.__codesign` to avoid colliding with app fields; we mount on the
**existing single port** instead of a sidecar port.

## Architecture

```
                  ┌─────────────────────────────────────────────┐
                  │   collab-server.ts  (single port, e.g. 1234)│
  Browser ───WS──▶│   ┌──────────────┐                          │
  (HocuspocusProvider) │ Hocuspocus 4 │  ─── load/store ──▶ Supabase
                  │   │  + Database  │  ◀── (state_b64) ──      │
                  │   └──────┬───────┘                          │
                  │          │                                  │
                  │          │  openDirectConnection(projectId) │
                  │          ▼                                  │
                  │   ┌──────────────┐    /projects/{id}/...    │
  Agent  ───HTTP──▶   │ agent-bridge │ ◀────── /.well-known     │
  (curl,Codex,…)  │   └──────────────┘                          │
                  │                                              │
                  │   /api/projects/*    (existing browser API) │
                  └─────────────────────────────────────────────┘
```

The bridge does **not** create or own a `Y.Doc`. It asks Hocuspocus for a
direct connection to the same document the browsers are using. Writes go
through `conn.transact(fn)`, which is captured by Hocuspocus's normal
update pipeline → broadcast to all WS subscribers → Database extension
flushes to Supabase on debounce.

## File layout

```
web/lib/flow-core/                    (pure modules, runtime-agnostic)
  document.ts        // openProjectDoc(hocuspocus, projectId): warm DirectConnection w/ idle TTL (default 5min) + max-size LRU (default 100) + closeAll() for shutdown
  graph.ts           // readNodes(doc) / readEdges(doc) -> Map<id, Node|Edge>; project(doc) -> { nodes, edges }
  revision.ts        // computeRevision(doc) — FNV(Y.encodeStateVector(doc)) -> "rev1_<hex>"
  json-value.ts      // assertJsonValue(value, path?) — recursive validator (replaces JSON.stringify round-trip)
  operations.ts      // applyEdit(conn, ops, identity, opts) — validate-then-commit two-phase (NOT UndoManager); single Y.transact, one broadcast per call
  snapshot.ts        // summary(doc) / state(doc) / neighborhood(doc, id, depth) serialisers
  types.ts           // Zod schemas: EditOp union, EditRequest, all responses; .strict() on update patch shapes
  errors.ts          // AgentError class + JSON formatter + error code enum

web/scripts/agent-bridge/             (HTTP layer, bound to node:http)
  routes.ts          // mountAgentBridge(req, res, ctx): boolean — single dispatcher returning true if route claimed
  auth.ts            // parseAgentHeaders(req) + checkSecret(req, cfg) + bind-policy guard
  idempotency.ts     // IdempotencyCache (anthill clone, slightly tightened)
  rate-limit.ts      // token bucket keyed by (tokenFingerprint, agentId)

web/lib/flow-core/__tests__/          (unit tests, colocated convention from bun test)
  revision.test.ts
  graph.test.ts
  snapshot.test.ts
  json-value.test.ts
  document.test.ts                    // lifecycle: idle TTL eviction, LRU max-size, closeAll() disconnects every cached entry
  operations.test.ts                  // the big one: every op + no-write-on-validation-fail + cascade + provenance + json-value + Zod-strict patch

web/scripts/agent-bridge/__tests__/   (bridge tests — boot Hocuspocus + bridge in-process, fetch against it)
  idempotency.test.ts
  rate-limit.test.ts
  auth.test.ts
  routes.integration.test.ts          // end-to-end through the actual mount, with a fake Supabase

web/scripts/collab-server.ts          // MODIFY: instantiate bridge ctx, dispatch /agent and /projects/{id}/* routes inside existing httpServer handler

web/AGENT_PROMPT.md                   // paste-into-LLM doc; doubles as future Codex SKILL.md source
web/.env.example                      // CODESIGN_AGENT_BRIDGE_SECRET, _ORIGINS, _IDEMPOTENCY_MODE
```

`flow-core/` modules are pure (no top-level side effects, no network /
Supabase imports), so Phase 2 surfaces (in-app tRPC, MCP wrapper, AI
assist) drop in by importing the same primitives.

## Endpoint surface (v1)

External-facing names use product language (`projects`), not internals
(`rooms` / `documents`). All paths sit at the root of the existing
collab server (no `/api/` prefix; that namespace is reserved for the
browser-facing project CRUD that already exists).

| Method | Path                                                     | Purpose                                                                  |
| ------ | -------------------------------------------------------- | ------------------------------------------------------------------------ |
| GET    | `/.well-known/agent.json`                                | Discovery: ops, node/edge fields, auth modes, idempotency policy, version |
| GET    | `/agent-docs`                                            | Returns `AGENT_PROMPT.md` (text/markdown)                                |
| GET    | `/projects/{projectId}/snapshot`                         | High-level view: counts + lightweight node/edge rows, current revision   |
| GET    | `/projects/{projectId}/state`                            | Full view: every node + edge with full `data`                            |
| GET    | `/projects/{projectId}/nodes/{nodeId}?depth=1`           | Focal node + k-hop neighbours and connecting edges                       |
| POST   | `/projects/{projectId}/edit`                             | Apply an `ops[]` array atomically (validate-then-commit inside one Hocuspocus transact) |
| GET    | `/healthz`                                               | Liveness probe                                                           |

(Presence, events log, repair — deferred. See Phase 2.)

## Snapshot vs state vs neighborhood

- **Snapshot** — the agent's default cheap read:

  ```json
  {
    "projectId": "my-project",
    "revision": "rev1_a1b2c3d4e5f60718",
    "nodeCount": 3,
    "edgeCount": 2,
    "hasLiveClients": true,
    "nodes": [{ "id": "1", "type": "input", "position": {"x":0,"y":0}, "label": "👋 Welcome" }, ...],
    "edges": [{ "id": "e1-2", "source": "1", "target": "2", "type": "default" }, ...]
  }
  ```

  Strips `data` to a `label` preview (and `type`, `position`) so
  responses fit comfortably in any LLM context window.

- **State** — same envelope, but full `data` on every node/edge.

- **Neighborhood** (`GET /projects/{id}/nodes/{nodeId}?depth=1`):

  ```json
  {
    "revision": "rev1_...",
    "focal": { ...full node... },
    "neighbours": [ ...nodes within `depth` hops... ],
    "edges":    [ ...edges connecting any pair in {focal} ∪ neighbours... ],
    "incoming": ["e2-1"],
    "outgoing": ["e1-2"]
  }
  ```

  BFS to `depth` (default 1, capped at 5).

## `data` payload is opaque (with one namespaced exception)

The bridge never enforces a schema on `node.data` / `edge.data`. App
schema is whatever the canvas evolves into. The **only** field the
bridge ever writes inside `data` is the namespaced provenance object:

```json
{
  "data": {
    "label": "Checkout",
    "__codesign": {
      "author": "ai:claude-code",
      "runId": "run-abc-123",
      "at": "2026-04-30T12:34:56.789Z"
    }
  }
}
```

Namespacing under `__codesign` (vs anthill's loose `proofAuthor`/
`proofRunId`/`proofAt` keys) avoids any chance of colliding with the
app's own keys. The bridge **never** writes React Flow renderer-owned
fields (`width`, `height`, `measured`, `selected`, `dragging`).

## Edit operations

```ts
type EditOp =
  | { op: "addNode";    node: { id?: string; type?: string; position: { x: number; y: number }; data?: Record<string, unknown> } }
  | { op: "updateNode"; id: string; patch: Partial<Pick<Node, "type" | "position" | "data" | "hidden" | "draggable" | "selectable">> }
  | { op: "deleteNode"; id: string; cascadeEdges?: boolean /* default true */ }
  | { op: "addEdge";    edge: { id?: string; source: string; target: string; type?: string; label?: string; animated?: boolean; data?: Record<string, unknown> } }
  | { op: "updateEdge"; id: string; patch: Partial<Pick<Edge, "type" | "label" | "animated" | "data" | "source" | "target" | "sourceHandle" | "targetHandle">> }
  | { op: "deleteEdge"; id: string };
```

### Request

```json
{
  "by": "ai:claude-code",
  "baseRevision": "rev1_a1b2c3d4e5f60718",
  "ops": [{ "op": "addNode", "node": { "position": { "x": 100, "y": 100 }, "data": { "label": "New" } } }]
}
```

### Behaviour

The bridge runs the entire pipeline inside one `await conn.transact(doc
=> …)`. The key correctness move is **validate-then-commit**: we never
mutate the live `Y.Map`s during validation, so a failure mid-batch
results in zero writes — no rollback needed, no intermediate broadcast.

> **Why not `Y.UndoManager`?** An earlier draft proposed running ops
> directly against the `Y.Map`s and using `Y.UndoManager.undo()` to
> roll back on failure. That approach has two real bugs:
>
> 1. **Undo is itself another Yjs update.** It does not restore the
>    pre-call state vector — so revision tokens advance even on
>    successful rollback, and `revisionAfter === revisionBefore` can't
>    hold post-rollback. Worse, observers see a flicker.
> 2. **Partial writes broadcast before undo lands.** Every `Y.Map.set`
>    inside the failing batch produces an update event that fans out to
>    WS clients before the undo gets a chance to run. Browsers see the
>    bad state.
>
> The validate-then-commit design avoids both: validation runs against
> a plain-JS projection, and Y.Map writes only happen at the end after
> validation has fully succeeded.

In order:

1. **Cap `ops.length ≤ 50`** — `BAD_REQUEST` otherwise.
2. **Per-op JSON-value validation** — for every op carrying a `data`
   field, run a recursive validator (`assertJsonValue`, see below).
   `BAD_REQUEST` on first failure.
3. **Open the transact** — `await conn.transact(doc => { … })` to get
   exclusive serialised access to the live doc. **The callback MUST be
   synchronous.** Hocuspocus 4's `DirectConnection.transact` calls the
   callback without awaiting it
   (`hocuspocus-server.esm.js:893–900`), so async rejections from the
   callback are silently swallowed — they never reach the awaiter and
   you'll get a phantom "success" response with no writes. Spike output
   in `web/scripts/spike-direct-conn.ts` confirms both behaviours.
4. **Stale-revision check FIRST** (inside the transact) — if
   `baseRevision` is supplied and `computeRevision(doc) !==
   baseRevision`, throw `STALE_REVISION` with the latest snapshot
   embedded so the agent can replan in one round-trip. Must come before
   ref validation so an out-of-date agent doesn't see a misleading
   `NODE_NOT_FOUND`.
5. **Project the live state into plain JS Maps** — for each id in
   `nodesMap.keys()`, do `nodesProj.set(id, structuredClone(nodesMap.get(id)))`
   (and similarly for edges). **Do NOT use `Y.Map.toJSON()`** — its
   outer container is fresh, but the per-entry values are the **same
   references** stored in the live map (verified in the spike). A
   `nodesProj.get(id).data.label = "x"` mutation would leak straight
   into the live `Y.Map` before any commit step runs. `structuredClone`
   is the right call: it deep-copies the entry without the validator
   needing to know the schema.
6. **Validate + apply each op against the projection** (no Y writes):
   - `addNode` — mint id if missing (`n-<8hex>`); reject if id collides
     with an existing node; stamp `data.__codesign`; `nodesProj.set(id,
     node)`. Track `audit.created.nodes.push(id)`.
   - `updateNode` — read existing from projection (`NODE_NOT_FOUND`
     otherwise); validate the patch (Zod `.strict()` on a `Pick<Node,
     "type"|"position"|"data"|"hidden"|"draggable"|"selectable">` —
     so unknown top-level keys like `width`, `height`, `measured`,
     `selected`, `dragging` are rejected); shallow-merge top level +
     shallow-merge `data` over the existing entry; restamp
     `data.__codesign`; `nodesProj.set(id, merged)`. Track
     `audit.updated.nodes.push(id)`.
   - `deleteNode` — if `cascadeEdges:true` (default), find every edge
     in `edgesProj` with `source===id||target===id`, delete each from
     `edgesProj`, push to `audit.cascadedEdges`. If `cascadeEdges:false`
     and any such edge exists, throw `EDGES_WOULD_BE_ORPHANED`. Then
     `nodesProj.delete(id)`; `audit.deleted.nodes.push(id)`.
   - `addEdge` — mint id if missing (`e-{src}-{tgt}-<6hex>`); validate
     source/target exist in `nodesProj` (so a prior op in the same
     batch that added a node makes it referenceable, but a same-batch
     edge to a same-batch *server-minted* id is rejected by the
     batch-reference rule below); stamp provenance; `edgesProj.set`.
   - `updateEdge` — symmetric to `updateNode`; if `source`/`target` is
     in the patch, re-validate against `nodesProj`.
   - `deleteEdge` — verify present in `edgesProj` (`EDGE_NOT_FOUND`),
     `edgesProj.delete(id)`.
7. **Validation throws → bubble out of the transact**. Because we only
   touched the projection (plain JS), the Y.Maps are unchanged; the
   transact body has zero Yjs mutations to commit. No partial writes,
   no broadcast.
8. **All ops validated → commit the diff to the Y.Maps**, still inside
   the same transact:
   ```ts
   for (const id of audit.created.nodes) nodesMap.set(id, nodesProj.get(id)!)
   for (const id of audit.updated.nodes) nodesMap.set(id, nodesProj.get(id)!)
   for (const id of audit.deleted.nodes) nodesMap.delete(id)
   for (const id of audit.created.edges) edgesMap.set(id, edgesProj.get(id)!)
   for (const id of audit.updated.edges) edgesMap.set(id, edgesProj.get(id)!)
   for (const id of [...audit.deleted.edges, ...audit.cascadedEdges]) edgesMap.delete(id)
   ```
   This is the **single Y mutation per `applyEdit` call** — Yjs batches
   them into one update, observers get one event, persistence stores
   one snapshot.
9. **Rebuild revision** post-commit and return the response.

### JSON-value validation (`assertJsonValue`)

`JSON.stringify` round-trips are **lossy**, not failing: `Date` becomes
a string, `Map`/`Set` become `{}`, functions are silently dropped from
objects, `undefined` is dropped, `NaN`/`Infinity` become `null`. None
of those throw — they just corrupt the payload. So we use a recursive
validator instead:

```ts
function assertJsonValue(value: unknown, path = "$"): void {
  // Accept: null | boolean | string | finite-number | array | plain-object
  // Reject: undefined, function, symbol, BigInt, Date, Map, Set, NaN,
  //         Infinity, prototype-pollution, cycles
}
```

Walks the value, asserts every leaf is `null | boolean | string |
finite-number`, every container is `array | plain-object`
(`Object.getPrototypeOf(v) === Object.prototype || null`), and detects
cycles via a `WeakSet`. On rejection, throws `BAD_REQUEST` with the
JSON path of the offending value (e.g. `"$.data.createdAt is a Date,
expected ISO string"`).

### Server-generated IDs — batch-reference rule

Server-mints `id` only for **standalone adds**. If an `addEdge` in the
same batch references a node also added in that batch, the agent **must
provide the node's `id` explicitly**. Documented in
`/.well-known/agent.json` and `AGENT_PROMPT.md`.

(v1.1 idea, not built: an `alias` field — `{ op: "addNode", alias:
"newApi", … }` then `{ op: "addEdge", edge: { sourceAlias: "newApi", … } }`
— added when the omission becomes painful in practice.)

### Response

```json
{
  "applied": 1,
  "revision": "rev1_b2c3d4e5f6071829",
  "created":  { "nodes": ["n-a1b2c3d4"], "edges": [] },
  "updated":  { "nodes": [], "edges": [] },
  "deleted":  { "nodes": [], "edges": [] },
  "cascadedEdges": [],
  "snapshot": { ...post-edit snapshot... }
}
```

`cascadedEdges` lists edge ids removed as a side-effect of `deleteNode`
with `cascadeEdges:true`, so an agent can audit what disappeared.

## Concurrency / safety

### Revision tokens (state-vector based)

```ts
function computeRevision(doc: Y.Doc): string {
  const sv = Y.encodeStateVector(doc)
  // FNV-1a 64-bit (as two 32-bit halves), prefix with "rev1_"
  // (anthill/revision.ts implementation copied verbatim)
}
```

Bumps on **every** doc update — browser drag, agent op, second agent's
op, presence change irrelevant (presence is on Awareness, not the doc).
This is the only revision unit that detects a browser-side mutation
between the agent's read and write. A per-room counter that only
increments on agent ops would silently miss user drags.

### Idempotency

- Header `Idempotency-Key: <uuid-or-opaque-string>` on `POST /edit`.
- Cache key is `(projectId, agentId, idempotencyKey)` — so two different
  agents using the same UUID don't collide, and the same agent can reuse
  a key across projects.
- Storage: TTL-LRU (15 min, 5000 entries) of `{ bodyHash, response,
  status }`. Same key + same body → return cached response with header
  `Idempotency-Replay: true`. Same key + different body →
  `409 IDEMPOTENCY_KEY_REUSED_DIFFERENT_BODY`.
- Mode is configurable: `CODESIGN_AGENT_BRIDGE_IDEMPOTENCY_MODE` ∈
  `auto | required` (default `required`). In `required`, missing key →
  `400 IDEMPOTENCY_KEY_REQUIRED`.

### Auth

- **`X-Agent-Id: <slug>`** — required (when bridge is enabled). Used in
  provenance, rate-limit key, idempotency key.
- **`X-Agent-Name: <human name>`** — optional, surfaces in logs / future
  presence pip.
- **`X-Agent-Run-Id: <opaque>`** — optional, written into
  `data.__codesign.runId`.
- **`Authorization: Bearer <secret>`** or **`X-Agent-Token: <secret>`** —
  checked against `CODESIGN_AGENT_BRIDGE_SECRET` env if set; if unset,
  we're in **open mode** (local dev only — see bind policy).

### Mount-time gate (replaces per-request bind policy)

There is only **one** `httpServer.listen(PORT, HOST)` in
`collab-server.ts` — shared by `/api/projects/*`, the agent routes, and
the WS upgrade. We can't selectively bind only the bridge routes to
loopback.

So instead of a runtime per-request loopback check, the bridge applies
a **startup precondition** when `mountAgentBridge` is wired into the
existing httpServer handler:

| `COLLAB_WS_HOST`               | `CODESIGN_AGENT_BRIDGE_SECRET` set? | Bridge behaviour                                          |
| ------------------------------ | ----------------------------------- | --------------------------------------------------------- |
| `127.0.0.1` (loopback)         | either                              | **Mount enabled.** Open mode is fine — only loopback can reach it anyway. |
| anything else (e.g. `0.0.0.0`) | **Yes**                             | **Mount enabled** with secret-required auth.              |
| anything else (e.g. `0.0.0.0`) | **No**                              | **Mount disabled.** Bridge logs a startup warning; every agent route returns `503 BRIDGE_DISABLED` with a message explaining the fix. The rest of the server (Hocuspocus WS, `/api/projects`) keeps working. |

The `503` short-circuit is at the start of the bridge dispatcher
pipeline — it runs before auth, rate-limit, etc. — so a misconfigured
deployment fails closed, loudly, instead of accidentally being open.

### CORS

`*` when bridge is loopback-only. When secret-protected,
`CODESIGN_AGENT_BRIDGE_ORIGINS` (comma list) is the allowlist. Browsers
shouldn't be calling the bridge directly anyway — Phase 2's tRPC mirror
is for in-app calls.

### Rate limiting

Token bucket, in-memory, keyed by `(tokenFingerprint, agentId)` where
`tokenFingerprint = sha256(token).slice(0,8)` (or `"anon"` in open
mode). Default 60 ops/min, burst 10/sec. Exceeded →
`429 RATE_LIMITED` with `Retry-After`. Keying by token+agent (vs agentId
only) means a leaked agentId can't trivially exhaust the bucket for the
real agent.

### Pre-existing security caveat: WebSocket endpoint has no auth

The current `collab-server.ts` does **not** install an
`onAuthenticate` extension on Hocuspocus. **Any client that can reach
the WS port and knows or guesses a `projectId` can mutate the same
`Y.Doc`.** Adding the bridge does not make this worse, but it also
does not fix it — and that means **secret-protecting the bridge alone
is not sufficient** to call the deployment "secure".

Two paths a deployer must pick from before exposing this beyond
loopback:

1. **Reverse-proxy the WS port behind auth** — e.g. require a Supabase
   session cookie at an Nginx/Cloudflare layer, OR keep
   `COLLAB_WS_HOST=127.0.0.1` and let only a trusted server-side proxy
   reach it.
2. **Add Hocuspocus `onAuthenticate`** that validates a Supabase JWT
   passed by the browser as the provider's `token`. This requires a
   matching change to `collab-flow.tsx` to pass the token. **Not part
   of this plan** — flagged as a follow-up workstream below.

This is documented in `AGENT_PROMPT.md` and the startup log; the bridge
won't pretend it's hardened a system that has an open WS upstream.

## Error code catalogue

| Status | Code                                       | When                                                              |
| ------ | ------------------------------------------ | ----------------------------------------------------------------- |
| 400    | `BAD_REQUEST`                              | Schema validation failure / non-JSON-value payload / `ops > 50` / unknown patch key (e.g. `width`) |
| 400    | `IDEMPOTENCY_KEY_REQUIRED`                 | Mode is `required` and header missing                              |
| 401    | `UNAUTHORIZED`                             | Bridge configured with secret, request omitted/wrong; or `X-Agent-Id` missing |
| 404    | `PROJECT_NOT_FOUND`                        | Supabase has no row for `projectId`                                |
| 404    | `NODE_NOT_FOUND` / `EDGE_NOT_FOUND`        | `update*` / `delete*` against missing id (after stale check)       |
| 409    | `STALE_REVISION`                           | `baseRevision` mismatches; **latest snapshot embedded in body**    |
| 409    | `IDEMPOTENCY_KEY_REUSED_DIFFERENT_BODY`    | Same `(projectId, agentId, key)`, different body                   |
| 409    | `EDGES_WOULD_BE_ORPHANED`                  | `deleteNode` with `cascadeEdges:false` and live edges              |
| 409    | `EDGE_REFERENCES_MISSING_NODE`             | `addEdge`/`updateEdge` source/target id doesn't exist              |
| 422    | `INVALID_OP`                               | Unknown `op` type / unknown discriminant                           |
| 429    | `RATE_LIMITED`                             | Per `(tokenFingerprint, agentId)` token-bucket exhausted           |
| 500    | `INTERNAL_ERROR`                           | Anything unexpected; logged with stack trace                       |
| 503    | `BRIDGE_DISABLED`                          | Mount-time gate failed: non-loopback `COLLAB_WS_HOST` and no secret. Set the secret or change the host. |

## Phase-2 forward-compatibility (so MCP is trivial later)

We won't build these now, but the v1 contract is shaped so they drop in
without re-architecting:

- **Schemas are stable, explicit, and small-context**. Every endpoint
  maps 1:1 to a future MCP tool with the same arg names:

  | HTTP                                              | Future MCP tool                  |
  | ------------------------------------------------- | -------------------------------- |
  | `GET  /projects/{id}/snapshot`                    | `codesign_flow_snapshot`         |
  | `GET  /projects/{id}/state`                       | `codesign_flow_state`            |
  | `GET  /projects/{id}/nodes/{nid}?depth=1`         | `codesign_flow_neighborhood`     |
  | `POST /projects/{id}/edit`                        | `codesign_flow_edit`             |

- **`AGENT_PROMPT.md` doubles as future SKILL.md source**. Write it as a
  set of crisp rules + curl examples with optional YAML frontmatter, so
  Phase 2 just adds frontmatter (`name`, `description`, `version`) and
  it becomes a Codex/Claude skill with no rewriting.

- **Discovery JSON includes a `mcp` slot** (currently `null`) so an
  agent that supports MCP knows where to look once we add the wrapper:

  ```json
  { "endpoints": {...}, "mcp": null /* or { "url": ".../mcp" } */, ... }
  ```

## What we explicitly defer (Phase 2)

- **Codex/MCP/SKILL.md integration** — design once the HTTP bridge is
  real. Likely a thin `packages/codesign-mcp/` (npx-runnable stdio MCP
  server) wrapping the HTTP routes, plus `web/skills/codesign.SKILL.md`
  authored from `AGENT_PROMPT.md`. Captured as a sibling plan after v1
  ships.
- **In-app tRPC `flowRouter`** — `getSnapshot`/`getState`/
  `getNeighborhood`/`applyEdit` wrapped in `protectedProcedure`
  (Supabase JWT). Reuses `flow-core/` directly; needs a one-time
  `protectedProcedure` addition to `web/server/api/trpc.ts`.
- **`flowAIRouter.assist`** — dialog-ai equivalent: prompt + snapshot →
  Azure OpenAI → `EditOp[]` → `flow-core/operations.applyEdit`.
- **Presence pip** via `awarenessProtocol` per `(agentId, runId)` so the
  existing presence stack shows "🤖 Claude Code".
- **Events log** — per-room ring buffer + `/events/pending` poll so
  agents react to humans / other agents.
- **AI-authored badge** in a custom React Flow node renderer that reads
  `node.data.__codesign?.author`.
- **Rate-limit storage** moved out of in-memory once we run more than
  one bridge instance (Redis or Supabase row).

## Testing strategy

Three layers, all runnable from `cd web && bun test` (we add a `"test":
"bun test"` script to `web/package.json` — `bun test` ships with Bun, so
no new devDependencies). Bun's test runner picks up `*.test.ts`
colocated under `__tests__/` directories.

### Layer 1 — Unit tests on `flow-core/` (pure, fast, no I/O)

Every module in `flow-core/` is a pure function or class — no
Hocuspocus, no Supabase, no network. Tests run against a freshly
constructed `new Y.Doc()` per test.

- **`revision.test.ts`**
  - Empty doc produces a stable token; matches across runs (deterministic).
  - Token starts with `"rev1_"` and `isRevisionToken` recognises it.
  - Inserting into a `Y.Map` changes the token.
  - The same logical state reached by two different update orders
    produces the **same** token (state vector is order-independent).
  - Two different docs with different content produce different tokens.

- **`graph.test.ts`**
  - `readNodes` / `readEdges` return plain Maps with the right shapes.
  - `edgesTouchingNode` returns both `source===id` and `target===id`
    matches; ignores unrelated edges.
  - Empty maps are handled (no crashes, return empty).

- **`snapshot.test.ts`**
  - `summary` strips `data` to label preview, includes counts +
    revision; `state` keeps full `data` verbatim.
  - `neighborhood` BFS to depth 1 returns immediate neighbours only;
    depth 2 includes neighbours-of-neighbours; depth 6 is clamped to 5.
  - Self-loops and disconnected nodes both handled.
  - `incoming` / `outgoing` arrays are populated correctly relative to
    the focal node.

- **`json-value.test.ts`** — covers `assertJsonValue`:
  - **Accepts**: `null`, booleans, finite numbers, strings, nested
    arrays of valid leaves, plain objects of valid leaves, deep nesting.
  - **Rejects** (each as its own case, asserting the thrown error
    includes the JSON path of the offender):
    `undefined`, function values, symbols, `BigInt(1n)`, `new Date()`,
    `new Map()`, `new Set()`, `NaN`, `Infinity`, `-Infinity`,
    objects with custom (non-`Object.prototype`) prototypes,
    cycles (`const a:any={}; a.self=a`).
  - Path reporting: a bad value at `$.data.foo[2].bar` produces an
    error message containing exactly that path.

- **`document.test.ts`** — covers the warm-connection cache lifecycle:
  - First call to `openProjectDoc(hp, "p1")` returns a `DirectConnection`;
    a second call with the same id returns the **same** connection
    (cache hit).
  - After `idleTtlMs` elapses with no use, the entry is evicted and
    `disconnect()` is called on the connection.
  - When the cache is full (`maxSize`) and a new id arrives, the
    least-recently-used entry is evicted and disconnected.
  - `closeAllCachedConnections()` (called from SIGINT handler) calls
    `disconnect()` on every cached entry and empties the cache. Test
    uses a spy on `conn.disconnect`.

- **`operations.test.ts`** (the most important file in this plan)
  - **Per-op happy paths**: every op (`addNode`, `updateNode`,
    `deleteNode`, `addEdge`, `updateEdge`, `deleteEdge`) mutates the
    `Y.Map`s as expected and bumps `revision`.
  - **Provenance stamping**: every created/updated entity carries
    `data.__codesign = { author, runId, at }`; `at` is an ISO-8601
    string; `runId` is `null` when omitted.
  - **Provenance does not clobber app fields**: existing `data.label`
    survives an `updateNode` that only sets `data.foo`.
  - **Renderer-owned top-level fields are rejected at parse**:
    `width`, `height`, `measured`, `selected`, `dragging` are
    React-Flow-managed top-level Node fields (NOT inside `data`). The
    Zod `updateNode.patch` schema is
    `Pick<Node,"type"|"position"|"data"|"hidden"|"draggable"|"selectable">.strict()`,
    so e.g. `patch: { width: 300 }` fails Zod parse with `BAD_REQUEST`
    and the doc is unchanged.
  - **`addNode` with omitted id mints `n-<8hex>`**; `addEdge` mints
    `e-{src}-{tgt}-<6hex>`.
  - **Same-batch edge referencing a same-batch new node without
    explicit id** → throws `EDGE_REFERENCES_MISSING_NODE` (the v1 rule).
  - **Cascade delete**: `deleteNode` with `cascadeEdges:true` removes
    every touching edge in the same transact; the response's
    `cascadedEdges` array is populated.
  - **Cascade refusal**: `deleteNode` with `cascadeEdges:false` and live
    edges throws `EDGES_WOULD_BE_ORPHANED`; the doc is **unchanged**
    (asserted via `revision` equality before/after).
  - **Stale-revision guard fires FIRST**: with a stale `baseRevision`
    AND a missing-node `updateNode` in the same batch, the error is
    `STALE_REVISION` (not `NODE_NOT_FOUND`).
  - **JSON-value check**: `data` containing `BigInt`, `Map`, `Date`,
    or a function value → `BAD_REQUEST` before `conn.transact` opens
    (caught by per-op pre-validation).
  - **Op-count cap**: 51 ops → `BAD_REQUEST`; 50 ops → succeeds.
  - **NO-WRITES-ON-VALIDATION-FAIL TEST** (the one that justifies
    validate-then-commit, replacing the abandoned `Y.UndoManager`
    rollback test):
    a batch where ops 1–3 would each succeed standalone, but op 4
    fails ref validation (e.g. `addEdge` with a non-existent target,
    or `deleteEdge` of an id missing from the projection). Assertions:
    - The thrown error reaches the caller with the right code.
    - The post-call `revision` token **equals** the pre-call token
      (state vector identical, since zero Y.Map mutations happened).
    - `nodesMap.size` and `edgesMap.size` equal pre-call sizes.
    - The specific node entries that ops 1–3 *would have* added are
      not in the live map.
    - **No update events** are emitted to a sibling
      `openDirectConnection` observer (proves no broadcast leaked).
  - **Single broadcast on success**: a successful 5-op batch produces
    exactly **one** Y.Doc `update` event on a sibling observer (proves
    everything commits in one transact, not five).
  - **Concurrency simulation**: between `applyEdit` calls, a sibling
    "browser" mutation (e.g. `nodesMap.set(...)` directly) bumps the
    revision; the next `applyEdit` with the old `baseRevision` returns
    `STALE_REVISION`.

### Layer 2 — Bridge plumbing units

- **`idempotency.test.ts`** — same key + same body returns cached
  response; same key + different body throws
  `IDEMPOTENCY_KEY_REUSED_DIFFERENT_BODY`; key tuple is
  `(projectId, agentId, key)` so different agents with the same key
  don't collide; TTL eviction removes entries past expiry.
- **`rate-limit.test.ts`** — bucket fills + drains as expected; burst
  beyond capacity returns `retryAfterMs`; `(tokenFingerprint, agentId)`
  keying isolates two agents sharing a token (and vice versa); `"anon"`
  fingerprint applies in open mode.
- **`auth.test.ts`** — `parseAgentHeaders` reads X-Agent-Id /
  X-Agent-Name / X-Agent-Run-Id / X-Agent-Token / Authorization Bearer;
  `checkSecret` rejects when secret is set and missing/wrong; allows
  when secret is unset (open mode). (No per-request loopback check
  anymore — the loopback rule is enforced at mount time, not in the
  auth helper.)

### Layer 3 — Bridge integration test

**`routes.integration.test.ts`** — boots a real `Hocuspocus` + the
bridge mount in-process inside a single `bun test` process, with:

- A **fake Supabase** stub that satisfies the project-existence check
  (`maybeSingle` returns `{ id, title: "Test" }`) and a no-op Database
  extension (so we don't hit the network — Hocuspocus's Database is
  pluggable via the same `fetch` / `store` callbacks).
- `node:http` listening on a random local port (port 0 → OS-assigned).
- Tests use `await fetch("http://127.0.0.1:<port>/...")` directly.

Coverage:

| Test                                                     | Asserts                                                          |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| `GET /healthz`                                           | 200, `{status:"ok"}`                                             |
| `GET /.well-known/agent.json`                            | 200, lists every endpoint and op type                            |
| `GET /agent-docs`                                        | 200, `text/markdown`, body starts with the AGENT_PROMPT.md heading |
| `GET /projects/<id>/snapshot` (no `X-Agent-Id`)          | 401 `UNAUTHORIZED`                                               |
| `GET /projects/<id>/snapshot` (good headers)             | 200, has `revision`, `nodes`, `edges`                            |
| `POST /projects/<id>/edit` (add node)                    | 200, `created.nodes.length === 1`, snapshot reflects it          |
| `POST /projects/<id>/edit` (no `Idempotency-Key`)        | 400 `IDEMPOTENCY_KEY_REQUIRED`                                   |
| Same `POST` repeated, same `Idempotency-Key`             | identical body, header `Idempotency-Replay: true`                |
| Same key, different body                                 | 409 `IDEMPOTENCY_KEY_REUSED_DIFFERENT_BODY`                      |
| `POST /edit` with stale `baseRevision`                   | 409 `STALE_REVISION`, body embeds latest snapshot                |
| `deleteNode` `cascadeEdges:false` with live edges        | 409 `EDGES_WOULD_BE_ORPHANED`                                    |
| `addEdge` source/target not in doc                       | 409 `EDGE_REFERENCES_MISSING_NODE`                               |
| `POST /edit` with `patch: { width: 300 }`               | 400 `BAD_REQUEST` (Zod `.strict()` rejects unknown top-level field) |
| 51 ops in one batch                                      | 400 `BAD_REQUEST`                                                |
| Burst 100 requests fast (rate-limit)                     | at least one returns 429 `RATE_LIMITED` with `Retry-After`       |
| Bridge mounted in disabled mode (`COLLAB_WS_HOST=0.0.0.0`, no secret) | every agent route returns 503 `BRIDGE_DISABLED`; `/api/projects` and WS upgrade still work |
| **Live broadcast**: open a `HocuspocusProvider` client (or a second `openDirectConnection`) to the same project, run `POST /edit` over HTTP, assert the second client sees the new node within 500ms | end-to-end live sync proven in unit-test scope |
| **Single broadcast on success**: a 5-op batch produces exactly one `update` event on the observer connection (proves single-transact commit) | broadcast batching verified |
| **Zero broadcast on failure**: a 4-op batch where op 4 fails ref validation produces zero `update` events on the observer | validate-then-commit guarantees no leaked partial writes |

This last test is the one that proves the whole architecture works:
HTTP → flow-core → openDirectConnection → Hocuspocus → broadcast.

### What we deliberately do NOT test

- Hocuspocus internals (`@hocuspocus/server` is third-party).
- Yjs CRDT semantics.
- The Supabase Database extension's actual SQL — covered by manual
  smoke step #5 (server restart + persistence check).
- The browser-side React Flow renderer — no change to it in v1.

## Manual verification

Even with the test suite green, walk this once before declaring done:

- `cd web && bun run typecheck && bun run lint && bun test` all green.
- With `bun run dev` running and a browser tab open on
  `localhost:3000/projects/<some-project>`:

  1. `curl http://127.0.0.1:1234/.well-known/agent.json` → 200, op list,
     auth modes.
  2. `curl http://127.0.0.1:1234/healthz` → `{ "status":"ok" }`.
  3. `curl http://127.0.0.1:1234/projects/<id>/snapshot
        -H "X-Agent-Id: smoke"` → 200 with seed nodes/edges + a
     `revision` token.
  4. `POST /projects/<id>/edit` adding a node (with the `revision` from
     step 3 as `baseRevision` and a fresh `Idempotency-Key`) → **the
     browser tab shows the new node appear instantly** with
     `data.__codesign` populated, response includes `created.nodes`.
  5. **Confirm Supabase persistence** — restart the collab server, hit
     `/snapshot` again → the node from step 4 is still there
     (proves the Database extension fired through our path).
  6. Repeat step 4's `POST` with the same `Idempotency-Key` and same body
     → identical response, header `Idempotency-Replay: true`, only one
     node total.
  7. Same key, different body → `409 IDEMPOTENCY_KEY_REUSED_DIFFERENT_BODY`.
  8. Drag a node in the browser, then retry step 4 with the **old**
     `baseRevision` → `409 STALE_REVISION`, latest snapshot inline.
  9. `deleteNode` on a node with edges and `cascadeEdges:false` →
     `409 EDGES_WOULD_BE_ORPHANED`.
  10. `GET /projects/<id>/nodes/2?depth=1` → returns node `2` plus `1`
      and `3` (its neighbours via `e1-2` and `e2-3`).
  11. **Mount-time gate** — restart the collab server with
      `COLLAB_WS_HOST=0.0.0.0` and **no** `CODESIGN_AGENT_BRIDGE_SECRET`.
      Startup log includes a warning that the bridge is disabled. Hit
      `curl http://127.0.0.1:1234/healthz` → `503 BRIDGE_DISABLED`.
      Hit `/api/projects/...` → still 200 (proves Hocuspocus + project
      CRUD survived).
  12. Set `CODESIGN_AGENT_BRIDGE_SECRET=…`, keep
      `COLLAB_WS_HOST=0.0.0.0`, restart, `curl` from LAN with
      `Authorization: Bearer …` → 200; without bearer → 401.

## Todos (tracked in SQL)

The first todo is the user-suggested "verify direct Hocuspocus access"
check — done as a tiny standalone script before we build anything else,
so we catch any API mismatch in the real codesign tree (Hocuspocus 4.0)
before writing 200 lines that depend on it.

Implementation todos and their matching test todos sit side-by-side; a
test todo depends on its source todo, and the final `verify` todo
depends on the entire test suite passing.

1. `verify-direct-conn` — One-off: `bun run` a 30-line script that
   instantiates the same `Hocuspocus` config as `collab-server.ts`, calls
   `openDirectConnection("smoke-test", {})`, mutates a `Y.Map`, asserts a
   second `openDirectConnection` to the same name sees it, and that
   `computeRevision(doc)` changes. Fails fast if Hocuspocus 4 changed
   anything subtle.
2. `test-setup` — Add `"test": "bun test"` to `web/package.json`. Add a
   `web/test-utils/` folder with a `makeFakeSupabase()` helper (returns a
   stub satisfying `.from("projects").select("...").eq(...).maybeSingle()`)
   and a `bootBridgeForTests({ projectId, secret? })` helper that
   instantiates a real `Hocuspocus` (with a no-op `Database` extension),
   mounts the bridge on a port-0 `node:http`, and returns
   `{ baseUrl, hocuspocus, close }`.
3. `flow-core-revision` — `web/lib/flow-core/revision.ts`:
   `computeRevision(doc)` (FNV over `Y.encodeStateVector`) +
   `isRevisionToken`. Copied from anthill/revision.ts.
4. `test-flow-core-revision` — `__tests__/revision.test.ts` per the
   Testing strategy bullets (deterministic, format, bumps on insert,
   order-independent, two-doc difference).
5. `flow-core-types` — `flow-core/types.ts` (Zod EditOp union, request /
   response shapes, `BridgeOrigin`, `AgentIdentity`) + `flow-core/errors.ts`
   (AgentError class, error code enum, JSON formatter).
6. `flow-core-graph` — `flow-core/graph.ts`: `readNodes(doc)`,
   `readEdges(doc)`, `project(doc)` returning plain JS Maps for read-side
   use; helpers for "edges touching nodeId" (used by cascade).
7. `test-flow-core-graph` — `__tests__/graph.test.ts` covering read
   helpers, `edgesTouchingNode` symmetry, empty-map behaviour.
8. `flow-core-snapshot` — `flow-core/snapshot.ts`: `summary`, `state`,
   `neighborhood` serialisers. All include `revision` from
   `flow-core/revision`.
9. `test-flow-core-snapshot` — `__tests__/snapshot.test.ts` covering
   summary vs state, neighborhood BFS, depth clamp at 5, self-loops,
   incoming/outgoing.
10. `flow-core-document` — `flow-core/document.ts`: warm-connection cache
    `Map<projectId, { conn: Promise<DirectConnection>; lastUsed: number }>`,
    with **idle TTL eviction** (default 5 min since last use; on eviction,
    `await conn.disconnect()`), **max-size LRU** (default 100; on
    overflow, evict + disconnect the LRU entry), and
    `closeAllCachedConnections()` for SIGINT/SIGTERM. Exposes
    `withProjectDoc(hocuspocus, projectId, fn)` that handles connection
    lookup + Supabase project-existence check + error cleanup. Mirrors
    anthill's `withDoc` plus the lifecycle additions called out in code
    review.
11. `test-flow-core-document` — `__tests__/document.test.ts`: cache hit
    on second call with same id; idle-TTL eviction calls `disconnect()`;
    LRU eviction on overflow; `closeAllCachedConnections()` disconnects
    every entry and empties the cache.
12. `flow-core-json-value` — `flow-core/json-value.ts`:
    `assertJsonValue(value, path?)` recursive validator. Accepts
    `null | boolean | finite-number | string | array | plain-object`.
    Rejects `undefined | function | symbol | BigInt | Date | Map | Set
    | NaN | Infinity | non-Object-prototype | cycles`. Throws an
    `AgentError("BAD_REQUEST", …)` whose message includes the JSON path
    of the offender. Used by `operations.ts` for every op carrying
    `data`.
13. `test-flow-core-json-value` — `__tests__/json-value.test.ts`:
    positive cases (the accepted set), negative cases (one per rejected
    type, asserting the path appears in the message), cycles via
    WeakSet detection.
14. `flow-core-operations` — `flow-core/operations.ts`: `applyEdit(conn,
    ops, identity, opts)`. **Validate-then-commit two-phase** inside
    one `await conn.transact(doc => …)`:
    1. op cap; per-op `assertJsonValue` on `data`;
    2. inside transact: stale-revision check first;
    3. project nodes/edges into plain JS Maps by `structuredClone`-ing
       each entry (NOT `toJSON()` — its values are live refs);
    4. for each op, validate + apply against the projection only;
    5. on success: commit the diff to the live `Y.Map`s in one batch;
       on failure: bubble — the live maps were never touched.
    Stamps `data.__codesign`. Returns `{ applied, created, updated,
    deleted, cascadedEdges }`. Explicit comment in the file referencing
    the rubber-duck note: "Y.UndoManager is NOT used here. See
    docs/agent-bridge-plan.md `Edit operations § Why not Y.UndoManager`."
15. `test-flow-core-operations` — `__tests__/operations.test.ts`. The
    centrepiece test file. Covers every bullet in the Testing strategy's
    operations.test.ts list, with explicit attention to:
    - the **no-writes-on-validation-fail** test (post-call revision
      equals pre-call revision; sibling observer sees zero `update`
      events);
    - the **single-broadcast on success** test (a 5-op batch produces
      exactly one `update` event);
    - the **renderer-fields rejection** test (`patch: { width: 300 }`
      → 400 `BAD_REQUEST` from Zod `.strict()`);
    - **stale-first-then-not-found** ordering.
16. `bridge-rate-limit` — `agent-bridge/rate-limit.ts`: token bucket
    keyed by `(tokenFingerprint, agentId)`.
17. `test-bridge-rate-limit` — `__tests__/rate-limit.test.ts`: bucket
    drain/refill, two-agent isolation, `"anon"` fingerprint when no
    token (loopback-only mode).
18. `bridge-idempotency` — `agent-bridge/idempotency.ts`: TTL-LRU keyed
    by `(projectId, agentId, key)`.
19. `test-bridge-idempotency` — `__tests__/idempotency.test.ts`: cache
    hit, body-mismatch error, key-tuple isolation, TTL eviction.
20. `bridge-auth` — `agent-bridge/auth.ts`: `parseAgentHeaders(req)` +
    `checkSecret(req, cfg)`. **No** per-request loopback check (that
    rule is enforced once at mount time, not on every request).
21. `test-bridge-auth` — `__tests__/auth.test.ts`: header parsing,
    secret enforcement (set + missing/wrong → reject; unset → allow).
22. `bridge-routes` — `agent-bridge/routes.ts`:
    `mountAgentBridge(req, res, ctx) → boolean`. Handles every route in
    the table above; pipeline per request: **bridge-disabled
    short-circuit (`503 BRIDGE_DISABLED`)** → auth → rate-limit →
    (POST only) idempotency → Zod parse → flow-core call → JSON
    response. Catches `AgentError` and formats per `errors.ts`.
23. `test-bridge-routes-integration` — `__tests__/routes.integration.test.ts`.
    Boots the bridge in-process via `bootBridgeForTests`, runs the full
    table from the Testing strategy section (healthz, discovery,
    snapshot auth, edit, idempotency replay, idempotency conflict,
    stale revision, cascade refusal, missing-node edge, renderer-fields
    rejection, op cap, rate limit burst, **mount-time disabled gate**
    (`BRIDGE_DISABLED` short-circuit), **and the live-broadcast +
    single-broadcast + zero-broadcast tests where a second
    `openDirectConnection` to the same project observes update events
    after `POST /edit`**).
24. `collab-server-mount` — Modify `web/scripts/collab-server.ts`:
    - instantiate the bridge `ctx` from env vars;
    - **at startup**, evaluate the mount-time gate
      (`COLLAB_WS_HOST !== "127.0.0.1"` && no
      `CODESIGN_AGENT_BRIDGE_SECRET` → log a warning and pass
      `disabled: true` into the bridge ctx);
    - dispatch agent paths (`/healthz`, `/.well-known/agent.json`,
      `/agent-docs`, `/projects/{id}/...`) to `mountAgentBridge` from
      the existing `httpServer` request handler **before** the
      `/api/projects` branches;
    - register `closeAllCachedConnections()` from `flow-core/document`
      in the existing SIGINT/SIGTERM shutdown sequence (before
      `hocuspocus.destroy()`).
    - Log the mounted bridge URL (or "disabled" reason) on startup.
25. `agent-prompt` — Author `web/AGENT_PROMPT.md` (purpose, headers,
    endpoints with curl examples, `EditOp` contract, error codes
    including `BRIDGE_DISABLED`, do/don't list including the "must
    provide node id when same-batch edge references it" rule, and a
    "Pre-existing security caveat" note about the unauthenticated WS
    endpoint). Add bridge env vars to `web/.env.example`
    (`CODESIGN_AGENT_BRIDGE_SECRET`, `_ORIGINS`, `_IDEMPOTENCY_MODE`).
26. `verify` — Run `cd web && bun run typecheck && bun run lint && bun
    test` (the suite must be 100% green). Then walk the Manual
    verification checklist above end-to-end with `curl` against a real
    running `bun run dev`. Especially: (a) browser sees the change live,
    (b) restarting the collab server preserves it (Supabase persistence
    proven), (c) the mount-time `BRIDGE_DISABLED` gate fires when
    `COLLAB_WS_HOST` is non-loopback without a secret.

## Notes / open questions / known limitations

- **Single port vs split port** — going single (mount inside the
  existing `httpServer`). User feedback emphasised "share the doc via
  Hocuspocus" rather than literal port topology, and the existing
  collab server already merges HTTP+WS. One URL to remember; reverse
  proxy can still split later.
- **`collab-flow.tsx` change?** None for v1 — provenance lives on `data`
  and the existing renderer round-trips it. Phase 2 adds a custom
  `nodeTypes` entry that draws an "AI" corner badge when
  `node.data.__codesign?.author` starts with `"ai:"`.
- **Why `flow-core/` is its own thing** even though only the bridge uses
  it in v1: it's the same payoff Anthill gets — Phase 2 (tRPC, MCP, AI
  assist) drops in by importing the same primitives, so we don't
  re-implement validation / revision logic three times.
- **Why validate-then-commit instead of `Y.UndoManager`** — see the
  prominent box in `Edit operations § Behaviour`. Short version: undo
  is itself a Yjs update (so revision tokens advance, not restore),
  and partial writes broadcast to WS clients before the undo lands.
  The two-phase design avoids both bugs and is the same correctness
  story Hocuspocus's docs implicitly assume. Anthill happens to use
  UndoManager; we deliberately diverge here.
- **KNOWN GAP — WebSocket endpoint has no auth.** The current
  `collab-server.ts` doesn't install Hocuspocus `onAuthenticate`, so
  any client reaching the WS port that knows or guesses a `projectId`
  can mutate the doc — bypassing the bridge entirely. The bridge does
  not introduce this issue, but it also does not fix it. **Until this
  is fixed, deployers must treat secret-protecting the bridge as
  necessary-but-not-sufficient.** Recommended deployment posture for
  v1:
  - keep `COLLAB_WS_HOST=127.0.0.1` and put a reverse proxy in front
    of *both* HTTP+WS that enforces a Supabase session cookie; OR
  - run only on a private network where every reachable client is
    trusted.
  Flagged as a Phase-1B follow-up workstream: add `onAuthenticate`
  that verifies a Supabase JWT passed by the browser as the provider's
  `token`, plus matching `collab-flow.tsx` change to pass it.
- **Spike findings (resolved)** — `verify-direct-conn` ran clean
  against Hocuspocus 4.0 and yjs 13.6 with `web/scripts/spike-direct-conn.ts`.
  Two non-obvious behaviours were uncovered and now drive the design:
  1. `DirectConnection.transact(fn)` does **not** await `fn`. Async
     rejections from `fn` are silently swallowed; only synchronous
     throws propagate to the awaiter. **`operations.ts` must use a
     synchronous `fn` and throw synchronously.**
  2. `Y.Map.toJSON()` only deep-copies the outer container; the
     per-entry values are the same references stored in the live map.
     **The projection MUST `structuredClone` each entry** before any
     validator mutation, otherwise a mid-validation mutation would leak
     straight into the live `Y.Map`. `structuredClone` (built in to
     V8/Bun, no dep) is the right primitive here.

