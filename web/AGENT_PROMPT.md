# 🧩 codesign Agent Bridge — Copy-paste prompt

> Paste this whole document into Codex, Claude Code, ChatGPT, or any other
> agent harness. Replace `{{BASE_URL}}` and `{{PROJECT_ID}}` once. The
> agent then has everything it needs to read and mutate a live React Flow
> canvas backed by Yjs.

---

## Purpose

**codesign** is a collaborative diagram editor: a React Flow canvas
(nodes + edges) whose state lives in a Yjs document hosted by a
Hocuspocus WebSocket server. Browsers connect over WS; every change is
broadcast in real time.

The **agent bridge** is an HTTP surface mounted on the same process and
the same port as the WS server. It lets an external agent (you) read
the current canvas, propose mutations as a typed `EditOp[]`, and have
those mutations applied as a single Yjs transaction inside the same
`Y.Doc` that browsers are subscribed to. Every connected client sees
your edits land instantly, with provenance attached
(`data.__codesign.author`, `runId`, `at`).

Protocol id: `codesign-agent-bridge/1`.

---

## Base URL

Same host and port as the collab WebSocket server. One process serves
both:

- Default local dev: `http://127.0.0.1:1234` (WS at `ws://127.0.0.1:1234`)
- Production: whatever URL your operator gives you (HTTP scheme).

There is **no `/api/` prefix** for bridge routes — that namespace is
reserved for the browser-facing project CRUD that already exists. All
bridge routes sit at the root.

---

## Required headers (send on EVERY request)

| Header                 | Required?                          | Purpose                                                              |
| ---------------------- | ---------------------------------- | -------------------------------------------------------------------- |
| `X-Agent-Id`           | **always**                         | Stable slug for you (e.g. `claude-code`). Used in provenance, rate-limit key, idempotency key. |
| `X-Agent-Name`         | optional                           | Human-friendly name. Surfaces in logs / future presence pip.         |
| `X-Agent-Run-Id`       | optional                           | Opaque trace id; written into `data.__codesign.runId` on every entity you create or update. |
| `Authorization`        | required iff bridge has a secret   | `Bearer <secret>`. Checked against `CODESIGN_AGENT_BRIDGE_SECRET`.   |
| `X-Agent-Token`        | alternative to `Authorization`     | Same secret, different header. Pick one.                             |
| `Idempotency-Key`      | required on `POST /edit` (default) | UUID or any opaque string. See **Idempotency** below.                |
| `Content-Type`         | required on POSTs                  | `application/json`.                                                  |

If the operator has set `CODESIGN_AGENT_BRIDGE_SECRET`, you must
present the secret as either `Authorization: Bearer <secret>` **or**
`X-Agent-Token: <secret>`. If the secret is unset (loopback-only dev),
no token is required.

### Idempotency

`POST /edit` requires `Idempotency-Key` by default
(`CODESIGN_AGENT_BRIDGE_IDEMPOTENCY_MODE=required`). Behaviour:

- **Same key + same body** → server returns the cached response with
  header `Idempotency-Replay: true`. Safe to retry on network failure.
- **Same key + different body** → `409 IDEMPOTENCY_KEY_REUSED_DIFFERENT_BODY`.
  Mint a fresh UUID per logical change.
- **Cache key** is `(projectId, agentId, idempotencyKey)`, TTL 15 min.
- If the operator runs in `auto` mode, missing keys are accepted and
  idempotency simply isn't enforced — but you should still send one.

---

## Endpoints

All examples below assume `BASE_URL=http://127.0.0.1:1234` and
`PROJECT_ID=my-project`.

### `GET /healthz`

Liveness probe. No auth. Returns `200 ok`.

```bash
curl -sS "$BASE_URL/healthz"
```

```json
{ "status": "ok" }
```

### `GET /.well-known/agent.json`

