import { app, fail, op, out } from "../src/index.ts"
import { z } from "zod"

const Task = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["open", "done"]),
})

const tasks = [
  { id: "tsk_1", title: "Ship CLI", status: "open" as const },
]

const list = op({
  name: "tasks.list",
  summary: "List tasks",
  input: z.object({ status: Task.shape.status.optional() }),
  output: out.unbounded(Task),
  effects: "read_only",
  examples: [{ summary: "Open", input: { status: "open" } }],
  async run({ status, limit }) {
    const items = tasks.filter((task) => !status || task.status === status)
    return { items: items.slice(0, limit), nextCursor: items[limit]?.id }
  },
})

const get = op({
  name: "tasks.get",
  summary: "Show one task",
  input: z.object({ id: z.string() }),
  args: ["id"],
  output: out.single(Task),
  effects: "read_only",
  examples: [{ summary: "By id", input: { id: "tsk_1" } }],
  run({ id }) {
    const task = tasks.find((item) => item.id === id)
    if (!task) return fail.user(`no such task: ${id}`, { hint: "hi tasks list" })
    return task
  },
})

export const cli = app({
  name: "hi",
  version: "0.1.0",
  summary: "Tiny task CLI",
  operations: [list, get],
})

if (import.meta.main) process.exit(await cli.main())
