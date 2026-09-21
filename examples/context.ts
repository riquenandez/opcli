import { AsyncLocalStorage } from "node:async_hooks"
import { z } from "zod"
import { app, fail, op, out } from "../src/index.ts"
import { mcpCall, type McpToolResult } from "../src/mcp.ts"

export type UserContext = {
  readonly userId: string
  readonly requestId: string
}

const userContext = new AsyncLocalStorage<UserContext>()

const Note = z.object({
  id: z.string(),
  body: z.string(),
})

const notes: Record<string, z.infer<typeof Note>[]> = {
  usr_ada: [{ id: "n_1", body: "Ada's note" }],
  usr_bob: [{ id: "n_2", body: "Bob's note" }],
}

export function asUser<T>(session: UserContext, run: () => T): T {
  return userContext.run(session, run)
}

function withEnvUser<T>(env: Readonly<Record<string, string | undefined>>, run: () => T): T {
  const userId = env.CONTEXT_USER
  if (!userId) return run()
  return asUser({ userId, requestId: env.CONTEXT_REQUEST ?? "cli" }, run)
}

function outboundHeaders(token: string | undefined): Record<string, string> {
  const session = userContext.getStore()
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (session?.userId) headers["X-User-Id"] = session.userId
  if (session?.requestId) headers["X-Request-Id"] = session.requestId
  return headers
}

function apiListNotes(token: string | undefined, signal: AbortSignal) {
  const headers = outboundHeaders(token)
  if (signal.aborted) throw new Error("aborted")
  const userId = headers["X-User-Id"]
  if (!userId) {
    return fail.user("missing X-User-Id", {
      hint: "wrap with asUser, or set CONTEXT_USER",
    })
  }
  return notes[userId] ?? []
}

const list = op({
  name: "notes.list",
  summary: "List notes for the current user",
  input: z.object({}),
  output: out.unbounded(Note),
  effects: "read_only",
  examples: [{ summary: "Current user", input: {} }],
  run({ limit }, ctx) {
    const items = apiListNotes(ctx.auth?.token, ctx.signal)
    return { items: items.slice(0, limit), nextCursor: items[limit]?.id }
  },
})

export const cli = app({
  name: "context",
  version: "0.1.0",
  summary: "Host-supplied user context headers",
  groups: { notes: "Notes for the session user" },
  auth: { env: "CONTEXT_TOKEN", flag: "token" },
  operations: [list],
})

export function callAsUser(
  session: UserContext,
  tool: string,
  args: unknown = {},
): Promise<McpToolResult> {
  return asUser(session, () =>
    mcpCall(cli, tool, args, {
      signal: new AbortController().signal,
      auth: { token: "t_test", source: "env", via: "CONTEXT_TOKEN" },
      confirmed: false,
      actor: "agent",
      note() {},
    }),
  )
}

export function sandboxRun(argv: readonly string[], io?: Parameters<typeof cli.run>[1]) {
  return withEnvUser(io?.env ?? {}, () => cli.run(argv, io))
}

if (import.meta.main) {
  process.exit(await withEnvUser(process.env, () => cli.main()))
}