Discovery. Lists supported ops, node/edge fields, auth modes,
idempotency policy, version, and a `mcp` slot reserved for Phase 2.

```bash
curl -sS "$BASE_URL/.well-known/agent.json" \
  -H "X-Agent-Id: claude-code"
```

```json
{
  "protocol": "codesign-agent-bridge/1",
  "endpoints": { "snapshot": "/projects/{id}/snapshot", "...": "..." },
  "ops": ["addNode", "updateNode", "deleteNode", "addEdge", "updateEdge", "deleteEdge"],
  "idempotency": { "mode": "required", "header": "Idempotency-Key" },
  "auth": { "mode": "secret" | "open", "headers": ["Authorization", "X-Agent-Token"] },
  "mcp": null
}
```

### `GET /agent-docs`

Returns this document (`AGENT_PROMPT.md`) as `text/markdown`. Useful
when an agent harness wants to fetch the spec at runtime instead of
having it baked into the system prompt.

```bash
curl -sS "$BASE_URL/agent-docs" \
  -H "X-Agent-Id: claude-code"
```

### `GET /projects/{projectId}/snapshot`

Cheap, LLM-friendly read. Strips `data` to a `label` preview so the
response fits in any context window. Use this as your default first
read.

```bash
curl -sS "$BASE_URL/projects/$PROJECT_ID/snapshot" \
  -H "X-Agent-Id: claude-code"
```

```json
{
  "projectId": "my-project",
  "revision": "rev1_a1b2c3d4e5f60718",
  "nodeCount": 3,
  "edgeCount": 2,
  "hasLiveClients": true,
  "nodes": [
    { "id": "1", "type": "input", "position": { "x": 0, "y": 0 }, "label": "👋 Welcome" }
  ],
  "edges": [
    { "id": "e1-2", "source": "1", "target": "2", "type": "default" }
  ]
}
```

`revision` is your optimistic-locking token — pass it back as
`baseRevision` on the next `POST /edit` to refuse stale writes.

### `GET /projects/{projectId}/state`

Same envelope as `/snapshot` but with the **full `data`** on every node
and edge. Use this when you need to read the actual contents of the
canvas, not just labels.

```bash
curl -sS "$BASE_URL/projects/$PROJECT_ID/state" \
  -H "X-Agent-Id: claude-code"
```

```json
{
  "projectId": "my-project",
  "revision": "rev1_...",
  "nodeCount": 3,
  "edgeCount": 2,
  "hasLiveClients": true,
  "nodes": [
    {
      "id": "1",
      "type": "input",
      "position": { "x": 0, "y": 0 },
      "data": { "label": "👋 Welcome", "__codesign": { "author": "user", "at": "..." } }
    }
  ],
  "edges": [{ "id": "e1-2", "source": "1", "target": "2", "data": {} }]
}
```

### `GET /projects/{projectId}/nodes/{nodeId}?depth=1`

Focal node + its k-hop neighbours and the edges that connect any pair
in `{focal} ∪ neighbours`. `depth` defaults to 1 and is **capped at 5**.
BFS from the focal node.

```bash
curl -sS "$BASE_URL/projects/$PROJECT_ID/nodes/1?depth=2" \
  -H "X-Agent-Id: claude-code"
```

```json
{
  "revision": "rev1_...",
  "focal":      { "id": "1", "type": "input", "position": {...}, "data": {...} },
  "neighbours": [ { "id": "2", ... }, { "id": "3", ... } ],
  "edges":      [ { "id": "e1-2", "source": "1", "target": "2", ... } ],
  "incoming":   ["e3-1"],
  "outgoing":   ["e1-2"]
}
```

### `POST /projects/{projectId}/edit`

The workhorse — every mutation flows through this one route. All ops in
a single call run in **one Yjs transaction**: validate-then-commit, so
either every op lands or nothing does. No partial writes are ever
broadcast to other clients.

