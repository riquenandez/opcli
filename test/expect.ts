import assert from "node:assert/strict"
import { isDeepStrictEqual } from "node:util"

type Expect = {
  toBe(expected: unknown): void
  toBeNull(): void
  toBeString(): void
  toBeUndefined(): void
  toEqual(expected: unknown): void
  toContain(expected: string): void
  toContainEqual(expected: unknown): void
  toHaveLength(length: number): void
  toHaveProperty(key: string): void
  toMatch(pattern: RegExp): void
  readonly not: Expect
}

export function expect(actual: unknown): Expect {
  return matcher(actual, false)
}

function omitUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitUndefined)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) out[key] = omitUndefined(item)
    }
    return out
  }
  return value
}

function matcher(actual: unknown, negated: boolean): Expect {
  const check = (pass: boolean, label: string) => {
    assert.equal(pass, !negated, label)
  }
  return {
    toBe(expected) {
      check(Object.is(actual, expected), `toBe ${JSON.stringify(expected)}`)
    },
    toBeNull() {
      check(actual === null, "toBeNull")
    },
    toBeString() {
      check(typeof actual === "string", "toBeString")
    },
    toBeUndefined() {
      check(actual === undefined, "toBeUndefined")
    },
    toEqual(expected) {
      const actualValue = omitUndefined(actual)
      const expectedValue = omitUndefined(expected)
      if (negated) check(!isDeepStrictEqual(actualValue, expectedValue), "not toEqual")
      else assert.deepEqual(actualValue, expectedValue)
    },
    toContain(expected) {
      check(typeof actual === "string" && actual.includes(expected), `toContain ${JSON.stringify(expected)}`)
    },
    toContainEqual(expected) {
      assert.ok(Array.isArray(actual))
      const pass = actual.some((item) => isDeepStrictEqual(omitUndefined(item), omitUndefined(expected)))
      check(pass, `toContainEqual ${JSON.stringify(expected)}`)
    },
    toHaveLength(length) {
      const value = actual
      const hasLength = typeof value === "string" || Array.isArray(value)
      check(hasLength && value.length === length, `toHaveLength ${length}`)
    },
    toHaveProperty(key) {
      check(typeof actual === "object" && actual !== null && key in actual, `toHaveProperty ${key}`)
    },
    toMatch(pattern) {
      check(typeof actual === "string" && pattern.test(actual), `toMatch ${pattern}`)
    },
    get not() {
      return matcher(actual, !negated)
    },
  }
}
