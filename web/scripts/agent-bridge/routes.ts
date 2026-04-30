/**
 * Agent-bridge HTTP routes — the request/response layer that exposes
 * `flow-core` to external agents.
 *
 * All endpoints live under `/api/agent/projects/:projectId/...` and
 * speak `application/json`. Wire-level shapes are owned by the Zod
 * schemas in `lib/flow-core/types.ts`; this module only handles the
 * HTTP plumbing (auth, rate limit, idempotency, body parse, CORS,
 * error normalisation) and dispatches to `flow-core` for the actual
 * graph reads/writes.
 *
 * ## Wiring decision (req-handler vs separate listener)
 *
 * Node's `http.Server` invokes every `request` listener for every
 * request, so simply registering an additional listener via
 * `httpServer.on("request", ...)` would result in BOTH the existing
 * collab-server handler AND the bridge handler trying to write the
 * response — the second `res.writeHead` throws `ERR_HTTP_HEADERS_SENT`.
 *
 * The cleanest, least-invasive integration (per the bridge plan) is to
 * expose `tryHandle(req, res) -> Promise<boolean>` on the value returned
 * from `mountAgentBridge`. The caller in `collab-server.ts` (wired by
 * the `collab-server-mount` todo) calls this at the top of its existing
 * request handler:
 *
 *   const httpServer = createServer(async (req, res) => {
 *     if (await bridge.tryHandle(req, res)) return // bridge owned it
 *     // ...existing /api/projects routes...
 *   })
 *
 * `mountAgentBridge` does NOT register any listener of its own — it
 * just initialises the rate-limit / idempotency state and hands back
 * `{ close, tryHandle }`. The signature deviates slightly from the spec
 * (which specified only `{ close }`); the deviation is necessary because
 * the rate limiter and idempotency cache live in the closure created by
 * `mountAgentBridge`, so the per-request entry point must be a value
 * returned from it rather than a free-standing module function. The
 * top-level `tryHandleAgentRoute` re-export points at the same closure
 * for callers who prefer that name.
 *
 * ## Caller wiring example
 *
 *   const ctx: BridgeContext = {
 *     disabled: !secretConfigured && !isLoopback,
 *     disabledReason: "Bridge requires CODESIGN_AGENT_BRIDGE_SECRET when COLLAB_WS_HOST is non-loopback",
 *     secret: process.env.CODESIGN_AGENT_BRIDGE_SECRET,
 *     allowedOrigins: parseOrigins(process.env.CODESIGN_AGENT_BRIDGE_ORIGINS),
 *   }
 *   const bridge = mountAgentBridge({ httpServer, hp, supabase, context: ctx, getProject })
 *   process.on("SIGTERM", async () => { await bridge.close(); await hp.destroy() })
 */

import { randomUUID } from "node:crypto"
import type { Server as HttpServer, IncomingMessage, ServerResponse } from "node:http"
import type { Hocuspocus } from "@hocuspocus/server"
import type { SupabaseClient } from "@supabase/supabase-js"
import { ZodError } from "zod"

import { AgentError, formatError } from "../../lib/flow-core/errors"
import { applyEdit } from "../../lib/flow-core/operations"
import { neighborhood, state, summary } from "../../lib/flow-core/snapshot"
import { touchAgentPresence } from "../../lib/flow-core/agent-presence"
import {
  EditRequestBodySchema,
  EditResponseSchema,
  NeighborhoodResponseSchema,
  SnapshotResponseSchema,
  StateResponseSchema,
  type AgentIdentity as FlowAgentIdentity,
} from "../../lib/flow-core/types"
import { openProjectDoc } from "../../lib/flow-core/document"
import { checkSecret, parseAgentHeaders, type AgentIdentity } from "./auth"
import {
  createIdempotencyCache,
  hashRequestBody,
  type IdempotencyCache,
} from "./idempotency"
import { createRateLimiter, tokenFingerprint, type RateLimiter } from "./rate-limit"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BridgeContext {
  /** When true, all routes return 503 BRIDGE_DISABLED. Set by mount-time gate. */
  disabled: boolean
  /** Reason string surfaced in 503 body. */
  disabledReason?: string
  /** Required when not disabled: secret for `Authorization: Bearer <secret>`. */
  secret?: string
  /**
   * Allowlist of Origins permitted to send `Origin` header. Empty/undefined =
   * no Origin enforcement (server-to-server only — Origin header is ignored).
   */
  allowedOrigins?: string[]
  /** Idempotency cache mode: "memory" (default) or "off". */
  idempotencyMode?: "memory" | "off"
}