```bash
KEY=$(uuidgen)
curl -sS -X POST "$BASE_URL/projects/$PROJECT_ID/edit" \
  -H "Content-Type: application/json" \
  -H "X-Agent-Id: claude-code" \
  -H "X-Agent-Name: Claude Code" \
  -H "X-Agent-Run-Id: run-2026-04-30-abc" \
  -H "Idempotency-Key: $KEY" \
  -d '{
    "baseRevision": "rev1_a1b2c3d4e5f60718",
    "ops": [
      { "op": "addNode",
        "node": { "id": "n-checkout", "type": "default",
                  "position": { "x": 200, "y": 120 },
                  "data": { "label": "Checkout" } } },
      { "op": "addEdge",
        "edge": { "source": "1", "target": "n-checkout", "label": "next" } }
    ]
  }'
```

Response:

```json
{
  "applied": 2,
  "revision": "rev1_b2c3d4e5f6071829",
  "created":  { "nodes": ["n-checkout"], "edges": ["e-1-n-checkout-9f3a21"] },
  "updated":  { "nodes": [], "edges": [] },
  "deleted":  { "nodes": [], "edges": [] },
  "cascadedEdges": [],
  "snapshot": { "projectId": "my-project", "revision": "rev1_...", "...": "..." }
}
```

`cascadedEdges` lists edge ids removed as a side-effect of `deleteNode`
with `cascadeEdges: true`, so you can audit what disappeared.

---

## `POST /edit` — body shape

```json
{
  "baseRevision": "rev1_…",
  "ops": [
    { "op": "addNode",    "node":  { "id?": "...", "type?": "...",
                                     "position": { "x": 0, "y": 0 },
                                     "data": {} } },
    { "op": "updateNode", "id":    "...",
                          "patch": { "position?": {...}, "data?": {...},
                                     "type?": "...", "hidden?": false,
                                     "draggable?": true, "selectable?": true } },
    { "op": "deleteNode", "id":    "...", "cascadeEdges?": true },
    { "op": "addEdge",    "edge":  { "id?": "...", "source": "...", "target": "...",
                                     "type?": "...", "label?": "...",
                                     "animated?": false, "data?": {} } },
    { "op": "updateEdge", "id":    "...",
                          "patch": { "type?": "...", "label?": "...",
                                     "animated?": false, "data?": {},
                                     "source?": "...", "target?": "...",
                                     "sourceHandle?": "...", "targetHandle?": "..." } },
    { "op": "deleteEdge", "id":    "..." }
  ]
}
```

### Hard rules

- **Cap: `ops.length ≤ 50`** per call. Larger batches → `400 BAD_REQUEST`.
- **Atomic.** Validation runs against a plain-JS projection of the live
  doc; nothing touches the live `Y.Map`s until every op has validated.
  Any failure aborts the whole batch with zero writes.
- **Renderer-owned fields are forbidden.** React Flow manages `width`,
  `height`, `measured`, `selected`, and `dragging` at the top level of
  a `Node`. Including them in `addNode.node` or `updateNode.patch`
  returns `400 BAD_REQUEST` (the patch schema is `.strict()`).
- **Same-batch reference rule.** If you `addNode` and then `addEdge`
  referencing it in the same call, the `addNode` **must** specify an
  explicit `id`. Server-minted ids are not visible to later ops in the
  same batch. Edges that reference a missing or same-batch-server-minted
  id → `409 EDGE_REFERENCES_MISSING_NODE`.
- **Provenance is auto-stamped** on every entity you create or update,
  at `data.__codesign = { author: "ai:<X-Agent-Id>", runId, at }`.
  **Do not write to `data.__codesign` yourself** — the bridge owns that
  key. (Reading it from a snapshot/state response is fine.)
- **`cascadeEdges` defaults to `true`** on `deleteNode`. Set it to
  `false` if you want the bridge to refuse the delete when live edges
  reference the node (`409 EDGES_WOULD_BE_ORPHANED`).

