import { Buffer } from "node:buffer"
import { timingSafeEqual } from "node:crypto"
import type { IncomingMessage } from "node:http"

import { AgentError } from "../../lib/flow-core/errors"

export interface AgentIdentity {
  id: string
  name: string | null
  runId: string | null
  /** The bearer/X-Agent-Token value if present, else null. Don't log. */
  token: string | null
}

export interface AuthConfig {
  /** When set, all requests must present this exact secret in
   *  `Authorization: Bearer <secret>` or `X-Agent-Token: <secret>`. */
  secret: string | null
}

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

function parseBearer(authHeader: string | null): string | null {
  if (authHeader === null) return null
  const trimmed = authHeader.trim()
  const match = /^Bearer\s+(.+)$/i.exec(trimmed)
  if (!match) return null
  const token = match[1].trim()
  return token === "" ? null : token
}

export function parseAgentHeaders(req: IncomingMessage): AgentIdentity {
  const id = trimOrNull(getHeader(req, "X-Agent-Id"))
  if (id === null) {
    throw new AgentError("UNAUTHORIZED", "X-Agent-Id header required")
  }

  const name = trimOrNull(getHeader(req, "X-Agent-Name"))
  const runId = trimOrNull(getHeader(req, "X-Agent-Run-Id"))

  // Precedence: when both `Authorization: Bearer <token>` and
  // `X-Agent-Token` are present (and differ), the bearer in the
  // standard `Authorization` header wins. `X-Agent-Token` is a
  // convenience alias for clients that can't easily set Authorization.
  const bearer = parseBearer(getHeader(req, "Authorization"))
  const xToken = getHeader(req, "X-Agent-Token")
  const token = bearer ?? (xToken === null || xToken === "" ? null : xToken)

  return { id, name, runId, token }
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8")
  const bufB = Buffer.from(b, "utf8")
  if (bufA.length !== bufB.length) {
    // Length mismatch is an immediate `false`, but do a self-compare on
    // the longer buffer to keep the work-amount roughly flat and avoid
    // exposing whether `a` or `b` was shorter via early exit timing.
    const filler = bufA.length >= bufB.length ? bufA : bufB
    timingSafeEqual(filler, filler)
    return false
  }
  return timingSafeEqual(bufA, bufB)
}

export function checkSecret(identity: AgentIdentity, cfg: AuthConfig): void {
  if (cfg.secret === null) return
  const provided = identity.token
  if (provided === null || !constantTimeEqual(provided, cfg.secret)) {
    throw new AgentError(
      "UNAUTHORIZED",
      "Missing or invalid bridge secret. Provide it via `Authorization: Bearer <secret>` or `X-Agent-Token: <secret>`.",
    )
  }
}
