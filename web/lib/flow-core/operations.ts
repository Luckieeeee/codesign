/**
 * `applyEdit` — the heart of the agent bridge's write path.
 *
 * Pipeline (see `docs/agent-bridge-plan.md` § "Edit operations §
 * Behaviour"):
 *
 *   1. Pre-transact (sync, cheap input vetting):
 *      - hard cap `ops.length <= 50`
 *      - recursively validate every `data` payload via `assertJsonValue`
 *
 *   2. Inside ONE `await conn.transact((doc) => { ... })`:
 *      a. snapshot `revisionBefore`
 *      b. stale-revision check FIRST (so an out-of-date agent gets
 *         `STALE_REVISION` instead of a misleading `NODE_NOT_FOUND`)
 *      c. project live `Y.Map`s into plain JS `Map`s via
 *         `structuredClone` per entry — `Y.Map.toJSON()` is shallow on
 *         stored values and would let a validator mutation leak straight
 *         into the live doc (verified in `web/scripts/spike-direct-conn.ts`)
 *      d. validate + apply each op AGAINST THE PROJECTION ONLY, building
 *         an `audit` of created / updated / deleted / cascaded ids
 *      e. if any op throws, the throw bubbles synchronously out of
 *         `conn.transact` — the live `Y.Map`s are unchanged, so no
 *         partial writes leak and no broadcast happens
 *      f. all ops valid → commit the audit's diff to the live `Y.Map`s
 *         in one batch (Yjs collapses to a single update event)
 *
 * IMPORTANT IMPLEMENTATION NOTES
 *
 * 1. The transact callback passed to `conn.transact(fn)` MUST be
 *    SYNCHRONOUS. Hocuspocus 4's `DirectConnection.transact` does NOT
 *    await `fn` (verified in `node_modules/@hocuspocus/server/dist/
 *    hocuspocus-server.esm.js:893`). Async throws are silently swallowed
 *    and the awaiter sees a phantom "success" with no writes.
 *
 * 2. The validate-then-commit two-phase design replaces the abandoned
 *    `Y.UndoManager` rollback approach. UndoManager is itself another
 *    Yjs update — partial writes broadcast before undo lands, and the
 *    state vector advances even on successful rollback. See the plan's
 *    "Why not Y.UndoManager?" call-out.
 *
 * 3. Origin tagging via Yjs is structural, not via the transact origin
 *    arg. Hocuspocus 4's `DirectConnection.transact` always wraps with
 *    `{ source: "local", context: this.context }` and does not accept
 *    an origin override. Provenance lives in `data.__codesign` and that
 *    is enough for v1. Future workstream: pass `BridgeOrigin` via the
 *    `openDirectConnection(name, context)` `context` arg so observers
 *    can `instanceof`-discriminate bridge writes.
 */

import { randomBytes } from "node:crypto"
import type { DirectConnection } from "@hocuspocus/server"
import type { Edge, Node } from "@xyflow/react"

import { AgentError } from "./errors"
import { edgesTouchingNode, getEdgesMap, getNodesMap } from "./graph"
import { assertJsonValue } from "./json-value"
import { computeRevision } from "./revision"
import {
  EdgeInputSchema,
  EdgePatchSchema,
  NodeInputSchema,
  NodePatchSchema,
  type AgentIdentity,
  type EditOp,
  type EditResponse,
  type ProvenanceStamp,
} from "./types"

const MAX_OPS = 50

export interface ApplyEditOptions {
  baseRevision?: string
  idempotencyKey?: string | null
}

interface Audit {
  created: { nodes: string[]; edges: string[] }
  updated: { nodes: string[]; edges: string[] }
  deleted: { nodes: string[]; edges: string[] }
  cascadedEdges: string[]
}

function newAudit(): Audit {
  return {
    created: { nodes: [], edges: [] },
    updated: { nodes: [], edges: [] },
    deleted: { nodes: [], edges: [] },
    cascadedEdges: [],
  }
}

function randomHex(n: number): string {
  return randomBytes(Math.ceil(n / 2)).toString("hex").slice(0, n)
}

function makeProvenance(identity: AgentIdentity): ProvenanceStamp {
  return {
    author: identity.id,
    runId: identity.runId ?? null,
    at: new Date().toISOString(),
  }
}

function stamp<T extends { data?: Record<string, unknown> }>(
  entity: T,
  identity: AgentIdentity,
): T {
  const data = (entity.data ?? {}) as Record<string, unknown>
  data.__codesign = makeProvenance(identity)
  entity.data = data
  return entity
}

function projectMap<T>(map: { keys(): IterableIterator<string>; get(id: string): T | undefined }): Map<string, T> {
  const out = new Map<string, T>()
  for (const id of map.keys()) {
    const value = map.get(id)
    if (value !== undefined) out.set(id, structuredClone(value))
  }
  return out
}