export interface MountAgentBridgeOptions {
  /** Existing http server in collab-server.ts. Reserved for future use (e.g. close hook wiring). */
  httpServer: HttpServer
  hp: Hocuspocus
  supabase: SupabaseClient
  context: BridgeContext
  /**
   * Hook to verify a project id exists (and the agent may access it).
   * Returns null on missing/forbidden.
   */
  getProject: (projectId: string) => Promise<{ id: string } | null>
}

export interface MountedAgentBridge {
  /** Tear-down hook for graceful shutdown. */
  close: () => Promise<void>
  /**
   * Check if `req` matches an `/api/agent/...` route and handle it.
   * Returns `true` if the response was written by the bridge (caller
   * should `return` immediately); `false` if the bridge does not own
   * the URL (caller should fall through to its own routing).
   */
  tryHandle: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BRIDGE_PREFIX = "/api/agent/"
const MAX_BODY_BYTES = 1_000_000
const ROUTE_RE = /^\/api\/agent\/projects\/([^/]+)(\/.*)?$/
const NEIGHBORHOOD_RE = /^\/nodes\/([^/]+)\/neighborhood\/?$/

const ALLOWED_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-Agent-Id",
  "X-Agent-Name",
  "X-Agent-Run-Id",
  "X-Agent-Token",
  "Idempotency-Key",
].join(", ")
const ALLOWED_METHODS = "GET, POST, OPTIONS"

// ---------------------------------------------------------------------------
// Mount entry point
// ---------------------------------------------------------------------------

export function mountAgentBridge(opts: MountAgentBridgeOptions): MountedAgentBridge {
  // `httpServer` is accepted in the public API so callers can wire shutdown
  // / future listener attach without re-plumbing — but the current strategy
  // (cooperative tryHandle from inside the existing handler) does not use it.
  void opts.httpServer

  const rateLimiter: RateLimiter = createRateLimiter()
  const idempotency: IdempotencyCache | null =
    opts.context.idempotencyMode === "off" ? null : createIdempotencyCache()

  let closed = false

  async function tryHandle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = req.url ?? "/"
    if (!isBridgeUrl(url)) return false

    if (closed) {
      writeJson(res, 503, {
        error: { code: "BRIDGE_DISABLED", message: "Bridge is shutting down" },
      })
      return true
    }

    await dispatch(req, res, opts, rateLimiter, idempotency)
    return true
  }

  return {
    tryHandle,
    close: async () => {
      closed = true
      // No background intervals in rate-limit.ts or idempotency.ts (both
      // rely on lazy reaping on access), so there's nothing to clear.
      // Drop the cached state so any lingering reference can be GC'd.
      idempotency?.clear()
      rateLimiter.reset()
    },
  }
}

/**
 * Re-export of the per-request entry point. `mountAgentBridge` returns
 * a closure-bound version on `MountedAgentBridge.tryHandle`; this name
 * is kept for callers and docs that refer to "tryHandleAgentRoute".
 */
export type TryHandleAgentRoute = MountedAgentBridge["tryHandle"]

// ---------------------------------------------------------------------------
// URL matching
// ---------------------------------------------------------------------------

function isBridgeUrl(url: string): boolean {
  // Strip query string before prefix check so `/api/agent/foo?x=1` matches.
  const qIdx = url.indexOf("?")
  const path = qIdx === -1 ? url : url.slice(0, qIdx)
  return path === "/api/agent" || path.startsWith(BRIDGE_PREFIX)
}

interface ParsedRoute {
  projectId: string
  /** "summary" | "state" | "neighborhood" | "edit" */
  kind: "summary" | "state" | "neighborhood" | "edit"
  nodeId?: string
}

