import { describe, test } from "node:test"
import { expect } from "./expect.ts"
import { z } from "zod"
import { passthrough } from "../src/contract.ts"
import { parseArgv, type ProcessIO } from "../src/cli.ts"
import { app, fail, op, out } from "../src/index.ts"

const Task = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["open", "done"]),
  url: z.string().url(),
  createdAt: z.string().datetime(),
})

const db = {
  tasks: [
    {
      id: "tsk_1",
      title: "Ship CLI",
      status: "open" as const,
      url: "https://example.com/t/tsk_1",
      createdAt: "2026-09-14T18:02:11Z",
    },
    {
      id: "tsk_2",
      title: "Write docs",
      status: "open" as const,
      url: "https://example.com/t/tsk_2",
      createdAt: "2026-09-14T17:40:00Z",
    },
  ],
  deleted: [] as string[],
}

const tasksList = op({
  name: "tasks.list",
  summary: "List tasks",
  input: z.object({
    status: Task.shape.status.optional().describe("Only this status"),
  }),
  output: out.unbounded(Task),
  effects: "read_only",
  examples: [{ summary: "Open tasks", input: { status: "open" } }],
  async run(input) {
    const items = db.tasks.filter((task) => !input.status || task.status === input.status)
    const start = 0
    const page = items.slice(start, start + input.limit)
    const next = items[start + input.limit]
    return { items: page, nextCursor: next ? next.id : undefined }
  },
})

const tasksGet = op({
  name: "tasks.get",
  summary: "Show one task",
  input: z.object({ id: z.string() }),
  args: ["id"],
  output: out.single(Task),
  effects: "read_only",
  examples: [{ summary: "By ID", input: { id: "tsk_1" } }],
  run({ id }) {
    const task = db.tasks.find((item) => item.id === id)
    if (!task) return fail.user(`task ${id} not found`, { hint: "run tasks list" })
    return task
  },
})

const tasksCreate = op({
  name: "tasks.create",
  summary: "Create a task",
  input: z.object({
    title: z.string().min(1),
    body: z.string().optional(),
  }),
  output: out.single(Task),
  effects: "non_idempotent",
  examples: [{ summary: "Title only", input: { title: "Hello" } }],
  run({ title, body }) {
    const task = {
      id: "tsk_new",
      title: body ? `${title}:${body}` : title,
      status: "open" as const,
      url: "https://example.com/t/tsk_new",
      createdAt: "2026-09-15T00:00:00Z",
    }
    db.tasks.push(task)
    return task
  },
})

const tasksDelete = op({
  name: "tasks.delete",
  summary: "Delete a task",
  input: z.object({ id: z.string() }),
  args: ["id"],
  output: out.single(Task.pick({ id: true, status: true })),
  effects: "idempotent",
  confirm: (input) => `Delete ${input.id}?`,
  examples: [{ summary: "Delete", input: { id: "tsk_1" } }],
  run({ id }) {
    db.deleted.push(id)
    return { id, status: "done" as const }
  },
})

const logsTail = op({
  name: "logs.tail",
  summary: "Stream logs",
  input: z.object({}),
  output: out.stream(z.object({ message: z.string() })),
  effects: "read_only",
  examples: [{ summary: "Follow", input: {} }],
  async *run() {
    yield { message: "one" }
    yield { message: "two" }
  },
})

const dump = op({
  name: "export",
  summary: "Dump bytes",
  input: z.object({}),
  output: out.opaque("application/gzip"),
  effects: "read_only",
  examples: [{ summary: "Export", input: {} }],
  run() {
    return new TextEncoder().encode("gzip")
  },
})

const cli = app({
  name: "demo",
  version: "1.4.0",
  summary: "Task tracker",
  groups: { tasks: "Manage tasks", logs: "Stream logs" },
  auth: { env: "DEMO_TOKEN", flag: "token" },
  operations: [tasksList, tasksGet, tasksCreate, tasksDelete, logsTail, dump],
})

const env = { DEMO_TOKEN: "t_test" }