function dropFrom(arr: string[], id: string): void {
  const idx = arr.indexOf(id)
  if (idx !== -1) arr.splice(idx, 1)
}

/**
 * Recursively validate every `data` payload carried by `ops`. Runs
 * BEFORE we open the transact so a bad request never even touches the
 * doc lock. The route handler also runs `EditRequestBodySchema` on the
 * incoming JSON, but Zod's `z.unknown()` lets through `Date`, `Map`,
 * `NaN`, etc. — `assertJsonValue` is the strict gate.
 */
function preValidateJsonPayloads(ops: EditOp[]): void {
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    const base = `$.ops[${i}]`
    // Only validate fields that are actually present. `NodeInputSchema`
    // defaults `data` to `{}` but `applyEdit` is exported as a pure
    // function — direct callers may pass an unparsed array where
    // optional `data` fields are still undefined.
    switch (op.op) {
      case "addNode":
        if (op.node.data !== undefined) {
          assertJsonValue(op.node.data, `${base}.node.data`)
        }
        break
      case "updateNode":
        if (op.patch.data !== undefined) {
          assertJsonValue(op.patch.data, `${base}.patch.data`)
        }
        break
      case "addEdge":
        if (op.edge.data !== undefined) {
          assertJsonValue(op.edge.data, `${base}.edge.data`)
        }
        break
      case "updateEdge":
        if (op.patch.data !== undefined) {
          assertJsonValue(op.patch.data, `${base}.patch.data`)
        }
        break
      case "deleteNode":
      case "deleteEdge":
        // no `data` field to check
        break
    }
  }
}

/**
 * Validate + apply each op against the projection only. NEVER touches
 * the live `Y.Map`s. Throws `AgentError` on first failure; callers must
 * let the throw bubble out so the surrounding `conn.transact` body
 * commits zero Yjs writes.
 */