function parseRoute(pathname: string): ParsedRoute | null {
  const m = ROUTE_RE.exec(pathname)
  if (!m) return null
  const projectId = decodeURIComponent(m[1] ?? "")
  if (projectId === "") return null
  const tail = m[2] ?? ""

  if (tail === "/summary" || tail === "/summary/") {
    return { projectId, kind: "summary" }
  }
  if (tail === "/state" || tail === "/state/") {
    return { projectId, kind: "state" }
  }
  if (tail === "/edit" || tail === "/edit/") {
    return { projectId, kind: "edit" }
  }
  const nm = NEIGHBORHOOD_RE.exec(tail)
  if (nm) {
    const nodeId = decodeURIComponent(nm[1] ?? "")
    if (nodeId === "") return null
    return { projectId, kind: "neighborhood", nodeId }
  }
  return null
}

// ---------------------------------------------------------------------------
// Per-request pipeline
// ---------------------------------------------------------------------------

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  opts: MountAgentBridgeOptions,
  rateLimiter: RateLimiter,
  idempotency: IdempotencyCache | null,
): Promise<void> {
  const startedAt = Date.now()
  const requestId = randomUUID()
  res.setHeader("X-Request-Id", requestId)

  const ctx = opts.context
  const url = req.url ?? "/"
  const qIdx = url.indexOf("?")
  const pathname = qIdx === -1 ? url : url.slice(0, qIdx)
  const search = qIdx === -1 ? "" : url.slice(qIdx)
  const origin = getHeader(req, "origin")
  const method = (req.method ?? "GET").toUpperCase()

  // Always set CORS headers FIRST so they're present on errors too.
  applyCorsHeaders(res, origin, ctx.allowedOrigins)

  // 1. Mount-time disabled gate.
  if (ctx.disabled) {
    finishJson(
      res,
      503,
      {
        error: {
          code: "BRIDGE_DISABLED",
          message: ctx.disabledReason ?? "Agent bridge is disabled",
        },
      },
      { requestId, startedAt, projectId: null, agentId: null, route: pathname, method },
    )
    return
  }

  // 2. CORS preflight + origin enforcement.
  if (method === "OPTIONS") {
    res.statusCode = 204
    res.end()
    logRequest({ requestId, startedAt, projectId: null, agentId: null, route: pathname, method, status: 204 })
    return
  }
  if (origin !== null && !isOriginAllowed(origin, ctx.allowedOrigins)) {
    finishJson(
      res,
      403,
      { error: { code: "UNAUTHORIZED", message: "Origin not allowed" } },
      { requestId, startedAt, projectId: null, agentId: null, route: pathname, method },
    )
    return
  }

  // Parse the route shape. Unknown agent paths → 404.
  const route = parseRoute(pathname)
  if (route === null) {
    finishJson(
      res,
      404,
      { error: { code: "PROJECT_NOT_FOUND", message: "No such agent route" } },
      { requestId, startedAt, projectId: null, agentId: null, route: pathname, method },
    )
    return
  }

  // 3. Auth.
  let identity: AgentIdentity
  try {
    identity = parseAgentHeaders(req)
    checkSecret(identity, { secret: ctx.secret ?? null })
  } catch (err) {
    const { status, body } = formatError(err)
    finishJson(res, status, body, {
      requestId,
      startedAt,
      projectId: route.projectId,
      agentId: null,
      route: pathname,
      method,
    })
    return
  }

  // 4. Rate limit (per token+agent).
  const rlKey = `${tokenFingerprint(identity.token)}:${identity.id}`
  const rl = rateLimiter.take(rlKey)
  if (!rl.allowed) {
    const retryAfterSec = Math.max(1, Math.ceil(rl.retryAfterMs / 1000))
    res.setHeader("Retry-After", String(retryAfterSec))
    finishJson(
      res,
      429,
      {
        error: {
          code: "RATE_LIMITED",
          message: "Rate limit exceeded",
          details: { retryAfterMs: rl.retryAfterMs },
        },
      },
      {
        requestId,
        startedAt,
        projectId: route.projectId,
        agentId: identity.id,
        route: pathname,
        method,
      },
    )
    return
  }

  // 5. Project resolution (Supabase).
  try {
    const project = await opts.getProject(route.projectId)
    if (!project) {
      finishJson(
        res,
        404,
        {
          error: {
            code: "PROJECT_NOT_FOUND",
            message: `Project ${route.projectId} not found`,
          },
        },
        {
          requestId,
          startedAt,
          projectId: route.projectId,
          agentId: identity.id,
          route: pathname,
          method,
        },
      )
      return
    }
  } catch (err) {
    const { status, body } = formatError(err)
    finishJson(res, status, body, {
      requestId,
      startedAt,
      projectId: route.projectId,
      agentId: identity.id,
      route: pathname,
      method,
    })
    return
  }

  // Method-vs-route validation.
  const expectedMethod = route.kind === "edit" ? "POST" : "GET"
  if (method !== expectedMethod) {
    finishJson(
      res,
      405,
      {
        error: {
          code: "BAD_REQUEST",
          message: `Method ${method} not allowed on ${route.kind}`,
        },
      },
      {
        requestId,
        startedAt,
        projectId: route.projectId,
        agentId: identity.id,
        route: pathname,
        method,
      },
    )
    return
  }

  // 6. Body parse (POST only).
  let parsedBody: unknown = undefined
  if (method === "POST") {
    let raw: Buffer
    try {
      raw = await readBodyCapped(req, MAX_BODY_BYTES)
    } catch (err) {
      const { status, body } = formatError(err)
      finishJson(res, status, body, {
        requestId,
        startedAt,
        projectId: route.projectId,
        agentId: identity.id,
        route: pathname,
        method,
      })
      return
    }

    if (raw.length === 0) {
      finishJson(
        res,
        400,
        { error: { code: "BAD_REQUEST", message: "Request body is required" } },
        {
          requestId,
          startedAt,
          projectId: route.projectId,
          agentId: identity.id,
          route: pathname,
          method,
        },
      )
      return
    }

    let json: unknown
    try {
      json = JSON.parse(raw.toString("utf8"))
    } catch {
      finishJson(
        res,
        400,
        { error: { code: "BAD_REQUEST", message: "Invalid JSON body" } },
        {
          requestId,
          startedAt,
          projectId: route.projectId,
          agentId: identity.id,
          route: pathname,
          method,
        },
      )
      return
    }
    parsedBody = json
  }

  // 7. Route-specific handler. Wrapped to centralise error normalisation,
  //    response-schema validation, and idempotency cache writes.
  try {
    const result = await runHandler({
      route,
      method,
      identity,
      parsedBody,
      search,
      hp: opts.hp,
      idempotency,
      req,
    })

    // 8. Schema-validate response defensively before sending.
    finishJson(res, result.status, result.body, {
      requestId,
      startedAt,
      projectId: route.projectId,
      agentId: identity.id,
      route: pathname,
      method,
      replay: result.replay,
    })
  } catch (err) {
    // applyEdit throws AgentError on contract failures; everything else
    // becomes a redacted 500.
    const { status, body } = formatError(err)
    finishJson(res, status, body, {
      requestId,
      startedAt,
      projectId: route.projectId,
      agentId: identity.id,
      route: pathname,
      method,
    })
  }
}

