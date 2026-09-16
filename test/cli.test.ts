import { describe, expect, test } from "bun:test"
import { z } from "zod"
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
      url: "https://ucho.dev/t/tsk_1",
      createdAt: "2026-09-14T18:02:11Z",
    },
    {
      id: "tsk_2",
      title: "Write docs",
      status: "open" as const,
      url: "https://ucho.dev/t/tsk_2",
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
      url: "https://ucho.dev/t/tsk_new",
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
  name: "ucho",
  version: "1.4.0",
  summary: "Task tracker",
  groups: { tasks: "Manage tasks" },
  auth: { env: "UCHO_TOKEN", flag: "token" },
  operations: [tasksList, tasksGet, tasksCreate, tasksDelete, logsTail, dump],
})

const env = { UCHO_TOKEN: "t_test" }

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
    expect(body.via).toBe("UCHO_TOKEN")
    expect(body.actor).toBe("pipe")
  })

  test("help is progressive", async () => {
    const r = await cli.run(["--help"])
    expect(r.exit).toBe(0)
    expect(r.stdout).toContain("tasks")
    const leaf = await cli.run(["tasks", "list", "--help"])
    expect(leaf.stdout).toContain("--status")
    expect(leaf.stdout).toContain("--limit")
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
    const out = await cli.invoke("tasks.get", { id: "tsk_1" }, { auth: { token: "t", source: "env", via: "UCHO_TOKEN" } })
    expect(out.kind).toBe("data")
    if (out.kind === "data") expect((out.value as { id: string }).id).toBe("tsk_1")
  })
})