function applyOpsToProjection(
  ops: EditOp[],
  nodesProj: Map<string, Node>,
  edgesProj: Map<string, Edge>,
  identity: AgentIdentity,
): Audit {
  const audit = newAudit()

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]

    switch (op.op) {
      case "addNode": {
        // Re-validate defensively — the route handler already parsed,
        // but `applyEdit` is exported as a pure function callable from
        // tests / future surfaces (tRPC, MCP) that may bypass the route.
        const parsed = NodeInputSchema.parse(op.node)
        const id = parsed.id ?? `n-${randomHex(8)}`
        if (nodesProj.has(id)) {
          throw new AgentError("BAD_REQUEST", "node id already exists", { id })
        }
        const node: Node = {
          id,
          position: parsed.position,
          data: { ...parsed.data },
          ...(parsed.type !== undefined ? { type: parsed.type } : {}),
          ...(parsed.hidden !== undefined ? { hidden: parsed.hidden } : {}),
          ...(parsed.draggable !== undefined ? { draggable: parsed.draggable } : {}),
          ...(parsed.selectable !== undefined ? { selectable: parsed.selectable } : {}),
        }
        stamp(node, identity)
        nodesProj.set(id, node)
        audit.created.nodes.push(id)
        break
      }

      case "updateNode": {
        const patch = NodePatchSchema.parse(op.patch)
        const existing = nodesProj.get(op.id)
        if (!existing) {
          throw new AgentError("NODE_NOT_FOUND", `node not found: ${op.id}`, { id: op.id })
        }
        const mergedData: Record<string, unknown> = {
          ...((existing.data ?? {}) as Record<string, unknown>),
          ...(patch.data ?? {}),
        }
        const merged: Node = {
          ...existing,
          ...(patch.type !== undefined ? { type: patch.type } : {}),
          ...(patch.position !== undefined ? { position: patch.position } : {}),
          ...(patch.hidden !== undefined ? { hidden: patch.hidden } : {}),
          ...(patch.draggable !== undefined ? { draggable: patch.draggable } : {}),
          ...(patch.selectable !== undefined ? { selectable: patch.selectable } : {}),
          data: mergedData,
        }
        stamp(merged, identity)
        nodesProj.set(op.id, merged)
        if (
          !audit.created.nodes.includes(op.id) &&
          !audit.updated.nodes.includes(op.id)
        ) {
          audit.updated.nodes.push(op.id)
        }
        break
      }

      case "deleteNode": {
        if (!nodesProj.has(op.id)) {
          throw new AgentError("NODE_NOT_FOUND", `node not found: ${op.id}`, { id: op.id })
        }
        const cascade = op.cascadeEdges ?? true
        const touching = edgesTouchingNode(edgesProj, op.id)
        if (!cascade && touching.length > 0) {
          throw new AgentError(
            "EDGES_WOULD_BE_ORPHANED",
            "deleteNode would orphan edges; pass cascadeEdges:true to remove them",
            { nodeId: op.id, edgeIds: touching.map((e) => e.id) },
          )
        }

        // Cascade touching edges. Same-batch-created edges net out to
        // a no-op — drop from created.edges and DON'T add to cascadedEdges.
        for (const e of touching) {
          edgesProj.delete(e.id)
          if (audit.created.edges.includes(e.id)) {
            dropFrom(audit.created.edges, e.id)
            dropFrom(audit.updated.edges, e.id)
          } else {
            dropFrom(audit.updated.edges, e.id)
            if (!audit.cascadedEdges.includes(e.id)) {
              audit.cascadedEdges.push(e.id)
            }
          }
        }

        nodesProj.delete(op.id)

        // If this id was created in the same batch, the net effect is
        // that the create never happened — drop from created and don't
        // record a delete. Otherwise record the delete and clear any
        // earlier update entry.
        if (audit.created.nodes.includes(op.id)) {
          dropFrom(audit.created.nodes, op.id)
          dropFrom(audit.updated.nodes, op.id)
        } else {
          dropFrom(audit.updated.nodes, op.id)
          if (!audit.deleted.nodes.includes(op.id)) {
            audit.deleted.nodes.push(op.id)
          }
        }
        break
      }

      case "addEdge": {
        const parsed = EdgeInputSchema.parse(op.edge)
        const id = parsed.id ?? `e-${parsed.source}-${parsed.target}-${randomHex(6)}`
        if (edgesProj.has(id)) {
          throw new AgentError("BAD_REQUEST", "edge id already exists", { id })
        }
        if (!nodesProj.has(parsed.source)) {
          throw new AgentError(
            "EDGE_REFERENCES_MISSING_NODE",
            `edge source missing: ${parsed.source}`,
            { edgeId: id, missing: "source", nodeId: parsed.source },
          )
        }
        if (!nodesProj.has(parsed.target)) {
          throw new AgentError(
            "EDGE_REFERENCES_MISSING_NODE",
            `edge target missing: ${parsed.target}`,
            { edgeId: id, missing: "target", nodeId: parsed.target },
          )
        }
        const edge: Edge = {
          id,
          source: parsed.source,
          target: parsed.target,
          ...(parsed.type !== undefined ? { type: parsed.type } : {}),
          ...(parsed.sourceHandle !== undefined ? { sourceHandle: parsed.sourceHandle } : {}),
          ...(parsed.targetHandle !== undefined ? { targetHandle: parsed.targetHandle } : {}),
          ...(parsed.label !== undefined ? { label: parsed.label } : {}),
          ...(parsed.hidden !== undefined ? { hidden: parsed.hidden } : {}),
          ...(parsed.animated !== undefined ? { animated: parsed.animated } : {}),
          ...(parsed.selectable !== undefined ? { selectable: parsed.selectable } : {}),
          ...(parsed.deletable !== undefined ? { deletable: parsed.deletable } : {}),
          data: { ...(parsed.data ?? {}) },
        }
        stamp(edge as { data?: Record<string, unknown> }, identity)
        edgesProj.set(id, edge)
        audit.created.edges.push(id)
        break
      }

      case "updateEdge": {
        const patch = EdgePatchSchema.parse(op.patch)
        const existing = edgesProj.get(op.id)
        if (!existing) {
          throw new AgentError("EDGE_NOT_FOUND", `edge not found: ${op.id}`, { id: op.id })
        }
        if (patch.source !== undefined && !nodesProj.has(patch.source)) {
          throw new AgentError(
            "EDGE_REFERENCES_MISSING_NODE",
            `edge source missing: ${patch.source}`,
            { edgeId: op.id, missing: "source", nodeId: patch.source },
          )
        }
        if (patch.target !== undefined && !nodesProj.has(patch.target)) {
          throw new AgentError(
            "EDGE_REFERENCES_MISSING_NODE",
            `edge target missing: ${patch.target}`,
            { edgeId: op.id, missing: "target", nodeId: patch.target },
          )
        }
        const mergedData: Record<string, unknown> = {
          ...((existing.data ?? {}) as Record<string, unknown>),
          ...(patch.data ?? {}),
        }
        const merged: Edge = {
          ...existing,
          ...(patch.type !== undefined ? { type: patch.type } : {}),
          ...(patch.source !== undefined ? { source: patch.source } : {}),
          ...(patch.target !== undefined ? { target: patch.target } : {}),
          ...(patch.sourceHandle !== undefined ? { sourceHandle: patch.sourceHandle } : {}),
          ...(patch.targetHandle !== undefined ? { targetHandle: patch.targetHandle } : {}),
          ...(patch.label !== undefined ? { label: patch.label } : {}),
          ...(patch.hidden !== undefined ? { hidden: patch.hidden } : {}),
          ...(patch.animated !== undefined ? { animated: patch.animated } : {}),
          ...(patch.selectable !== undefined ? { selectable: patch.selectable } : {}),
          ...(patch.deletable !== undefined ? { deletable: patch.deletable } : {}),
          data: mergedData,
        }
        stamp(merged as { data?: Record<string, unknown> }, identity)
        edgesProj.set(op.id, merged)
        if (
          !audit.created.edges.includes(op.id) &&
          !audit.updated.edges.includes(op.id)
        ) {
          audit.updated.edges.push(op.id)
        }
        break
      }

      case "deleteEdge": {
        if (!edgesProj.has(op.id)) {
          throw new AgentError("EDGE_NOT_FOUND", `edge not found: ${op.id}`, { id: op.id })
        }
        edgesProj.delete(op.id)
        if (audit.created.edges.includes(op.id)) {
          dropFrom(audit.created.edges, op.id)
          dropFrom(audit.updated.edges, op.id)
        } else {
          dropFrom(audit.updated.edges, op.id)
          dropFrom(audit.cascadedEdges, op.id)
          if (!audit.deleted.edges.includes(op.id)) {
            audit.deleted.edges.push(op.id)
          }
        }
        break
      }
    }
  }

  return audit
}