// ---------------------------------------------------------------------------
// Per-route execution
// ---------------------------------------------------------------------------

interface RunHandlerArgs {
  route: ParsedRoute
  method: string
  identity: AgentIdentity
  parsedBody: unknown
  search: string
  hp: Hocuspocus
  idempotency: IdempotencyCache | null
  req: IncomingMessage
}

interface HandlerResult {
  status: number
  body: unknown
  /** True when the body was served from the idempotency cache. */
  replay?: boolean
}

async function runHandler(args: RunHandlerArgs): Promise<HandlerResult> {
  const { route, hp } = args
  const conn = await openProjectDoc(hp, route.projectId)
  const hasLiveClients = (hp.documents.get(route.projectId)?.connections.size ?? 0) > 0

  switch (route.kind) {
    case "summary": {
      let body: unknown
      await conn.transact((doc) => {
        body = SnapshotResponseSchema.parse(
          summary(doc, { projectId: route.projectId, hasLiveClients }),
        )
      })
      if (body === undefined) {
        throw new AgentError("INTERNAL_ERROR", "summary transact returned without body")
      }
      return { status: 200, body }
    }

    case "state": {
      let body: unknown
      await conn.transact((doc) => {
        body = StateResponseSchema.parse(
          state(doc, { projectId: route.projectId, hasLiveClients }),
        )
      })
      if (body === undefined) {
        throw new AgentError("INTERNAL_ERROR", "state transact returned without body")
      }
      return { status: 200, body }
    }

    case "neighborhood": {
      const nodeId = route.nodeId ?? ""
      const depth = parseDepth(args.search)
      let body: unknown
      let missing = false
      await conn.transact((doc) => {
        const result = neighborhood(doc, nodeId, depth)
        if (result === null) {
          missing = true
          return
        }
        body = NeighborhoodResponseSchema.parse(result)
      })
      if (missing) {
        throw new AgentError("NODE_NOT_FOUND", `Node ${nodeId} not found`, {
          nodeId,
        })
      }
      if (body === undefined) {
        throw new AgentError("INTERNAL_ERROR", "neighborhood transact returned without body")
      }
      return { status: 200, body }
    }

    case "edit": {
      // hasLiveClients is irrelevant for edits — the response shape
      // (`EditResponseSchema`) doesn't include it; only snapshot
      // responses surface that flag.
      void hasLiveClients
      return runEdit(args, conn)
    }
  }
}

