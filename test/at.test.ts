import { describe, test } from "node:test"
import { expect } from "./expect.ts"
import { argvValues, expandsAt, parseAt, resolvePath, type Slot } from "../src/at.ts"
import type { Field } from "../src/contract.ts"
import { isFail } from "../src/fail.ts"

function field(type: Field["type"]): Field {
  return {
    name: "body",
    type,
    required: false,
    flagBindable: type === "string" || type === "number" || type === "integer" || type === "boolean" || type === "array",
  }
}

async function problemsAsync(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
    throw new Error("expected fail")
  } catch (error) {
    if (!isFail(error)) throw error
    return error.message
  }
}

describe("at grammar", () => {
  test("parseAt", () => {
    expect(parseAt("hello")).toEqual({ kind: "literal", text: "hello" })
    expect(parseAt("@@alice")).toEqual({ kind: "literal", text: "@alice" })
    expect(parseAt("@@-")).toEqual({ kind: "literal", text: "@-" })
    expect(parseAt("@-")).toEqual({ kind: "stdin" })
    expect(parseAt("@")).toEqual({ kind: "empty" })
    expect(parseAt("@notes.md")).toEqual({ kind: "file", path: "notes.md" })
    expect(parseAt("@-extra")).toEqual({ kind: "file", path: "-extra" })
  })

  test("resolvePath collapses . and ..", () => {
    expect(resolvePath("/cwd", "notes.md")).toBe("/cwd/notes.md")
    expect(resolvePath("/cwd", "./notes.md")).toBe("/cwd/notes.md")
    expect(resolvePath("/cwd/sub", "../notes.md")).toBe("/cwd/notes.md")
    expect(resolvePath("/cwd", "/abs.md")).toBe("/abs.md")
    expect(resolvePath("/", "notes.md")).toBe("/notes.md")
  })

  test("expandsAt is string and --input only", () => {
    expect(expandsAt({ kind: "input" })).toBe(true)
    expect(expandsAt({ kind: "flag", field: field("string") })).toBe(true)
    expect(expandsAt({ kind: "flag", field: field("number") })).toBe(false)
    expect(expandsAt({ kind: "flag", field: field("array") })).toBe(false)
    expect(expandsAt({ kind: "arg", field: field("string"), index: 0 })).toBe(true)
    expect(expandsAt({ kind: "arg", field: undefined, index: 0 })).toBe(false)
  })

  test("argvValues reads files, stdin once, and maps missing files", async () => {
    const slot: Slot = { kind: "flag", field: field("string") }
    const values = argvValues({
      cwd: "/cwd",
      readFile: async (path) => {
        if (path === "/cwd/notes.md") return "hello"
        throw new Error("missing")
      },
      stdin: { text: async () => "from-stdin" },
    })
    expect(await values.text(slot, "inline")).toBe("inline")
    expect(await values.text(slot, "@@alice")).toBe("@alice")
    expect(await values.text(slot, "@./notes.md")).toBe("hello")
    expect(await values.text(slot, "@-")).toBe("from-stdin")
    expect(values.stdin).toEqual({ kind: "consumed", by: "--body" })
    expect(await problemsAsync(() => values.text(slot, "@-"))).toContain("already read")
    expect(await problemsAsync(() => values.text(slot, "@missing.md"))).toContain("cannot read missing.md")
    expect(await problemsAsync(() => values.text(slot, "@"))).toContain("empty @")
    expect(await values.text({ kind: "flag", field: field("number") }, "@notes.md")).toBe("@notes.md")
  })
})
