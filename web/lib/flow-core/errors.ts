/**
 * Error model for the agent bridge. Mirrors the catalogue in
 * `docs/agent-bridge-plan.md` § "Error code catalogue".
 *
 * Every code maps to exactly one HTTP status via `CODE_TO_STATUS`. The
 * bridge must never return an HTTP status that doesn't correspond to a
 * code in this union; conversely, every code listed below is part of
 * the public v1 contract and may not be silently renamed.
 */

export type AgentErrorCode =
  | "BAD_REQUEST"
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "UNAUTHORIZED"
  | "PROJECT_NOT_FOUND"
  | "NODE_NOT_FOUND"
  | "EDGE_NOT_FOUND"
  | "STALE_REVISION"
  | "IDEMPOTENCY_KEY_REUSED_DIFFERENT_BODY"
  | "EDGES_WOULD_BE_ORPHANED"
  | "EDGE_REFERENCES_MISSING_NODE"
  | "INVALID_OP"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR"
  | "BRIDGE_DISABLED"

export const CODE_TO_STATUS: Record<AgentErrorCode, number> = {
  BAD_REQUEST: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  UNAUTHORIZED: 401,
  PROJECT_NOT_FOUND: 404,
  NODE_NOT_FOUND: 404,
  EDGE_NOT_FOUND: 404,
  STALE_REVISION: 409,
  IDEMPOTENCY_KEY_REUSED_DIFFERENT_BODY: 409,
  EDGES_WOULD_BE_ORPHANED: 409,
  EDGE_REFERENCES_MISSING_NODE: 409,
  INVALID_OP: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  BRIDGE_DISABLED: 503,
}

export class AgentError extends Error {
  readonly code: AgentErrorCode
  readonly details?: Record<string, unknown>
  readonly httpStatus: number

  constructor(
    code: AgentErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "AgentError"
    this.code = code
    this.details = details
    this.httpStatus = CODE_TO_STATUS[code]
  }

  toJSON(): { error: { code: AgentErrorCode; message: string; details?: Record<string, unknown> } } {
    const error: { code: AgentErrorCode; message: string; details?: Record<string, unknown> } = {
      code: this.code,
      message: this.message,
    }
    if (this.details !== undefined) {
      error.details = this.details
    }
    return { error }
  }
}

/**
 * Normalise any thrown value into the wire envelope used by every
 * agent-bridge HTTP handler.
 *
 * - `AgentError` → its declared status + JSON body.
 * - Anything else → `INTERNAL_ERROR` 500 with a generic message; the
 *   original error (with stack) is logged via `console.error` so
 *   operators can correlate via timestamp without leaking internals to
 *   the agent.
 */
export function formatError(err: unknown): { status: number; body: unknown } {
  if (err instanceof AgentError) {
    return { status: err.httpStatus, body: err.toJSON() }
  }
  console.error("[agent-bridge] unhandled error", err)
  return {
    status: 500,
    body: { error: { code: "INTERNAL_ERROR", message: "Internal error" } },
  }
}