async function runEdit(
  args: RunHandlerArgs,
  conn: Awaited<ReturnType<typeof openProjectDoc>>,
): Promise<HandlerResult> {
  const { route, identity, parsedBody, idempotency, req } = args

  // Validate body shape.
  let parsed: ReturnType<typeof EditRequestBodySchema.parse>
  try {
    parsed = EditRequestBodySchema.parse(parsedBody)
  } catch (err) {
    if (err instanceof ZodError) {
      throw new AgentError("BAD_REQUEST", "Invalid edit request body", {
        issues: err.issues,
      })
    }
    throw err
  }

  // Idempotency lookup (POST /edit only).
  const idempotencyKey = trimOrNull(getHeader(req, "idempotency-key"))
  let bodyHash: string | null = null
  if (idempotencyKey !== null && idempotency !== null) {
    bodyHash = hashRequestBody(parsedBody)
    const hit = idempotency.get(route.projectId, identity.id, idempotencyKey)
    if (hit !== undefined) {
      if (hit.bodyHash !== bodyHash) {
        throw new AgentError(
          "IDEMPOTENCY_KEY_REUSED_DIFFERENT_BODY",
          "Idempotency-Key reused with a different request body",
          { key: idempotencyKey },
        )
      }
      return { status: hit.status, body: hit.response, replay: true }
    }
  }

  // Convert auth identity → flow-core identity (drop token, normalise nulls).
  const flowIdentity: FlowAgentIdentity = { id: identity.id }
  if (identity.name !== null) flowIdentity.name = identity.name
  if (identity.runId !== null) flowIdentity.runId = identity.runId

  const editResp = await applyEdit(conn, parsed.ops, flowIdentity, {
    baseRevision: parsed.baseRevision,
    idempotencyKey,
    // Touch agent presence INSIDE applyEdit's transact, so:
    //   1. The edit and the presence write commit as one Yjs update
    //      (single broadcast), and
    //   2. Validation failures (NaN data, missing nodes, stale revision,
    //      …) abort the whole transact, including this presence write —
    //      so an agent that only sends invalid edits doesn't pollute
    //      the collaborator list.
    onCommit: (doc) => {
      touchAgentPresence(doc, {
        id: identity.id,
        name: identity.name ?? identity.id,
        ownerId: identity.ownerId,
        ownerName: identity.ownerName,
        ownerEmail: identity.ownerEmail,
        runId: identity.runId,
      })
    },
  })

  const body = EditResponseSchema.parse(editResp)

  if (idempotencyKey !== null && idempotency !== null && bodyHash !== null) {
    idempotency.set(route.projectId, identity.id, idempotencyKey, bodyHash, 200, body)
  }

  return { status: 200, body }
}

