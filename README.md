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

## Call GraphQL from a handler

`examples/gql.ts` posts GraphQL documents from `run`.

1. Generate Zod from your `.graphql` schema with GraphQL Codegen. Use the `typescript` and `typescript-validation-schema` plugins with `schema: "zodv4"`.
2. Install `@graphql-codegen/cli`, `@graphql-codegen/typescript`, and `graphql-codegen-typescript-validation-schema` outside this package. Then run `bunx graphql-codegen --config examples/gql.codegen.ts`.
3. Commit the generated file so `bun test` and `tsc` do not run codegen. If `tsc` rejects `z.lazy` factories, declare them in dependency order without `z.lazy`. Drop the `Properties<T>` return type on nested factories when `__typename` becomes `unknown`. This schema has no cycle through `Task`.
4. Pass `TaskSchema().omit({ __typename: true })` as the operation output so `--fields` does not list `__typename`.
5. Keep CLI input as flat flags such as `status`, `id`, and `title`. Build the GraphQL variables inside `run`.
6. Map `{ edges, pageInfo }` to `{ items, nextCursor }` with one helper.
7. POST the document and variables. Send `Authorization: Bearer ${ctx.auth?.token}` and pass `ctx.signal`.

Do not add Apollo. Do not add an opcli GraphQL export.

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
| Large bodies via file | String values and `--input` accept `@path` and `@-`. `@@` escapes. Missing files are usage errors. `@-` may appear once. |
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

`run()` defaults to no TTY, so tests see what agents see. `invoke(name, json, runtime)` is the same executor MCP uses.

## MCP

`opcli` does not run an MCP server. You write the host. There is no `--mcp` flag, no stdio server, no HTTP server, and no MCP SDK. v1 ships two functions, not a server.

Import them from `opcli/mcp`. The root package does not export them.

```ts
import { mcpTools, mcpCall } from "opcli/mcp"
```

`mcpTools(app)` maps `app.manifest().operations`. Dots in the operation name become underscores, so `items.list` becomes `items_list`. The tool description is the operation `summary`.

If the operation has `confirm`, the input schema gains optional boolean `yes`. If the output is unbounded data, the input schema gains optional `limit` (integer, minimum 1) and `cursor` (string). Stream, bounded, single, and opaque operations do not get those fields. Opaque operations omit `outputSchema`.

Each tool carries `annotations`. `readOnlyHint` is true when `effects` is `read_only`. `destructiveHint` is true when `confirm` is set. `idempotentHint` is true when `effects` is not `non_idempotent`.

The builtins `manifest` and `skill` appear as tools. `auth.whoami` appears when `spec.auth` is set.

`mcpCall(app, toolName, args, runtime)` maps underscores back to dots and calls `app.invoke`. Tests use that same executor. Arguments are JSON, not argv.

Pass a full `Runtime`: `signal`, `auth`, `confirmed`, `actor`, and `note`. Put credentials on `runtime.auth`. `mcpCall` does not call `resolveCredential`. `@path`, `@-`, and `@@` stay as written. Pass the file contents as a string. Confirm with `runtime.confirmed` or with `yes: true`. There is no TTY prompt.

```ts
const result = await mcpCall(ucho, "tasks_list", { status: "open" }, {
  signal: new AbortController().signal,
  auth: { token: "t_test", source: "env", via: "UCHO_TOKEN" },
  confirmed: false,
  actor: "agent",
  note() {},
})
```

A failure sets `isError` to `true` and puts `failurePayload` on `structuredContent.error`. A data result puts `{ data, meta }` on `structuredContent`. A stream is collected into an array and stopped at `app.pagination.maxLimit`. Opaque output becomes text such as `opaque text/markdown`. The bytes are discarded, so `skill` through `mcpCall` is a stub.

`examples/context.ts` stamps `X-User-Id` on the HTTP helper. The handler only reads `ctx.auth`. An MCP host wraps `mcpCall` with `asUser`. A sandbox agent runs the POSIX CLI. The sandbox sets env. The argv has no user id.

```ts
await callAsUser({ userId: "usr_ada", requestId: "req_1" }, "notes_list")
```

```sh
CONTEXT_TOKEN=t_test CONTEXT_USER=usr_ada bun examples/context.ts notes list --json
```

## Not in v1

TUI, prompts as a product, file-based routing, plugin marketplace, builtin `login`/`logout`, short flags.
