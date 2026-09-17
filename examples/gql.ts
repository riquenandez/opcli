import { z } from "zod"
import { app, fail, op, out, type Ctx } from "../src/index.ts"
import {
  TaskConnectionSchema,
  TaskFilterSchema,
  TaskSchema,
  TaskStatus,
  TaskStatusSchema,
  type Task,
} from "./gql.generated.ts"

const TaskOut = TaskSchema().omit({ __typename: true })

const TASKS = `query Tasks($filter: TaskFilter, $first: Int!, $after: String) {
  tasks(filter: $filter, first: $first, after: $after) {
    edges { cursor node { id title status createdAt } }
    pageInfo { hasNextPage endCursor }
  }
}`

const TASK = `query Task($id: ID!) {
  task(id: $id) { id title status createdAt }
}`

const CREATE = `mutation CreateTask($title: String!, $body: String) {
  createTask(title: $title, body: $body) { id title status createdAt }
}`

const store: Task[] = [
  {
    __typename: "Task",
    id: "tsk_1",
    title: "Ship CLI",
    status: TaskStatus.Open,
    createdAt: "2026-09-14T18:02:11Z",
  },
]

let created = 1

function fromConnection(connection: {
  edges: Array<{ node: unknown }>
  pageInfo: { hasNextPage: boolean; endCursor?: unknown }
}) {
  const end = connection.pageInfo.endCursor
  return {
    items: connection.edges.map((edge) => TaskOut.parse(edge.node)),
    nextCursor: connection.pageInfo.hasNextPage && typeof end === "string" ? end : undefined,
  }
}

const TasksVariables = z.object({
  first: z.number().int(),
  after: z.string().optional(),
  filter: TaskFilterSchema().optional(),
})

const TaskVariables = z.object({ id: z.string() })
const CreateVariables = z.object({ title: z.string(), body: z.string().nullish() })

function execute(query: string, variables: Record<string, unknown>): unknown {
  if (query === TASKS) {
    const { first, after, filter } = TasksVariables.parse(variables)
    const rows = store.filter((task) => !filter?.status || task.status === filter.status)
    const start = after ? rows.findIndex((task) => task.id === after) + 1 : 0
    const page = rows.slice(Math.max(start, 0), Math.max(start, 0) + first)
    const next = rows[Math.max(start, 0) + first]
    return {
      tasks: {
        edges: page.map((node) => ({ cursor: node.id, node })),
        pageInfo: { hasNextPage: Boolean(next), endCursor: page.at(-1)?.id ?? null },
      },
    }
  }
  if (query === TASK) {
    const { id } = TaskVariables.parse(variables)
    return { task: store.find((task) => task.id === id) ?? null }
  }
  if (query === CREATE) {
    const { title } = CreateVariables.parse(variables)
    created += 1
    const task: Task = {
      __typename: "Task",
      id: `tsk_${created}`,
      title,
      status: TaskStatus.Open,
      createdAt: "2026-09-15T00:00:00Z",
    }
    store.push(task)
    return { createTask: task }
  }
  throw new Error("unknown GraphQL document")
}

async function gql(query: string, variables: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  const request = {
    method: "POST",
    headers: { Authorization: `Bearer ${ctx.auth?.token}` },
    body: { query, variables },
    signal: ctx.signal,
  }
  if (request.signal.aborted) throw new Error("aborted")
  return execute(request.body.query, request.body.variables)
}

const list = op({
  name: "tasks.list",
  summary: "List tasks",
  input: z.object({ status: TaskStatusSchema.optional() }),
  output: out.unbounded(TaskOut),
  effects: "read_only",
  examples: [{ summary: "Open", input: { status: TaskStatus.Open } }],
  async run({ status, limit, cursor }, ctx) {
    const data = z.object({ tasks: TaskConnectionSchema() }).parse(
      await gql(TASKS, { filter: status ? { status } : undefined, first: limit, after: cursor }, ctx),
    )
    return fromConnection(data.tasks)
  },
})

const get = op({
  name: "tasks.get",
  summary: "Show one task",
  input: z.object({ id: z.string() }),
  args: ["id"],
  output: out.single(TaskOut),
  effects: "read_only",
  examples: [{ summary: "By id", input: { id: "tsk_1" } }],
  async run({ id }, ctx) {
    const data = z.object({ task: TaskSchema().nullable() }).parse(await gql(TASK, { id }, ctx))
    if (!data.task) return fail.user(`no such task: ${id}`, { hint: "gql tasks list" })
    return TaskOut.parse(data.task)
  },
})

const create = op({
  name: "tasks.create",
  summary: "Create a task",
  input: z.object({ title: z.string().min(1) }),
  output: out.single(TaskOut),
  effects: "non_idempotent",
  examples: [{ summary: "Title only", input: { title: "Hello" } }],
  async run({ title }, ctx) {
    const data = z.object({ createTask: TaskSchema() }).parse(await gql(CREATE, { title }, ctx))
    return TaskOut.parse(data.createTask)
  },
})

export const cli = app({
  name: "gql",
  version: "0.1.0",
  summary: "GraphQL task CLI",
  groups: { tasks: "GraphQL task list" },
  auth: { env: "GQL_TOKEN", flag: "token" },
  operations: [list, get, create],
})

if (import.meta.main) process.exit(await cli.main())
