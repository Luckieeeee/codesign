/**
 * Wire-level Zod schemas + inferred TS types for the agent bridge.
 *
 * Every schema here is part of the public v1 contract documented in
 * `docs/agent-bridge-plan.md`. Convention: schemas are exported as
 * `XSchema` and the inferred type as `X` (e.g. `EditOpSchema` /
 * `EditOp`).
 *
 * Two design rules are load-bearing and must not be relaxed without a
 * contract version bump:
 *
 * 1. Every patch / input object uses `.strict()` so unknown top-level
 *    keys raise Zod errors (which the bridge translates to
 *    `BAD_REQUEST`). In particular this rejects the React Flow
 *    renderer-owned fields `width` / `height` / `measured` / `selected`
 *    / `dragging`, which the bridge never owns and which would corrupt
 *    the client's renderer state if echoed back through Yjs.
 * 2. `data` payloads are `z.record(z.string(), z.unknown())` — opaque
 *    to the schema layer. A separate recursive validator
 *    (`assertJsonValue`, see `flow-core/json-value.ts`) enforces that
 *    every leaf is a valid JSON value (no Date / Map / NaN / etc).
 */

import { z } from "zod"

// ---------------------------------------------------------------------------
// Identity / origin
// ---------------------------------------------------------------------------

/**
 * Identity minted by `agent-bridge/auth.ts` from request headers
 * (`X-Agent-Id`, `X-Agent-Name`, `X-Agent-Run-Id`). Plain camelCase TS
 * — not derived from a Zod schema because it isn't a wire shape.
 */
export interface AgentIdentity {
  id: string
  name?: string
  runId?: string
}

/**
 * Value passed as the `origin` argument to `Y.transact(doc, fn,
 * origin)`. Yjs observers (e.g. presence overlays, audit hooks) can
 * `instanceof`-discriminate on `source === "agent-bridge"` to treat
 * bridge writes specially.
 */
export interface BridgeOrigin {
  source: "agent-bridge"
  agentId: string
  runId: string | null
  idempotencyKey: string | null
}

// ---------------------------------------------------------------------------
// Provenance stamp embedded in `data.__codesign`
// ---------------------------------------------------------------------------

export const ProvenanceStampSchema = z.object({
  author: z.string(),
  runId: z.string().nullable(),
  at: z.string(), // ISO-8601 timestamp
})
export type ProvenanceStamp = z.infer<typeof ProvenanceStampSchema>

// ---------------------------------------------------------------------------
// Node / edge patches and full inputs
// ---------------------------------------------------------------------------

const dataRecord = z.record(z.string(), z.unknown())
const positionSchema = z.object({ x: z.number(), y: z.number() })

/**
 * Allowed top-level keys for `updateNode.patch`.
 *
 * `.strict()` is intentional: any other key (notably the renderer-owned
 * `width` / `height` / `measured` / `selected` / `dragging`) must be
 * rejected as `BAD_REQUEST` rather than silently merged into the live
 * `Y.Map`.
 */
export const NodePatchSchema = z
  .object({
    type: z.string().optional(),
    position: positionSchema.optional(),
    data: dataRecord.optional(),
    hidden: z.boolean().optional(),
    draggable: z.boolean().optional(),
    selectable: z.boolean().optional(),
  })
  .strict()
export type NodePatch = z.infer<typeof NodePatchSchema>

/**
 * Allowed top-level keys for `updateEdge.patch`. Symmetric to
 * `NodePatchSchema` — `.strict()` rejects unknown keys with
 * `BAD_REQUEST`.
 */
export const EdgePatchSchema = z
  .object({
    type: z.string().optional(),
    source: z.string().optional(),
    target: z.string().optional(),
    sourceHandle: z.string().nullable().optional(),
    targetHandle: z.string().nullable().optional(),
    label: z.string().optional(),
    hidden: z.boolean().optional(),
    data: dataRecord.optional(),
    animated: z.boolean().optional(),
    selectable: z.boolean().optional(),
    deletable: z.boolean().optional(),
  })
  .strict()
export type EdgePatch = z.infer<typeof EdgePatchSchema>

/**
 * Full node payload accepted by `addNode.node`. Same allow-list as
 * `NodePatchSchema`, with `position` required and `data` defaulted to
 * an empty object. `id` is optional — the bridge mints `n-<8hex>` if
 * omitted (subject to the batch-reference rule documented in
 * `docs/agent-bridge-plan.md` § "Server-generated IDs").
 */
export const NodeInputSchema = z
  .object({
    id: z.string().optional(),
    type: z.string().optional(),
    position: positionSchema,
    data: dataRecord.default({}),
    hidden: z.boolean().optional(),
    draggable: z.boolean().optional(),
    selectable: z.boolean().optional(),
  })
  .strict()
export type NodeInput = z.infer<typeof NodeInputSchema>

/**
 * Full edge payload accepted by `addEdge.edge`. Same allow-list as
 * `EdgePatchSchema`, with `source` and `target` required.
 */
