import { describe, test } from "node:test"
import { expect } from "./expect.ts"
import { z } from "zod"
import { app, fail, op, out } from "../src/index.ts"
import { readLineFrom } from "../src/cli.ts"
import { mcpCall, mcpTools } from "../src/mcp.ts"

const Row = z.object({
  id: z.string(),
  meta: z.object({ city: z.string() }),
})

const list = op({
  name: "items.list",
  summary: "List items",
  input: z.object({}),
  output: out.unbounded(Row),
  effects: "read_only",
  examples: [{ summary: "All", input: {} }],
  async run({ limit }) {
    const items = [{ id: "1", meta: { city: "Austin" } }]
    return { items: items.slice(0, limit), nextCursor: items[limit]?.id }
  },
})

const get = op({
  name: "items.get",
  summary: "Show one",
  input: z.object({ id: z.string() }),
  args: ["id"],
  output: out.single(Row),
  effects: "read_only",
  examples: [{ summary: "By id", input: { id: "1" } }],
  run({ id }) {
    if (id !== "1") return fail.user(`no such item: ${id}`)
    return { id: "1", meta: { city: "Austin" } }
  },
})

const del = op({
  name: "items.delete",
  summary: "Delete one",
  input: z.object({ id: z.string() }),
  args: ["id"],
  output: out.single(z.object({ id: z.string() })),
  effects: "idempotent",
  confirm: (input) => `Delete ${input.id}?`,
  examples: [{ summary: "Delete", input: { id: "1" } }],
  run({ id }) {
    return { id }
  },
})

const tail = op({
  name: "logs.tail",
  summary: "Stream",
  input: z.object({}),
  output: out.stream(z.object({ message: z.string(), extra: z.string() })),
  effects: "read_only",
  examples: [{ summary: "Follow", input: {} }],
  async *run() {
    yield { message: "one", extra: "z" }
  },
})

const cli = app({
  name: "demo",
  version: "0.1.0",
  summary: "Demo",
  pagination: { defaultLimit: 10, maxLimit: 20 },
  groups: { items: "Demo items", logs: "Demo logs" },
  operations: [list, get, del, tail],
})

const tty = { stdin: true, stdout: true, stderr: true }

describe("projection bugs", () => {
  test("help pagination uses app.pagination", async () => {
    const r = await cli.run(["items", "list", "--help"])
    expect(r.exit).toBe(0)
    expect(r.stdout).toContain("default 10, max 20")
    expect(r.stdout).not.toContain("default 50, max 200")
  })

  test("agent on a TTY gets JSON", async () => {
    const r = await cli.run(["items", "list"], { tty, env: { CURSOR_AGENT: "1" } })
    expect(r.exit).toBe(0)
    expect(JSON.parse(r.stdout).data[0].id).toBe("1")
  })

  test("CI on a TTY gets JSON", async () => {
    const r = await cli.run(["items", "list"], { tty, env: { CI: "true" } })
    expect(r.exit).toBe(0)
    expect(JSON.parse(r.stdout).data[0].id).toBe("1")
  })

  test("--human wins over agent JSON default", async () => {
    const r = await cli.run(["items", "list", "--human"], { tty, env: { CURSOR_AGENT: "1" } })
    expect(r.exit).toBe(0)
    expect(r.stdout).toContain("ID")
    expect(r.stdout.startsWith("{")).toBe(false)
  })

  test("usage error on a TTY honors --json", async () => {
    const r = await cli.run(["nope", "--json"], { tty })
    expect(r.exit).toBe(2)
    expect(r.stdout).toBe("")
    expect(JSON.parse(r.stderr).error.kind).toBe("usage")
    expect(r.stderr).not.toContain("Usage:")
  })

  test("dotted --fields human table shows the nested value", async () => {
    const r = await cli.run(["items", "list", "--fields", "meta.city", "--human"])
    expect(r.exit).toBe(0)
    expect(r.stdout).toContain("Austin")
    expect(r.stdout).not.toContain("—")
  })

  test("stream rejects --fields", async () => {
    const r = await cli.run(["logs", "tail", "--fields", "message", "--json"])
    expect(r.exit).toBe(2)
    expect(r.stdout).toBe("")
    expect(r.stderr).toContain("fields")
  })

  test("stream help does not advertise --fields", async () => {
    const r = await cli.run(["logs", "tail", "--help"])
    expect(r.exit).toBe(0)
    expect(r.stdout).not.toContain("--fields")
  })

  test("readLineFrom returns at the first newline without waiting for EOF", async () => {
    async function* chunks() {
      yield "y\n"
      yield "ignored"
    }
    expect(await readLineFrom(chunks())).toBe("y")
  })

  test("mcp tool schema includes yes, limit, and cursor when the op uses them", () => {
    const tools = Object.fromEntries(mcpTools(cli).map((tool) => [tool.name, tool]))
    const listSchema = tools.items_list?.inputSchema as { properties?: Record<string, unknown> }
    const deleteSchema = tools.items_delete?.inputSchema as { properties?: Record<string, unknown> }
    expect(listSchema.properties?.limit).toEqual({ type: "integer", minimum: 1 })
    expect(listSchema.properties?.cursor).toEqual({ type: "string" })
    expect(deleteSchema.properties?.yes).toEqual({ type: "boolean" })
  })

  test("mcp error payload includes message", async () => {
    const r = await mcpCall(cli, "items_delete", { id: "1" }, {
      signal: new AbortController().signal,
      auth: null,
      confirmed: false,
      actor: "agent",
      note() {},
    })
    expect(r.isError).toBe(true)
    if (r.isError) {
      expect(r.structuredContent.error.message).toContain("--yes")
      expect(JSON.parse(JSON.stringify(r.structuredContent.error)).message).toContain("--yes")
    }
  })

  test("mcp yes confirms without being an input field", async () => {
    const r = await mcpCall(cli, "items_delete", { id: "1", yes: true }, {
      signal: new AbortController().signal,
      auth: null,
      confirmed: false,
      actor: "agent",
      note() {},
    })
    expect(r.isError).toBe(false)
    if (!r.isError) expect(r.structuredContent).toEqual({ data: { id: "1" }, meta: undefined })
  })

  test("manifest does not advertise color flags", async () => {
    const r = await cli.run(["--help", "--json"])
    const body = JSON.parse(r.stdout)
    expect(body.globalFlags).not.toContain("no-color")
    expect(body.globalFlags).not.toContain("color")
    expect(body.valueSyntax.at.escape).toBe("@@")
  })
})
