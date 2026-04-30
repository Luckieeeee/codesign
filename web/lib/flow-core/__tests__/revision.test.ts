import { describe, expect, test } from "bun:test"
import * as Y from "yjs"
import { computeRevision, isRevisionToken } from "../revision"

describe("computeRevision format", () => {
  test("empty Y.Doc revision starts with rev1_ and matches the canonical pattern", () => {
    const doc = new Y.Doc()
    const rev = computeRevision(doc)
    expect(rev.startsWith("rev1_")).toBe(true)
    expect(rev).toMatch(/^rev1_[0-9a-f]{16}$/)
  })
})

describe("isRevisionToken", () => {
  test("accepts a freshly computed revision", () => {
    const doc = new Y.Doc()
    expect(isRevisionToken(computeRevision(doc))).toBe(true)
  })

  test("accepts a hand-written canonical token", () => {
    expect(isRevisionToken("rev1_0123456789abcdef")).toBe(true)
  })

  test.each([
    ["empty string", ""],
    ["non-hex body", "rev1_xyz"],
    ["body too short (15 hex chars)", "rev1_0123456789abcde"],
    ["body too long (17 hex chars)", "rev1_0123456789abcdef0"],
    ["wrong version prefix", "rev2_0123456789abcdef"],
    ["uppercase hex", "rev1_0123456789ABCDEF"],
  ])("rejects %s", (_label, value) => {
    expect(isRevisionToken(value)).toBe(false)
  })

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["number", 123],
    ["object", { rev: "rev1_0123456789abcdef" }],
  ])("rejects non-string value: %s", (_label, value) => {
    expect(isRevisionToken(value)).toBe(false)
  })
})

describe("computeRevision bumps on mutation", () => {
  test("setting a node into flow:nodes changes the revision", () => {
    const doc = new Y.Doc()
    const rev0 = computeRevision(doc)
    doc.getMap("flow:nodes").set("n1", new Y.Map())
    const rev1 = computeRevision(doc)
    expect(rev1).not.toBe(rev0)
    expect(isRevisionToken(rev1)).toBe(true)
  })
})

describe("computeRevision is order-independent over the state vector", () => {
  test("applying the same updates in different orders yields the same revision", () => {
    const origin = new Y.Doc()
    const nodes = origin.getMap("flow:nodes")

    const svBeforeFirst = Y.encodeStateVector(origin)
    nodes.set("n1", new Y.Map())
    const update1 = Y.encodeStateAsUpdate(origin, svBeforeFirst)

    const svBeforeSecond = Y.encodeStateVector(origin)
    nodes.set("n2", new Y.Map())
    const update2 = Y.encodeStateAsUpdate(origin, svBeforeSecond)

    const docA = new Y.Doc()
    Y.applyUpdate(docA, update1)
    Y.applyUpdate(docA, update2)

    const docB = new Y.Doc()
    Y.applyUpdate(docB, update2)
    Y.applyUpdate(docB, update1)

    expect(computeRevision(docA)).toBe(computeRevision(docB))
  })
})

describe("computeRevision distinguishes different content", () => {
  test("docs with different content produce different revisions", () => {
    const origin = new Y.Doc()
    const nodes = origin.getMap("flow:nodes")
    nodes.set("n1", new Y.Map())
    const updateOneNode = Y.encodeStateAsUpdate(origin)

    nodes.set("n2", new Y.Map())
    const updateTwoNodes = Y.encodeStateAsUpdate(origin)

    const docA = new Y.Doc()
    Y.applyUpdate(docA, updateOneNode)

    const docB = new Y.Doc()
    Y.applyUpdate(docB, updateTwoNodes)

    expect(computeRevision(docA)).not.toBe(computeRevision(docB))
  })
})
