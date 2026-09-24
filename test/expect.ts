import assert from "node:assert/strict"

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
    assert.equal(negated ? !pass : pass, true, label)
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
      let pass = true
      try {
        assert.deepEqual(omitUndefined(actual), omitUndefined(expected))
      } catch {
        pass = false
      }
      check(pass, `toEqual ${JSON.stringify(expected)}`)
    },
    toContain(expected) {
      check(typeof actual === "string" && actual.includes(expected), `toContain ${JSON.stringify(expected)}`)
    },
    toContainEqual(expected) {
      const list = Array.isArray(actual) ? actual : []
      const pass = list.some((item) => {
        try {
          assert.deepEqual(omitUndefined(item), omitUndefined(expected))
          return true
        } catch {
          return false
        }
      })
      check(pass, `toContainEqual ${JSON.stringify(expected)}`)
    },
    toHaveLength(length) {
      const value = actual as { length?: number }
      check(value.length === length, `toHaveLength ${length}`)
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
