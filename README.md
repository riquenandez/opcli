# opcli

opcli builds a CLI from typed operations. An agent run prints JSON. A human at a TTY gets a table.

You define each operation with a schema, an output kind, effects, examples, and a handler. The handler returns data or throws `fail.*`. The library turns that operation into argv parsing, `--help`, JSON, tables, exit codes, and the skill file.

Handlers never print, never prompt, and never call `process.exit`.

Install with Bun.

```sh
bun add opcli zod
```

Or install with npm on Node 20 or later.

```sh
npm install opcli zod
```

The published package loads `dist/index.js` and `dist/mcp.js`. In this repository, `npm run build` and `bun run build` both run `tsc`. `bun test` runs the TypeScript in `src`.

Validate with Zod 4, or with any library that implements [Standard Schema](https://standardschema.dev/) and Standard JSON Schema. opcli does not define its own schema types.

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
    if (!task) return fail.user(`task ${id} not found`, { hint: "run `demo tasks list`" })
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

export const demo = app({
  name: "demo",
  version: "1.4.0",
  summary: "Task tracker",
  groups: { tasks: "Create, inspect and manage tasks" },
  auth: { env: "DEMO_TOKEN", flag: "token" },
  operations: [tasksList, tasksGet, tasksDelete],
})

if (import.meta.main) process.exit(await demo.main())
```

On Bun, `import.meta.main` is true when this file is the program. Node added that property in 22.18 and in 24.2. On Node 20 the property is absent, so call `demo.main()` from your own entry check.

The name `tasks.list` runs as `demo tasks list`. There is no `resource()` helper. Write one operation per action. Operations that share a prefix appear together in help.

`groups` keys are those prefixes in full, such as `tasks`, or `projects.comments` when the prefix is nested. Every implied prefix needs a caption. Leftover keys fail. An operation and a group cannot share a path. `projects` cannot sit next to `projects.list`.

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
$ demo tasks list --status open --limit 2 --json
{"data":[{"id":"tsk_1","title":"Ship CLI","status":"open",...}],"meta":{"nextCursor":"tsk_2"}}

$ demo tasks list --fields id,titel
error[usage]: unknown field "titel". Did you mean "title"?
$ echo $?
2

$ demo tasks delete tsk_1
error[usage]: "tasks delete" is destructive and requires --yes when no person is at the terminal
$ echo $?
2
```

`--json` forces JSON. An agent, a CI job, or any run that is not a TTY also prints JSON. A human at a TTY gets a table from the output schema.

Errors never touch stdout. Exit codes: `0` ok, `1` user, `2` usage, `3` auth, `4` network, `5` internal.

## Rules

| Policy | Where it lives |
| --- | --- |
| stdout is data only | The renderer is the only stdout writer. `console.*` is diverted to stderr during the handler. |
| A list reports whether more rows exist | `out.unbounded` adds `--limit` and `--cursor`, and requires `{ items, nextCursor }`. |
| Unknown `--fields` fail | The library checks `--fields` against the output schema before the handler runs. |
| Do not prompt unless a human is at the TTY | `confirm` prompts only with a `HumanTty`. Otherwise the command requires `--yes` or exits 2. `@-` plus confirm does not prompt. |
| Mutations return the object | There is no `out.message()`. |
| Large bodies via file | String values and `--input` accept `@path` and `@-`. `@@` escapes. Missing files are usage errors. `@-` may appear once. |
| Help and the skill file match the operations | The library generates both from the operation list. Run `demo skill` or `demo --help --json`. |
| Same flag, same meaning | `app()` throws if two operations share a flag name with different schemas. |
| Auth shows where the token came from | `demo auth whoami` prints `source` and `via`. The order is flag, then env, then config, then a keychain read. |

## Tests

```ts
const r = await demo.run(["tasks", "list", "--status", "open", "--limit", "1"], {
  env: { DEMO_TOKEN: "t_test" },
})
expect(r.exit).toBe(0)
```

`run()` defaults to no TTY, so the test result is JSON. `invoke(name, json, runtime)` is the executor `mcpCall` uses.

## MCP

opcli does not run an MCP server. You write the host. There is no `--mcp` flag, no stdio server, no HTTP server, and no MCP SDK. v1 exports `mcpTools` and `mcpCall`.

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
const result = await mcpCall(demo, "tasks_list", { status: "open" }, {
  signal: new AbortController().signal,
  auth: { token: "t_test", source: "env", via: "DEMO_TOKEN" },
  confirmed: false,
  actor: "agent",
  note() {},
})
```

A failure sets `isError` to `true` and puts `failurePayload` on `structuredContent.error`. A data result puts `{ data, meta }` on `structuredContent`. `mcpCall` collects a stream into an array and stops at `app.pagination.maxLimit`. Opaque output becomes text, for example `opaque text/markdown`. `mcpCall` discards the bytes. `skill` via `mcpCall` returns that text stub.

`examples/context.ts` sets `X-User-Id` on the HTTP helper. The handler reads `ctx.auth` only. An MCP host wraps `mcpCall` with `asUser`. A sandbox agent runs the CLI. The sandbox sets the env. The argv does not include a user id.

```ts
await callAsUser({ userId: "usr_ada", requestId: "req_1" }, "notes_list")
```

```sh
CONTEXT_TOKEN=t_test CONTEXT_USER=usr_ada bun examples/context.ts notes list --json
```

## Not in v1

TUI, prompts as a product, file-based routing, plugin marketplace, builtin `login`/`logout`, short flags.
