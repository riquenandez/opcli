# opcli

A Bun + TypeScript library for CLIs that **agents** call thousands of times and humans call occasionally.

You define **operations**. An operation is a typed contract: your schema, an output kind, effects, examples, and a handler that returns data (or throws `fail.*`). argv parsing, `--help`, JSON, tables, exit codes, and the agent skill file are all renderers of that one contract.

Handlers never print, never prompt, and never call `process.exit`.

```sh
bun add opcli zod
```

Zod 4 (or any library that implements [Standard Schema](https://standardschema.dev/) **and** Standard JSON Schema) is the validation boundary. `opcli` does not invent a second schema vocabulary.

## Define an app

```ts
import { app, fail, op, out } from "opcli"
import { z } from "zod"

const Task = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["open", "done"]),
  url: z.string().url(),
  createdAt: z.string().datetime(),
})

const tasksList = op({
  name: "tasks.list",
  summary: "List tasks, newest first",
  input: z.object({
    status: Task.shape.status.optional().describe("Only tasks in this status"),
  }),
  output: out.unbounded(Task),
  effects: "read_only",
  examples: [{ summary: "Open tasks", input: { status: "open" } }],
  async run(input, ctx) {
    const page = await api.tasks.list(input, { signal: ctx.signal, token: ctx.auth?.token })
    return { items: page.tasks, nextCursor: page.next ?? undefined }
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
    const task = api.tasks.get(id)
    if (!task) return fail.user(`task ${id} not found`, { hint: "run `ucho tasks list`" })
    return task
  },
})

const tasksDelete = op({
  name: "tasks.delete",
  summary: "Delete a task permanently",
  input: z.object({ id: z.string() }),
  args: ["id"],
  output: out.single(Task.pick({ id: true, status: true })),
  effects: "idempotent",
  confirm: (input) => `Delete ${input.id}? This cannot be undone.`,
  examples: [{ summary: "Delete", input: { id: "tsk_1" } }],
  run({ id }) {
    return api.tasks.delete(id)
  },
})

export const ucho = app({
  name: "ucho",
  version: "1.4.0",
  summary: "Task tracker",
  groups: { tasks: "Create, inspect and manage tasks" },
  auth: { env: "UCHO_TOKEN", flag: "token" },
  operations: [tasksList, tasksGet, tasksDelete],
})

if (import.meta.main) process.exit(await ucho.main())
```

`"tasks.list"` becomes `ucho tasks list`. There is no `resource()` helper. CRUD is N operations that share a prefix, which is enough for grouped help.

`groups` keys are those prefixes in full (`tasks`, or `projects.comments` when nested). Every implied prefix must have a caption; leftover keys fail. An operation and a group cannot share a path (`projects` next to `projects.list`).

## What the process does

```
$ ucho tasks list --status open --limit 2 --json
{"data":[{"id":"tsk_1","title":"Ship CLI","status":"open",...}],"meta":{"nextCursor":"tsk_2"}}

$ ucho tasks list --fields id,titel
error[usage]: unknown field "titel". Did you mean "title"?
$ echo $?
2

$ ucho tasks delete tsk_1
error[usage]: "tasks delete" is destructive and requires --yes when no person is at the terminal
$ echo $?
2
```

`--json` forces JSON. Agent/CI/non-TTY execution selects JSON by default. A human TTY gets a table derived from the output schema.

Errors never touch stdout. Exit codes: `0` ok, `1` user, `2` usage, `3` auth, `4` network, `5` internal.

## Rules you no longer remember

| Policy | Where it lives |
| --- | --- |
| stdout is data only | The renderer is the only stdout writer. `console.*` is diverted to stderr during the handler. |
| Lists say whether there is more | `out.unbounded` injects `--limit`/`--cursor` and requires `{ items, nextCursor }`. |
| Field projection fails on unknown fields | `--fields` is checked against the output schema **before** the handler runs. |
| Never block when not a human | `confirm` prompts only with a `HumanTty`. Otherwise `--yes` or exit 2. `@-` plus confirm is non-interactive. |
| Mutations return the object | There is no `out.message()`. |
| Large bodies via file | String flags accept `@path` and `@-`. `@@` escapes. |
| Help / skill cannot drift | Both are projections of the operation list. `ucho skill`, `ucho --help --json`. |
| Same flag, same meaning | `app()` throws if two operations share a flag name with different schemas. |
| Auth is inspectable | `ucho auth whoami` shows `source` and `via`. Precedence: flag > env > config > keychain-read. |

## Tests

```ts
const r = await ucho.run(["tasks", "list", "--status", "open", "--limit", "1"], {
  env: { UCHO_TOKEN: "t_test" },
})
expect(r.exit).toBe(0)
```

`run()` defaults to no TTY, so tests see what agents see. `invoke(name, json, runtime)` is the same executor MCP will use.

## MCP

v1 ships the seam, not a server:

```ts
import { mcpTools, mcpCall } from "opcli/mcp"
```

Tool input is JSON, not a round-trip through argv.

## Not in v1

TUI, prompts as a product, file-based routing, plugin marketplace, builtin `login`/`logout`, short flags.