### JSON-value rule (every value under `data`)

Every value reachable from any `data` you send must be JSON-safe:

- **Allowed:** `null`, `boolean`, finite `number`, `string`, `array`,
  plain `object` (prototype is `Object.prototype` or `null`).
- **Rejected with `400 BAD_REQUEST`:** `undefined`, functions, symbols,
  `BigInt`, `Date`, `Map`, `Set`, `NaN`, `Infinity`, prototype
  pollution, cycles.

`JSON.stringify` is **lossy, not failing** for most of these (a `Date`
becomes a string, a `Map` becomes `{}`, `undefined` is silently
dropped, `NaN` becomes `null`). The bridge runs an explicit recursive
validator and refuses the request with the JSON path of the offending
value (e.g. `"$.data.createdAt is a Date, expected ISO string"`).

If you have dates, **pre-serialise to ISO strings** (`new
Date().toISOString()`).

---

## Optimistic concurrency (`baseRevision`)

The `revision` you got from your last `/snapshot`, `/state`, or
`/nodes/...` read is a content-addressed token over the entire Yjs
state vector. It bumps on every doc change, including browser drags
from human users.

- Pass it as `baseRevision` on `POST /edit`.
- If the doc has moved on since you read it, the bridge throws
  `409 STALE_REVISION` **with the latest snapshot embedded in the
  response body** so you can replan in one round-trip — no second
  `GET /snapshot` needed.
- For one-off, read-only-by-construction edits (e.g. an unconditional
  `addNode` of a brand-new id), `baseRevision` is optional. For
  anything that updates or deletes existing entities, **always send
  it**.

---

## Error code catalogue

| Status | Code                                       | When                                                                                              |
| ------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| 400    | `BAD_REQUEST`                              | Schema validation failure / non-JSON-value `data` / `ops > 50` / unknown patch key (e.g. `width`) |
| 400    | `IDEMPOTENCY_KEY_REQUIRED`                 | Mode is `required` and `Idempotency-Key` header is missing                                        |
| 401    | `UNAUTHORIZED`                             | Bridge is configured with a secret and request omitted/wrong; or `X-Agent-Id` missing             |
| 404    | `PROJECT_NOT_FOUND`                        | Supabase has no row for `projectId`                                                               |
| 404    | `NODE_NOT_FOUND` / `EDGE_NOT_FOUND`        | `update*` / `delete*` against a missing id (after the stale check)                                |
| 409    | `STALE_REVISION`                           | `baseRevision` mismatches; **latest snapshot embedded in body**                                   |
| 409    | `IDEMPOTENCY_KEY_REUSED_DIFFERENT_BODY`    | Same `(projectId, agentId, key)`, different body                                                  |
| 409    | `EDGES_WOULD_BE_ORPHANED`                  | `deleteNode` with `cascadeEdges: false` and live edges still reference the node                   |
| 409    | `EDGE_REFERENCES_MISSING_NODE`             | `addEdge` / `updateEdge` source/target id doesn't exist                                           |
| 422    | `INVALID_OP`                               | Unknown `op` discriminant (e.g. `"op": "moveNode"`)                                               |
| 429    | `RATE_LIMITED`                             | Per `(tokenFingerprint, agentId)` token-bucket exhausted; respect `Retry-After`                   |
| 500    | `INTERNAL_ERROR`                           | Anything unexpected; logged with stack trace                                                      |
| 503    | `BRIDGE_DISABLED`                          | Mount-time gate failed: non-loopback `COLLAB_WS_HOST` and no `CODESIGN_AGENT_BRIDGE_SECRET`. Operator must set the secret or change the host. |

Errors come back as:

```json
{ "error": { "code": "STALE_REVISION", "message": "...", "snapshot": { ... } } }
```

---

## Pre-existing security caveat (read this before deploying)