describe("opcli", () => {
  test("list is paginated JSON when not a TTY", async () => {
    const r = await cli.run(["tasks", "list", "--status", "open", "--limit", "1"], { env })
    expect(r.exit).toBe(0)
    expect(r.stderr).toBe("")
    const body = JSON.parse(r.stdout)
    expect(body.data).toHaveLength(1)
    expect(body.meta.nextCursor).toBeString()
  })

  test("unknown projection fails before a delete", async () => {
    db.deleted = []
    const r = await cli.run(["tasks", "delete", "tsk_1", "--yes", "--fields", "idd"], { env })
    expect(r.exit).toBe(2)
    expect(r.stdout).toBe("")
    expect(db.deleted).toEqual([])
    expect(r.stderr).toContain("idd")
  })

  test("delete refuses without --yes", async () => {
    const r = await cli.run(["tasks", "delete", "tsk_1"], { env })
    expect(r.exit).toBe(2)
    expect(r.stdout).toBe("")
    expect(JSON.parse(r.stderr).error.kind).toBe("usage")
  })

  test("delete with --yes returns the object", async () => {
    db.deleted = []
    const r = await cli.run(["tasks", "delete", "tsk_1", "--yes", "--json"], { env })
    expect(r.exit).toBe(0)
    expect(JSON.parse(r.stdout).data.id).toBe("tsk_1")
    expect(db.deleted).toEqual(["tsk_1"])
  })

  test("create reads @path", async () => {
    const r = await cli.run(["tasks", "create", "--title", "Postmortem", "--body", "@notes.md", "--json"], {
      env,
      files: { "/notes.md": "hello" },
    })
    expect(r.exit).toBe(0)
    expect(JSON.parse(r.stdout).data.title).toBe("Postmortem:hello")
  })

  test("create reads @./path after normalize", async () => {
    const r = await cli.run(["tasks", "create", "--title", "Postmortem", "--body", "@./notes.md", "--json"], {
      env,
      files: { "/notes.md": "hello" },
    })
    expect(r.exit).toBe(0)
    expect(JSON.parse(r.stdout).data.title).toBe("Postmortem:hello")
  })

  test("@@ keeps a leading at", async () => {
    const r = await cli.run(["tasks", "create", "--title", "@@alice", "--json"], { env })
    expect(r.exit).toBe(0)
    expect(JSON.parse(r.stdout).data.title).toBe("@alice")
  })

  test("missing @path is usage", async () => {
    const r = await cli.run(["tasks", "create", "--title", "x", "--body", "@missing.md"], { env })
    expect(r.exit).toBe(2)
    expect(r.stdout).toBe("")
    expect(r.stderr).toContain("cannot read missing.md")
  })

  test("@- fills a string flag from stdin", async () => {
    const r = await cli.run(["tasks", "create", "--title", "Postmortem", "--body", "@-", "--json"], {
      env,
      stdin: "hello",
    })
    expect(r.exit).toBe(0)
    expect(JSON.parse(r.stdout).data.title).toBe("Postmortem:hello")
  })

  test("second @- is usage", async () => {
    const r = await cli.run(["tasks", "create", "--title", "@-", "--body", "@-"], { env, stdin: "once" })
    expect(r.exit).toBe(2)
    expect(r.stderr).toContain("already read")
  })

  test("@- plus confirm requires --yes", async () => {
    const r = await cli.run(["tasks", "delete", "@-"], { env, stdin: "tsk_1" })
    expect(r.exit).toBe(2)
    expect(JSON.parse(r.stderr).error.kind).toBe("usage")
  })

  test("--input @path loads a JSON object", async () => {
    const r = await cli.run(["tasks", "create", "--input", "@payload.json", "--json"], {
      env,
      files: { "/payload.json": JSON.stringify({ title: "From file" }) },
    })
    expect(r.exit).toBe(0)
    expect(JSON.parse(r.stdout).data.title).toBe("From file")
  })

  test("invoke leaves at-literals alone", async () => {
    const r = await cli.invoke(
      "tasks.create",
      { title: "@notes.md" },
      {
        signal: new AbortController().signal,
        auth: { token: "t_test", source: "env", via: "DEMO_TOKEN" },
        confirmed: false,
        actor: "agent",
        note() {},
      },
    )
    expect(r.kind).toBe("data")
    if (r.kind === "data") expect((r.value as { title: string }).title).toBe("@notes.md")
  })

  test("typo suggests the command", async () => {
    const r = await cli.run(["tasks", "lsit"], { env })
    expect(r.exit).toBe(2)
    expect(r.stderr).toContain("list")
  })

  test("get missing is a user error", async () => {
    const r = await cli.run(["tasks", "get", "tsk_000"], { env })
    expect(r.exit).toBe(1)
    expect(r.stdout).toBe("")
    expect(JSON.parse(r.stderr).error.kind).toBe("user")
  })

  test("missing token is auth", async () => {
    const r = await cli.run(["tasks", "list", "--json"])
    expect(r.exit).toBe(3)
    expect(JSON.parse(r.stderr).error.kind).toBe("auth")
  })

  test("whoami shows via", async () => {
    const r = await cli.run(["auth", "whoami", "--json"], { env })
    expect(r.exit).toBe(0)
    const body = JSON.parse(r.stdout).data
    expect(body.source).toBe("env")
    expect(body.via).toBe("DEMO_TOKEN")
    expect(body.actor).toBe("pipe")
  })

  test("help is progressive", async () => {
    const r = await cli.run(["--help"])
    expect(r.exit).toBe(0)
    expect(r.stdout).toContain("tasks")
    expect(r.stdout).toContain("Manage tasks")
    expect(r.stdout).toContain("Stream logs")
    const leaf = await cli.run(["tasks", "list", "--help"])
    expect(leaf.stdout).toContain("--status")
    expect(leaf.stdout).toContain("--limit")
    expect(leaf.stdout).toContain("String values accept @<path>")
    const streamHelp = await cli.run(["logs", "tail", "--help"])
    expect(streamHelp.stdout).not.toContain("String values accept @<path>")
    expect(cli.skill()).toContain("## Large inputs")
    const manifest = JSON.parse((await cli.run(["--help", "--json"])).stdout)
    expect(manifest.valueSyntax.at.file).toBe("@<path>")
    expect(manifest.valueSyntax.at.stdin).toBe("@-")
  })

  test("streams NDJSON", async () => {
    const r = await cli.run(["logs", "tail", "--json"], { env })
    expect(r.exit).toBe(0)
    const lines = r.stdout.trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? "{}").message).toBe("one")
  })

  test("opaque rejects --json", async () => {
    const r = await cli.run(["export", "--json"], { env })
    expect(r.exit).toBe(2)
    expect(r.stdout).toBe("")
  })

  test("opaque writes bytes", async () => {
    const r = await cli.run(["export"], { env })
    expect(r.exit).toBe(0)
    expect(r.stdout).toBe("gzip")
  })

  test("invoke is a values seam", async () => {
    const out = await cli.invoke("tasks.get", { id: "tsk_1" }, { auth: { token: "t", source: "env", via: "DEMO_TOKEN" } })
    expect(out.kind).toBe("data")
    if (out.kind === "data") expect((out.value as { id: string }).id).toBe("tsk_1")
  })
})