export const EdgeInputSchema = z
  .object({
    id: z.string().optional(),
    type: z.string().optional(),
    source: z.string(),
    target: z.string(),
    sourceHandle: z.string().nullable().optional(),
    targetHandle: z.string().nullable().optional(),
    label: z.string().optional(),
    hidden: z.boolean().optional(),
    data: dataRecord.optional(),
    animated: z.boolean().optional(),
    selectable: z.boolean().optional(),
    deletable: z.boolean().optional(),
  })
  .strict()
export type EdgeInput = z.infer<typeof EdgeInputSchema>

// ---------------------------------------------------------------------------
// Edit ops (discriminated union on `op`)
// ---------------------------------------------------------------------------

export const EditOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("addNode"), node: NodeInputSchema }),
  z.object({ op: z.literal("updateNode"), id: z.string(), patch: NodePatchSchema }),
  z.object({
    op: z.literal("deleteNode"),
    id: z.string(),
    cascadeEdges: z.boolean().default(true),
  }),
  z.object({ op: z.literal("addEdge"), edge: EdgeInputSchema }),
  z.object({ op: z.literal("updateEdge"), id: z.string(), patch: EdgePatchSchema }),
  z.object({ op: z.literal("deleteEdge"), id: z.string() }),
])
export type EditOp = z.infer<typeof EditOpSchema>

// ---------------------------------------------------------------------------
// Edit request / response envelopes
// ---------------------------------------------------------------------------

export const EditRequestBodySchema = z
  .object({
    ops: z.array(EditOpSchema).max(50),
    baseRevision: z.string().optional(),
  })
  .strict()
export type EditRequestBody = z.infer<typeof EditRequestBodySchema>

const idBucketSchema = z.object({
  nodes: z.array(z.string()),
  edges: z.array(z.string()),
})

export const EditResponseSchema = z.object({
  revision: z.string(),
  applied: z.number().int().nonnegative(),
  created: idBucketSchema,
  updated: idBucketSchema,
  deleted: idBucketSchema,
  cascadedEdges: z.array(z.string()),
})
export type EditResponse = z.infer<typeof EditResponseSchema>

// ---------------------------------------------------------------------------
// Read-side response shapes
//
// These describe what the bridge SENDS back. Embedded node/edge values
// are stored Y.Map entries projected via `structuredClone`; the
// renderer-owned keys (`width`, `measured`, ...) may legitimately
// appear here (the client put them there), so the embedded shapes are
// `.passthrough()` rather than `.strict()`. Only the bridge's own
// envelope keys are constrained.
// ---------------------------------------------------------------------------

const fullNodeSchema = z
  .object({
    id: z.string(),
    type: z.string().optional(),
    position: positionSchema,
    data: dataRecord,
  })
  .passthrough()

const fullEdgeSchema = z
  .object({
    id: z.string(),
    type: z.string().optional(),
    source: z.string(),
    target: z.string(),
    data: dataRecord.optional(),
  })
  .passthrough()

/**
 * Cheap default read. Strips `data` to a `label` preview so a multi-
 * hundred-node project still fits comfortably in an LLM context window.
 */
export const SnapshotResponseSchema = z.object({
  projectId: z.string(),
  revision: z.string(),
  nodeCount: z.number().int().nonnegative(),
  edgeCount: z.number().int().nonnegative(),
  hasLiveClients: z.boolean(),
  nodes: z.array(
    z.object({
      id: z.string(),
      type: z.string().optional(),
      position: positionSchema,
      label: z.string().optional(),
    }),
  ),
  edges: z.array(
    z.object({
      id: z.string(),
      source: z.string(),
      target: z.string(),
      type: z.string().optional(),
    }),
  ),
})
export type SnapshotResponse = z.infer<typeof SnapshotResponseSchema>

/**
 * Same envelope as `SnapshotResponse`, but with full `data` on every
 * node and edge.
 */
export const StateResponseSchema = z.object({
  projectId: z.string(),
  revision: z.string(),
  nodeCount: z.number().int().nonnegative(),
  edgeCount: z.number().int().nonnegative(),
  hasLiveClients: z.boolean(),
  nodes: z.array(fullNodeSchema),
  edges: z.array(fullEdgeSchema),
})
export type StateResponse = z.infer<typeof StateResponseSchema>

/**
 * BFS-to-`depth` view around a focal node. `incoming` / `outgoing` are
 * edge-id lists pointing at / away from the focal node, computed from
 * the same `edges` array included in the response.
 */
export const NeighborhoodResponseSchema = z.object({
  revision: z.string(),
  focal: fullNodeSchema,
  neighbours: z.array(fullNodeSchema),
  edges: z.array(fullEdgeSchema),
  incoming: z.array(z.string()),
  outgoing: z.array(z.string()),
})
export type NeighborhoodResponse = z.infer<typeof NeighborhoodResponseSchema>
