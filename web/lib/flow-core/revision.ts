/**
 * Revision tokens for the live Y.Doc.
 *
 * Format: `"rev1_" + <16 lowercase hex chars>` (total length 21).
 *
 * The 64-bit hash is computed as FNV-1a over `Y.encodeStateVector(doc)`,
 * built from two independent 32-bit FNV-1a halves and concatenated as
 * `h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")`.
 * State vectors change on every Y.Doc mutation (browser drag, agent op,
 * sibling agent op), so the token bumps on every real write — that's the
 * only signal the agent bridge can use to detect a concurrent
 * browser-side mutation between read and write.
 *
 * The `"rev1_"` prefix is a deliberate version tag: if we ever swap the
 * hash family (e.g. to xxhash, blake3, or to hash full state instead of
 * just the state vector) we bump it to `"rev2_"`. Old clients comparing
 * `"rev1_…" === "rev2_…"` will then correctly fail-loud rather than
 * silently treating a different hash as a stale-revision conflict.
 *
 * Implementation lifted from `anthill/collab/src/revision.ts` and
 * confirmed working in `web/scripts/spike-direct-conn.ts`.
 */

import * as Y from "yjs"

const PREFIX = "rev1_"
const HEX_RE = /^[0-9a-f]{16}$/

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

export function computeRevision(doc: Y.Doc): string {
  return PREFIX + fnv1a64Hex(Y.encodeStateVector(doc))
}

export function isRevisionToken(value: unknown): value is string {
  if (typeof value !== "string") return false
  if (!value.startsWith(PREFIX)) return false
  return HEX_RE.test(value.slice(PREFIX.length))
}