const ProbeRow = z.object({
  proto: z.enum(["null", "other"]),
  polluted: z.boolean(),
})

const inspectInput = op({
  name: "inspect",
  summary: "Report input prototype safety",
  input: passthrough<{ title: string }>({
    type: "object",
    properties: { title: { type: "string" } },
  }),
  output: out.single(ProbeRow),
  effects: "read_only",
  auth: "none",
  examples: [{ summary: "Title", input: { title: "ok" } }],
  run(input) {
    const proto = Object.getPrototypeOf(input)
    return {
      proto: proto === null ? ("null" as const) : ("other" as const),
      polluted: Boolean((input as { polluted?: unknown }).polluted),
    }
  },
})

const explode = op({
  name: "explode",
  summary: "Throw",
  input: z.object({}),
  output: out.single(z.object({ ok: z.boolean() })),
  effects: "read_only",
  auth: "none",
  examples: [{ summary: "Throw", input: {} }],
  run() {
    throw new Error("boom")
  },
})

const probe = app({
  name: "probe",
  version: "0.0.1",
  summary: "Review probes",
  operations: [inspectInput, explode],
})

function probeIo(): ProcessIO {
  return {
    argv: [],
    env: {},
    cwd: "/",
    stdin: { isTTY: false, text: async () => "", question: async () => "n" },
    stdout: { isTTY: false, write: async () => {} },
    stderr: { isTTY: false, write: async () => {} },
    onSignal() {},
    readFile: async (path) => {
      throw new Error(`cannot read ${path}`)
    },
    keychain: {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
    },
  }
}

describe("publish review", () => {
  test("--input __proto__ does not pollute the bound object", async () => {
    const payload = '{"title":"ok","__proto__":{"polluted":true}}'
    const r = await probe.run(["inspect", "--input", payload, "--json"], { env: {} })
    expect(r.exit).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ data: { proto: "null", polluted: false } })

    const inv = await parseArgv(probe, ["inspect", "--input", payload], probeIo())
    expect(inv.kind).toBe("run")
    if (inv.kind !== "run") return
    expect(Object.getPrototypeOf(inv.input)).toBe(null)
    expect(Object.keys(inv.input)).toEqual(["title"])
  })

  test("OPCLI_DEBUG=1 includes a stack on handler throws", async () => {
    const r = await probe.run(["explode", "--json"], { env: { OPCLI_DEBUG: "1" } })
    expect(r.exit).toBe(5)
    expect(JSON.parse(r.stderr).error.details.stack).toContain("boom")
  })

  test("without OPCLI_DEBUG, handler throws omit the stack", async () => {
    const r = await probe.run(["explode", "--json"], { env: {} })
    expect(r.exit).toBe(5)
    const error = JSON.parse(r.stderr).error
    expect(error.kind).toBe("internal")
    expect(error.message).toBe("boom")
    expect(error.details).toBeUndefined()
  })
})
