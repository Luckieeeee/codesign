import { describe, expect, test } from "bun:test"
import { AgentError } from "../errors"
import { assertJsonValue, checkJsonValue } from "../json-value"

function expectReject(
  value: unknown,
  expectedPath: string,
  expectedKindFragment: string,
) {
  try {
    assertJsonValue(value)
    throw new Error(`expected throw for ${String(value)}`)
  } catch (err) {
    if (!(err instanceof AgentError)) throw err
    expect(err.code).toBe("BAD_REQUEST")
    const detailsPath = (err.details as { path?: string } | undefined)?.path
    expect(detailsPath).toBe(expectedPath)
    expect(err.message.toLowerCase()).toContain(
      expectedKindFragment.toLowerCase(),
    )
  }
}

describe("assertJsonValue — positive cases", () => {
  test("accepts JSON primitives", () => {
    expect(() => assertJsonValue(null)).not.toThrow()
    expect(() => assertJsonValue(true)).not.toThrow()
    expect(() => assertJsonValue(false)).not.toThrow()
    expect(() => assertJsonValue(0)).not.toThrow()
    expect(() => assertJsonValue(-0)).not.toThrow()
    expect(() => assertJsonValue(1)).not.toThrow()
    expect(() => assertJsonValue(-1)).not.toThrow()
    expect(() => assertJsonValue(1.5)).not.toThrow()
    expect(() => assertJsonValue("")).not.toThrow()
    expect(() => assertJsonValue("hello")).not.toThrow()
  })

  test("accepts empty array and empty object", () => {
    expect(() => assertJsonValue([])).not.toThrow()
    expect(() => assertJsonValue({})).not.toThrow()
  })

  test("accepts deeply nested JSON values", () => {
    const nested = { a: { b: { c: [1, 2, [null, true, "x"]] } } }
    expect(() => assertJsonValue(nested)).not.toThrow()
  })

  test("accepts a null-prototype object", () => {
    const npo = Object.assign(Object.create(null), { a: 1 })
    expect(() => assertJsonValue(npo)).not.toThrow()
  })
})

describe("assertJsonValue — negative cases", () => {
  test("rejects undefined", () => {
    expectReject(undefined, "$", "undefined")
  })

  test("rejects functions", () => {
    expectReject(() => {}, "$", "function")
  })

  test("rejects symbols", () => {
    expectReject(Symbol("x"), "$", "symbol")
  })

  test("rejects bigints", () => {
    expectReject(BigInt(1), "$", "bigint")
  })

  test("rejects Date", () => {
    expectReject(new Date(), "$", "date")
  })

  test("rejects Map", () => {
    expectReject(new Map(), "$", "map")
  })

  test("rejects Set", () => {
    expectReject(new Set(), "$", "set")
  })

  test("rejects NaN", () => {
    expectReject(NaN, "$", "nan")
  })

  test("rejects Infinity", () => {
    try {
      assertJsonValue(Infinity)
      throw new Error("expected throw")
    } catch (err) {
      if (!(err instanceof AgentError)) throw err
      expect(err.code).toBe("BAD_REQUEST")
      expect((err.details as { path?: string }).path).toBe("$")
      const lower = err.message.toLowerCase()
      expect(
        lower.includes("infinity") || lower.includes("finite number"),
      ).toBe(true)
    }
  })

  test("rejects -Infinity", () => {
    try {
      assertJsonValue(-Infinity)
      throw new Error("expected throw")
    } catch (err) {
      if (!(err instanceof AgentError)) throw err
      expect(err.code).toBe("BAD_REQUEST")
      expect((err.details as { path?: string }).path).toBe("$")
      const lower = err.message.toLowerCase()
      expect(
        lower.includes("infinity") || lower.includes("finite number"),
      ).toBe(true)
    }
  })

  test("rejects custom-prototype class instance", () => {
    class Foo {
      x = 1
    }
    try {
      assertJsonValue(new Foo())
      throw new Error("expected throw")
    } catch (err) {
      if (!(err instanceof AgentError)) throw err
      expect(err.code).toBe("BAD_REQUEST")
      expect((err.details as { path?: string }).path).toBe("$")
      const lower = err.message.toLowerCase()
      expect(
        lower.includes("foo") ||
          lower.includes("instance") ||
          lower.includes("plain object"),
      ).toBe(true)
    }
  })

  test("rejects cycles with path including $.self and 'cycle' in message", () => {
    const o: { self?: unknown } = {}
    o.self = o
    try {
      assertJsonValue(o)
      throw new Error("expected throw")
    } catch (err) {
      if (!(err instanceof AgentError)) throw err
      expect(err.code).toBe("BAD_REQUEST")
      const path = (err.details as { path?: string }).path
      expect(path).toBeDefined()
      expect(path).toContain("$.self")
      expect(err.message.toLowerCase()).toContain("cycle")
    }
  })
})

describe("assertJsonValue — path reporting", () => {
  test("reports nested array index path", () => {
    expectReject(
      { data: { foo: [1, new Date()] } },
      "$.data.foo[1]",
      "date",
    )
  })

  test("reports quoted-key path for non-identifier keys", () => {
    expectReject({ "weird key": new Set() }, '$["weird key"]', "set")
  })

  test("reports multi-level path with array index and child key", () => {
    expectReject(
      { a: { b: [null, { c: undefined }] } },
      "$.a.b[1].c",
      "undefined",
    )
  })
})

describe("checkJsonValue — non-throwing variant", () => {
  test("returns ok:true for a valid value", () => {
    expect(checkJsonValue({})).toEqual({ ok: true })
  })

  test("returns ok:false with path and Date-related message", () => {
    const result = checkJsonValue({ a: new Date() })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.path).toBe("$.a")
      expect(result.message).toContain("Date")
    }
  })
})

describe("assertJsonValue — cycle detection edge cases", () => {
  test("sibling objects do not trigger a false-positive cycle error", () => {
    expect(() =>
      assertJsonValue({ a: { x: 1 }, b: { x: 2 } }),
    ).not.toThrow()
  })

  test("the same object referenced twice without an actual cycle is allowed", () => {
    const shared = { x: 1 }
    expect(() => assertJsonValue({ a: shared, b: shared })).not.toThrow()
  })
})