> The current `collab-server.ts` does **not** install an
> `onAuthenticate` extension on Hocuspocus. **Any client that can reach
> the WS port and knows or guesses a `projectId` can mutate the same
> `Y.Doc`.** Adding the bridge does not make this worse, but it also
> does not fix it — and that means **secret-protecting the bridge
> alone is not sufficient** to call the deployment "secure".

The agent bridge's `CODESIGN_AGENT_BRIDGE_SECRET` only gates HTTP
traffic. It does **not** protect the underlying WebSocket port. Before
exposing the collab server beyond loopback, the operator must pick one
of:

1. **Reverse-proxy the WS port behind auth** — e.g. require a Supabase
   session cookie at an Nginx / Cloudflare layer, OR keep
   `COLLAB_WS_HOST=127.0.0.1` and let only a trusted server-side proxy
   reach it.
2. **Add Hocuspocus `onAuthenticate`** that validates a Supabase JWT
   passed by the browser as the provider's `token`. (Not part of the
   bridge plan; flagged as a follow-up workstream.)

The bridge's mount-time gate enforces this: if `COLLAB_WS_HOST` is
anything other than `127.0.0.1` and no secret is set, every bridge
route returns `503 BRIDGE_DISABLED`. It will not silently expose
itself.

---

## Recommended workflow

1. **Read once.** `GET /snapshot` to see what's there and capture
   `revision`. If you need full content, follow up with `GET /state` or
   a focused `GET /nodes/{id}?depth=N`.
2. **Plan locally.** Compose your `EditOp[]` against the snapshot you
   just read.
3. **Mint an `Idempotency-Key`** (a fresh UUID) for this logical
   change.
4. **`POST /edit`** with `baseRevision` set to the revision you read.
5. On `409 STALE_REVISION`, **replan from the snapshot embedded in the
   response body** — don't blindly retry, and don't issue a fresh
   `GET /snapshot` (it's already inline).
6. On a network failure, **retry the same POST with the same key and
   the same body**. The bridge will return the cached response.

---

## Do / Don't

**DO:**

- ✅ Send `baseRevision` for any non-trivial sequence of writes.
- ✅ Use a UUID for `Idempotency-Key`, and **reuse it on retry** (same
  key + same body = cached response).
- ✅ Batch related ops into a single `POST /edit` — they're applied
  atomically.
- ✅ Provide explicit `id`s on `addNode` whenever a same-batch
  `addEdge` will reference the new node.
- ✅ Pre-serialise dates to ISO strings before putting them in `data`.
- ✅ Replan from the snapshot embedded in `409 STALE_REVISION`
  responses.

**DON'T:**

- ❌ Don't poll `/snapshot` faster than ~once per second; the rate
  limiter (60 ops/min, burst 10/sec by default) will return
  `429 RATE_LIMITED` with `Retry-After`.
- ❌ Don't include `width`, `height`, `measured`, `selected`, or
  `dragging` in node payloads — those are renderer-owned and the patch
  schema rejects them with `400 BAD_REQUEST`.
- ❌ Don't write to `data.__codesign` yourself; it's the bridge's
  provenance namespace.
- ❌ Don't put `Date`, `Map`, `Set`, `BigInt`, `undefined`, functions,
  `NaN`, `Infinity`, or cycles inside `data` — they're rejected with
  `400 BAD_REQUEST`.
- ❌ Don't retry indefinitely on `409 STALE_REVISION` — replan from
  the embedded snapshot. If you keep losing the race, slow down.
- ❌ Don't reuse an `Idempotency-Key` with a different body —
  `409 IDEMPOTENCY_KEY_REUSED_DIFFERENT_BODY`. Mint a fresh UUID per
  logical change.
- ❌ Don't loop on `400 BAD_REQUEST`. Fix the request shape — the
  error message points at the offending field.
- ❌ Don't reference a same-batch server-minted node id from a
  same-batch `addEdge`. Provide an explicit `id` on the `addNode`.