function parseDepth(search: string): number {
  if (search.length === 0) return 1
  // Strip leading '?'.
  const q = search.startsWith("?") ? search.slice(1) : search
  const params = new URLSearchParams(q)
  const raw = params.get("depth")
  if (raw === null) return 1
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return 1
  return n
}

// ---------------------------------------------------------------------------
// HTTP / I/O helpers
// ---------------------------------------------------------------------------

function getHeader(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name.toLowerCase()]
  if (Array.isArray(v)) return v[0] ?? null
  return v ?? null
}

function trimOrNull(v: string | null): string | null {
  if (v === null) return null
  const t = v.trim()
  return t === "" ? null : t
}

function isOriginAllowed(origin: string, allow: string[] | undefined): boolean {
  if (allow === undefined || allow.length === 0) return true
  return allow.includes(origin)
}

function applyCorsHeaders(
  res: ServerResponse,
  origin: string | null,
  allow: string[] | undefined,
): void {
  res.setHeader("Vary", "Origin")
  res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS)
  res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS)

  if (allow === undefined || allow.length === 0) {
    // Server-to-server / no allowlist configured. Bridge uses Bearer
    // tokens (no cookies) so a wildcard is safe — credentials must NOT
    // be set for `*` to be accepted by browsers.
    res.setHeader("Access-Control-Allow-Origin", "*")
    return
  }

  // Allowlist is configured. Echo back the request's origin only if it
  // matches; otherwise omit the header so the browser blocks the response.
  if (origin !== null && allow.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin)
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return
  res.statusCode = status
  res.setHeader("Content-Type", "application/json; charset=utf-8")
  res.end(JSON.stringify(body))
}

interface LogFields {
  requestId: string
  startedAt: number
  projectId: string | null
  agentId: string | null
  route: string
  method: string
  status?: number
  replay?: boolean
}

function finishJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  fields: LogFields,
): void {
  writeJson(res, status, body)
  logRequest({ ...fields, status })
}

function logRequest(fields: LogFields): void {
  const latencyMs = Date.now() - fields.startedAt
  const status = fields.status ?? 0
  const stream = status >= 500 ? console.error : status >= 400 ? console.warn : console.info
  const replay = fields.replay === true ? " replay=true" : ""
  stream(
    `[agent-bridge] ${fields.method} ${fields.route}` +
      ` project=${fields.projectId ?? "-"}` +
      ` agent=${fields.agentId ?? "-"}` +
      ` status=${status}` +
      ` latency=${latencyMs}ms` +
      ` rid=${fields.requestId}` +
      replay,
  )
}

/**
 * Read the request body into a single Buffer, capped at `maxBytes`.
 * Throws `AgentError("BAD_REQUEST", ...)` with code mapped to 413 via
 * a custom-coded throw — but our `AgentErrorCode` union doesn't have a
 * `PAYLOAD_TOO_LARGE` member, so we surface oversize bodies as
 * `BAD_REQUEST` with explicit details (`{ reason: "payload_too_large" }`)
 * matching the bridge plan's error catalogue (no 413 code is defined).
 */
function readBodyCapped(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let aborted = false

    const onData = (chunk: Buffer | string): void => {
      if (aborted) return
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk
      total += buf.length
      if (total > maxBytes) {
        aborted = true
        cleanup()
        // Drain the rest so the socket can close cleanly without EPIPE.
        req.resume()
        reject(
          new AgentError("BAD_REQUEST", "Request body too large", {
            reason: "payload_too_large",
            limitBytes: maxBytes,
          }),
        )
        return
      }
      chunks.push(buf)
    }
    const onEnd = (): void => {
      if (aborted) return
      cleanup()
      resolve(Buffer.concat(chunks))
    }
    const onError = (err: Error): void => {
      if (aborted) return
      aborted = true
      cleanup()
      reject(err)
    }
    function cleanup(): void {
      req.off("data", onData)
      req.off("end", onEnd)
      req.off("error", onError)
    }

    req.on("data", onData)
    req.on("end", onEnd)
    req.on("error", onError)
  })
}