export async function applyEdit(
  conn: DirectConnection,
  ops: EditOp[],
  identity: AgentIdentity,
  opts: ApplyEditOptions = {},
): Promise<EditResponse> {
  // Defensive op-count guard. `EditRequestBodySchema` already enforces
  // `.max(50)`, but `applyEdit` is exported as a pure function so a
  // future caller could pass an already-parsed array that bypasses Zod.
  if (ops.length > MAX_OPS) {
    throw new AgentError("BAD_REQUEST", `Too many ops (max ${MAX_OPS})`, {
      count: ops.length,
    })
  }

  preValidateJsonPayloads(ops)

  let response: EditResponse | undefined

  await conn.transact((doc) => {
    const revisionBefore = computeRevision(doc)

    if (opts.baseRevision !== undefined && revisionBefore !== opts.baseRevision) {
      // Embed the current snapshot inline so the agent can replan in
      // one round-trip. This must come BEFORE ref validation so a stale
      // agent doesn't see a misleading `NODE_NOT_FOUND`.
      const nodesMap = getNodesMap(doc)
      const edgesMap = getEdgesMap(doc)
      const nodes = Array.from(projectMap<Node>(nodesMap).values())
      const edges = Array.from(projectMap<Edge>(edgesMap).values())
      throw new AgentError(
        "STALE_REVISION",
        "Project has been modified since baseRevision",
        {
          baseRevision: opts.baseRevision,
          currentRevision: revisionBefore,
          snapshot: { revision: revisionBefore, nodes, edges },
        },
      )
    }

    const nodesMap = getNodesMap(doc)
    const edgesMap = getEdgesMap(doc)
    const nodesProj = projectMap<Node>(nodesMap)
    const edgesProj = projectMap<Edge>(edgesMap)

    const audit = applyOpsToProjection(ops, nodesProj, edgesProj, identity)

    // Commit the diff to the live Y.Maps in one batch. Yjs collapses
    // these into a single update event so observers see one broadcast
    // per applyEdit call.
    for (const id of audit.created.nodes) {
      const value = nodesProj.get(id)
      if (value) nodesMap.set(id, value)
    }
    for (const id of audit.updated.nodes) {
      const value = nodesProj.get(id)
      if (value) nodesMap.set(id, value)
    }
    for (const id of audit.deleted.nodes) {
      nodesMap.delete(id)
    }
    for (const id of audit.created.edges) {
      const value = edgesProj.get(id)
      if (value) edgesMap.set(id, value)
    }
    for (const id of audit.updated.edges) {
      const value = edgesProj.get(id)
      if (value) edgesMap.set(id, value)
    }
    const edgeDeletes = new Set<string>([
      ...audit.deleted.edges,
      ...audit.cascadedEdges,
    ])
    for (const id of edgeDeletes) {
      edgesMap.delete(id)
    }

    const revisionAfter = computeRevision(doc)
    response = {
      revision: revisionAfter,
      applied: ops.length,
      created: audit.created,
      updated: audit.updated,
      deleted: audit.deleted,
      cascadedEdges: audit.cascadedEdges,
    }
  })

  // If the transact body threw, the throw propagated through the
  // `await` above and we never reach this point. If we DO reach here,
  // `response` was assigned at the end of the transact body.
  if (!response) {
    throw new AgentError("INTERNAL_ERROR", "applyEdit transact returned without setting response")
  }
  return response
}
