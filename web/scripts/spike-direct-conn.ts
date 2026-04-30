/**
 * Spike: validate the assumptions the agent-bridge plan rests on.
 *
 * Run:  cd web && bun run scripts/spike-direct-conn.ts
 *
 * Asserts:
 *   1. Hocuspocus 4 exposes `openDirectConnection(documentName, ctx)` and
 *      it returns an object with `.document` (Y.Doc) and `.transact(fn)`.
 *   2. Two openDirectConnection calls to the same name return connections
 *      whose `.document` is the same Y.Doc instance (or at least syncs
 *      writes between them).
 *   3. `computeRevision(doc)` (FNV over Y.encodeStateVector) changes after
 *      a Y.Map mutation done inside `conn.transact`.
 *   4. Exceptions thrown from the async function passed to
 *      `await conn.transact(async fn)` propagate to the awaiter.
 *   5. `Y.Map.toJSON()` returns a fresh deep copy each call (so mutating
 *      the projection in operations.ts can't leak back to the live doc).
 *
 * Uses a no-op Database extension (no Supabase). Exits 0 on success,
 * non-zero on first failed assertion.
 */

import { Hocuspocus } from "@hocuspocus/server"
import { Database } from "@hocuspocus/extension-database"
import * as Y from "yjs"

function fnv1a64Hex(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5 >>> 0
  let h2 = 0x9dc5811c >>> 0
  for (const b of bytes) {
    h1 ^= b
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 ^= b
    h2 = Math.imul(h2, 0x01000193) >>> 0
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")
}

function computeRevision(doc: Y.Doc): string {
  return "rev1_" + fnv1a64Hex(Y.encodeStateVector(doc))
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`✗ FAIL: ${msg}`)
    process.exit(1)
  }
  console.log(`✓ ${msg}`)
}

async function main() {
  const hp = new Hocuspocus({
    name: "spike",
    port: 0, // never actually .listen() — we drive it via openDirectConnection
    extensions: [
      new Database({
        fetch: async () => null,
        store: async () => {},
      }),
    ],
  })

  // (1) openDirectConnection exists and returns the right shape
  const conn1 = await hp.openDirectConnection("doc-spike", {})
  assert(conn1, "openDirectConnection returned a value")
  assert(conn1.document instanceof Y.Doc, "conn1.document is a Y.Doc")
  assert(typeof conn1.transact === "function", "conn1.transact is a function")

  // (2) sibling connection sees writes from the first
  const conn2 = await hp.openDirectConnection("doc-spike", {})
  assert(conn2, "second openDirectConnection returned a value")

  const rev0 = computeRevision(conn1.document)
  console.log(`  initial rev: ${rev0}`)

  await conn1.transact((doc) => {
    const m = doc.getMap("flow:nodes")
    m.set("n1", { id: "n1", position: { x: 0, y: 0 }, data: { label: "A" } })
  })

  const rev1 = computeRevision(conn1.document)
  // (3) revision bumps on mutation
  assert(rev1 !== rev0, "revision changed after mutation")
  console.log(`  after-write rev: ${rev1}`)

  // sibling sees it
  const m2 = conn2.document.getMap("flow:nodes")
  assert(m2.has("n1"), "sibling DirectConnection sees the write")
  const rev1b = computeRevision(conn2.document)
  assert(rev1b === rev1, "sibling revision matches first connection")

  // (4) exceptions inside conn.transact propagate
  // CRITICAL: Hocuspocus's DirectConnection.transact calls
  //   `transaction(this.document)` WITHOUT awaiting (verified in
  //   node_modules/@hocuspocus/server/dist/hocuspocus-server.esm.js:893).
  // So async fns that reject are silently swallowed. The body MUST be a
  // synchronous function that throws synchronously — then Y.Doc.transact
  // lets it bubble, Hocuspocus's wrapper rejects, and the awaiter sees it.
  let caught: unknown = null
  try {
    await conn1.transact((_doc) => {
      throw new Error("BOOM")
    })
  } catch (err) {
    caught = err
  }
  assert(caught instanceof Error, "exception thrown SYNCHRONOUSLY inside transact propagated")
  assert(
    (caught as Error).message === "BOOM",
    "propagated exception preserved its message",
  )

  // also assert the async-throw failure mode so future readers see it
  let asyncCaught: unknown = null
  try {
    await conn1.transact(async (_doc) => {
      throw new Error("ASYNC BOOM")
    })
  } catch (err) {
    asyncCaught = err
  }
  assert(
    asyncCaught === null,
    "ASYNC throws inside conn.transact ARE silently swallowed (Hocuspocus 4 limitation) — operations.ts must use a SYNC fn",
  )

  // CRITICAL: revision must NOT have changed since no Y.Map writes happened
  const rev2 = computeRevision(conn1.document)
  assert(
    rev2 === rev1,
    "revision unchanged after a transact that only threw (no writes leaked)",
  )

  // (5) Y.Map.toJSON() projection semantics
  const liveMap = conn1.document.getMap("flow:nodes")
  const j1 = liveMap.toJSON()
  const j2 = liveMap.toJSON()
  assert(j1 !== j2, "two toJSON() calls return different OUTER object refs")
  // BUT the nested entries are the SAME reference because Y.Map stores the
  // plain object we set. So `j1.n1 === j2.n1` — toJSON() is shallow on
  // values it didn't itself construct. This means operations.ts MUST clone
  // each entry it intends to mutate (structuredClone is the right call).
  assert(
    j1.n1 === j2.n1,
    "Y.Map.toJSON() shares nested entry references (toJSON is shallow on stored values) — projection MUST structuredClone before mutating",
  )

  // Verify structuredClone fully isolates the projection from the live doc
  const cloned1 = structuredClone(liveMap.get("n1") as any)
  const cloned2 = structuredClone(liveMap.get("n1") as any)
  assert(cloned1 !== cloned2, "structuredClone returns a new outer object")
  assert(cloned1.data !== cloned2.data, "structuredClone deep-copies nested objects")
  cloned1.data.label = "MUTATED"
  const liveAfter = liveMap.get("n1") as any
  assert(
    liveAfter.data.label === "A",
    "mutating a structuredClone projection does NOT leak into the live Y.Map",
  )

  // also: a transact that does nothing should not bump the revision
  await conn1.transact((_doc) => {
    /* no-op */
  })
  const rev3 = computeRevision(conn1.document)
  assert(rev3 === rev2, "no-op transact did not bump the revision")

  // cleanup
  await conn1.disconnect()
  await conn2.disconnect()
  // NOTE: bare `new Hocuspocus()` (vs `new Server()`) has no destroy/close
  // method — process.exit cleans it up. The real collab-server.ts uses
  // hocuspocus.closeConnections() in its shutdown handler; we'll mirror
  // that pattern in collab-server-mount.

  console.log("\n✅ All spike assertions passed.")
  process.exit(0)
}

main().catch((err) => {
  console.error("Spike crashed:", err)
  process.exit(1)
})
