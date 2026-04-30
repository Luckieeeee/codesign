/**
 * Recursive JSON-value validator for the agent bridge.
 *
 * `JSON.stringify` round-trips are lossy, not failing: `Date` becomes a
 * string, `Map`/`Set` become `{}`, functions are silently dropped, and
 * `NaN`/`Infinity` become `null`. None of those throw — they corrupt the
 * payload. The agent bridge needs a strict, throwing validator so the
 * caller gets a precise error pointing at the offending path.
 *
 * See `docs/agent-bridge-plan.md` § "JSON-value validation".
 */

import { AgentError } from "./errors"

const IDENTIFIER_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/

function joinKey(path: string, key: string): string {
  if (IDENTIFIER_RE.test(key)) {
    return `${path}.${key}`
  }
  return `${path}[${JSON.stringify(key)}]`
}

function joinIndex(path: string, index: number): string {
  return `${path}[${index}]`
}

type CheckFailure = { ok: false; path: string; message: string }
type CheckSuccess = { ok: true }
type CheckResult = CheckSuccess | CheckFailure

function fail(path: string, kind: string): CheckFailure {
  return {
    ok: false,
    path,
    message: `${path} is ${kind}`,
  }
}

function walk(value: unknown, path: string, seen: WeakSet<object>): CheckResult {
  if (value === null) return { ok: true }

  const t = typeof value

  if (t === "undefined") {
    return fail(path, "undefined, expected JSON-safe value")
  }
  if (t === "boolean" || t === "string") {
    return { ok: true }
  }
  if (t === "number") {
    if (!Number.isFinite(value)) {
      const n = value as number
      let label: string
      if (Number.isNaN(n)) label = "NaN"
      else if (n === Infinity) label = "Infinity"
      else label = "-Infinity"
      return fail(
        path,
        `${label}, expected a finite JSON number`,
      )
    }
    return { ok: true }
  }
  if (t === "bigint") {
    return fail(path, "a BigInt, expected a number or string")
  }
  if (t === "function") {
    return fail(path, "a function, expected JSON-safe value")
  }
  if (t === "symbol") {
    return fail(path, "a symbol, expected JSON-safe value")
  }

  // From here on, `value` is a non-null object.
  const obj = value as object

  if (seen.has(obj)) {
    return {
      ok: false,
      path,
      message: `${path} is part of a cycle, expected an acyclic JSON-safe value`,
    }
  }

  if (Array.isArray(obj)) {
    seen.add(obj)
    for (let i = 0; i < obj.length; i++) {
      const item = obj[i]
      const itemPath = joinIndex(path, i)
      const result = walk(item, itemPath, seen)
      if (!result.ok) return result
    }
    seen.delete(obj)
    return { ok: true }
  }

  // Reject well-known non-plain objects with helpful, type-specific messages.
  if (obj instanceof Date) {
    return fail(
      path,
      "a Date, expected JSON-safe value (use an ISO 8601 string instead)",
    )
  }
  if (obj instanceof Map) {
    return fail(path, "a Map, expected a plain object")
  }
  if (obj instanceof Set) {
    return fail(path, "a Set, expected an array")
  }
  if (obj instanceof RegExp) {
    return fail(path, "a RegExp, expected JSON-safe value")
  }
  if (obj instanceof Error) {
    return fail(path, "an Error, expected JSON-safe value")
  }
  if (obj instanceof Promise) {
    return fail(path, "a Promise, expected JSON-safe value")
  }
  if (obj instanceof ArrayBuffer) {
    return fail(path, "an ArrayBuffer, expected JSON-safe value")
  }
  if (ArrayBuffer.isView(obj)) {
    const ctorName =
      (obj.constructor && obj.constructor.name) || "TypedArray"
    return fail(
      path,
      `a ${ctorName}, expected JSON-safe value (encode as base64 string or array of numbers)`,
    )
  }

  const proto = Object.getPrototypeOf(obj)
  if (proto !== Object.prototype && proto !== null) {
    const ctorName =
      (obj.constructor && obj.constructor.name) || "non-plain object"
    return fail(
      path,
      `an instance of ${ctorName}, expected a plain object`,
    )
  }

  seen.add(obj)
  const record = obj as Record<string, unknown>
  const keys = Object.keys(record).sort()
  for (const key of keys) {
    const child = record[key]
    const childPath = joinKey(path, key)
    const result = walk(child, childPath, seen)
    if (!result.ok) return result
  }
  seen.delete(obj)
  return { ok: true }
}

/**
 * Same checks as `assertJsonValue` but returns a result instead of
 * throwing. Useful in test contexts and the per-op validator pipeline.
 */
export function checkJsonValue(
  value: unknown,
  path: string = "$",
):
  | { ok: true }
  | { ok: false; path: string; message: string } {
  const seen = new WeakSet<object>()
  return walk(value, path, seen)
}

/**
 * Recursively validate that `value` is a strictly JSON-safe value.
 *
 * Accepts: `null | boolean | finite-number | string | array-of-valid |
 * plain-object-of-valid` (where "plain object" means
 * `Object.getPrototypeOf(v) === Object.prototype || null`).
 *
 * Rejects (each with a distinct, descriptive message that includes the
 * JSON path of the offender): `undefined`, function, symbol, BigInt,
 * `Date`, `Map`, `Set`, `NaN`, `Infinity`, `-Infinity`, objects with
 * custom prototypes, and cycles (detected via `WeakSet`).
 *
 * Throws `AgentError("BAD_REQUEST", …)` on the first violation.
 */
export function assertJsonValue(value: unknown, path: string = "$"): void {
  const result = checkJsonValue(value, path)
  if (!result.ok) {
    throw new AgentError("BAD_REQUEST", result.message, { path: result.path })
  }
}
