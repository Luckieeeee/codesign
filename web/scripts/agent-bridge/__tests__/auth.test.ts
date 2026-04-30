import { describe, expect, test } from "bun:test"
import type { IncomingMessage } from "node:http"

import { AgentError } from "../../../lib/flow-core/errors"
import { checkSecret, parseAgentHeaders, type AgentIdentity } from "../auth"

function fakeReq(headers: Record<string, string>): IncomingMessage {
  // node:http lowercases header names in req.headers
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return { headers: lower } as unknown as IncomingMessage
}

function expectUnauthorized(fn: () => unknown): void {
  try {
    fn()
    throw new Error("should have thrown")
  } catch (err) {
    expect(err).toBeInstanceOf(AgentError)
    expect((err as AgentError).code).toBe("UNAUTHORIZED")
    expect((err as AgentError).httpStatus).toBe(401)
  }
}

describe("parseAgentHeaders", () => {
  test("parses the required X-Agent-Id and leaves other fields null", () => {
    const identity = parseAgentHeaders(fakeReq({ "X-Agent-Id": "claude-1" }))
    expect(identity.id).toBe("claude-1")
    expect(identity.name).toBeNull()
    expect(identity.runId).toBeNull()
    expect(identity.token).toBeNull()
    expect(identity.ownerId).toBeNull()
    expect(identity.ownerName).toBeNull()
    expect(identity.ownerEmail).toBeNull()
  })

  test("throws UNAUTHORIZED when X-Agent-Id is missing", () => {
    expectUnauthorized(() => parseAgentHeaders(fakeReq({})))
  })

  test("throws UNAUTHORIZED when X-Agent-Id is whitespace only", () => {
    expectUnauthorized(() =>
      parseAgentHeaders(fakeReq({ "X-Agent-Id": "   " })),
    )
  })

  test("populates X-Agent-Name and X-Agent-Run-Id when present", () => {
    const identity = parseAgentHeaders(
      fakeReq({
        "X-Agent-Id": "claude-1",
        "X-Agent-Name": "Claude Sonnet",
        "X-Agent-Run-Id": "run-42",
      }),
    )
    expect(identity.name).toBe("Claude Sonnet")
    expect(identity.runId).toBe("run-42")
  })

  test("leaves X-Agent-Name / X-Agent-Run-Id null when absent", () => {
    const identity = parseAgentHeaders(fakeReq({ "X-Agent-Id": "claude-1" }))
    expect(identity.name).toBeNull()
    expect(identity.runId).toBeNull()
  })

  test("X-Agent-Token populates token", () => {
    const identity = parseAgentHeaders(
      fakeReq({ "X-Agent-Id": "claude-1", "X-Agent-Token": "s3cret" }),
    )
    expect(identity.token).toBe("s3cret")
  })

  test("Authorization: Bearer populates token", () => {
    const identity = parseAgentHeaders(
      fakeReq({ "X-Agent-Id": "claude-1", Authorization: "Bearer s3cret" }),
    )
    expect(identity.token).toBe("s3cret")
  })

  test("Authorization: Bearer takes precedence over X-Agent-Token", () => {
    const identity = parseAgentHeaders(
      fakeReq({
        "X-Agent-Id": "claude-1",
        Authorization: "Bearer X",
        "X-Agent-Token": "Y",
      }),
    )
    expect(identity.token).toBe("X")
  })

  test("Authorization: Basic is ignored (token === null)", () => {
    const identity = parseAgentHeaders(
      fakeReq({ "X-Agent-Id": "claude-1", Authorization: "Basic abc" }),
    )
    expect(identity.token).toBeNull()
  })

  test("Bearer scheme is case-insensitive", () => {
    const lower = parseAgentHeaders(
      fakeReq({ "X-Agent-Id": "claude-1", Authorization: "bearer foo" }),
    )
    expect(lower.token).toBe("foo")

    const upper = parseAgentHeaders(
      fakeReq({ "X-Agent-Id": "claude-1", Authorization: "BEARER foo" }),
    )
    expect(upper.token).toBe("foo")
  })

  test("trims whitespace off id, name, and runId", () => {
    const identity = parseAgentHeaders(
      fakeReq({
        "X-Agent-Id": "  claude-1  ",
        "X-Agent-Name": "  Claude Sonnet  ",
        "X-Agent-Run-Id": "  run-42  ",
      }),
    )
    expect(identity.id).toBe("claude-1")
    expect(identity.name).toBe("Claude Sonnet")
    expect(identity.runId).toBe("run-42")
  })

  test("treats empty optional headers as missing", () => {
    const identity = parseAgentHeaders(
      fakeReq({
        "X-Agent-Id": "claude-1",
        "X-Agent-Name": "",
        "X-Agent-Run-Id": "",
      }),
    )
    expect(identity.name).toBeNull()
    expect(identity.runId).toBeNull()
  })

  test("populates X-Agent-Owner-Id / -Name / -Email when present", () => {
    const identity = parseAgentHeaders(
      fakeReq({
        "X-Agent-Id": "claude-1",
        "X-Agent-Owner-Id": "user_01H",
        "X-Agent-Owner-Name": "Alice",
        "X-Agent-Owner-Email": "alice@example.com",
      }),
    )
    expect(identity.ownerId).toBe("user_01H")
    expect(identity.ownerName).toBe("Alice")
    expect(identity.ownerEmail).toBe("alice@example.com")
  })

  test("trims and empties owner headers consistently", () => {
    const identity = parseAgentHeaders(
      fakeReq({
        "X-Agent-Id": "claude-1",
        "X-Agent-Owner-Id": "  user_01H  ",
        "X-Agent-Owner-Name": "",
        "X-Agent-Owner-Email": "   ",
      }),
    )
    expect(identity.ownerId).toBe("user_01H")
    expect(identity.ownerName).toBeNull()
    expect(identity.ownerEmail).toBeNull()
  })
})

describe("checkSecret", () => {
  function identityWith(token: string | null): AgentIdentity {
    return {
      id: "claude-1",
      name: null,
      runId: null,
      token,
      ownerId: null,
      ownerName: null,
      ownerEmail: null,
    }
  }

  test("secret: null always allows, even when token is null", () => {
    expect(() => checkSecret(identityWith(null), { secret: null })).not.toThrow()
  })

  test("secret set + matching token does not throw", () => {
    expect(() =>
      checkSecret(identityWith("s3cret"), { secret: "s3cret" }),
    ).not.toThrow()
  })

  test("secret set + missing token throws UNAUTHORIZED", () => {
    expectUnauthorized(() =>
      checkSecret(identityWith(null), { secret: "s3cret" }),
    )
  })

  test("secret set + wrong token throws UNAUTHORIZED", () => {
    expectUnauthorized(() =>
      checkSecret(identityWith("wrong"), { secret: "s3cret" }),
    )
  })

  test("secret set + correct token with trailing space throws (no normalisation)", () => {
    expectUnauthorized(() =>
      checkSecret(identityWith("s3cret "), { secret: "s3cret" }),
    )
  })

  test("constant-time compare handles different-length tokens without crashing", () => {
    // Length mismatch path: provided is much shorter than the expected secret.
    expectUnauthorized(() =>
      checkSecret(identityWith("a"), { secret: "much-longer-secret" }),
    )
    // Length mismatch in the other direction: provided is much longer.
    expectUnauthorized(() =>
      checkSecret(identityWith("much-longer-token"), { secret: "abc" }),
    )
  })
})
