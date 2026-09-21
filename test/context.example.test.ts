import { describe, expect, test } from "bun:test"
import { asUser, callAsUser, cli, sandboxRun } from "../examples/context.ts"

const env = { CONTEXT_TOKEN: "t_test" }
const ada = { userId: "usr_ada", requestId: "req_1" }
const bob = { userId: "usr_bob", requestId: "req_2" }
const sandboxAda = { ...env, CONTEXT_USER: "usr_ada", CONTEXT_REQUEST: "req_1" }
const sandboxBob = { ...env, CONTEXT_USER: "usr_bob", CONTEXT_REQUEST: "req_2" }

describe("context example", () => {
  test("MCP host headers select Ada's notes", async () => {
    const r = await callAsUser(ada, "notes_list")
    expect(r.isError).toBe(false)
    if (r.isError) return
    expect(r.structuredContent).toEqual({
      data: [{ id: "n_1", body: "Ada's note" }],
      meta: { nextCursor: null },
    })
  })

  test("a different session user sees different notes", async () => {
    const r = await asUser(bob, () => cli.run(["notes", "list", "--json"], { env }))
    expect(r.exit).toBe(0)
    expect(JSON.parse(r.stdout).data).toEqual([{ id: "n_2", body: "Bob's note" }])
  })

  test("sandbox CLI env selects Ada's notes", async () => {
    const r = await sandboxRun(["notes", "list", "--json"], { env: sandboxAda })
    expect(r.exit).toBe(0)
    expect(JSON.parse(r.stdout).data).toEqual([{ id: "n_1", body: "Ada's note" }])
  })

  test("sandbox CLI env selects Bob's notes", async () => {
    const r = await sandboxRun(["notes", "list", "--json"], { env: sandboxBob })
    expect(r.exit).toBe(0)
    expect(JSON.parse(r.stdout).data).toEqual([{ id: "n_2", body: "Bob's note" }])
  })

  test("sandbox process argv has no user id", async () => {
    const proc = Bun.spawn(["bun", "examples/context.ts", "notes", "list", "--json"], {
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, CONTEXT_TOKEN: "t_test", CONTEXT_USER: "usr_ada" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)
    expect(JSON.parse(stdout).data).toEqual([{ id: "n_1", body: "Ada's note" }])
  })

  test("invoke without asUser is a user error", async () => {
    const r = await cli.run(["notes", "list", "--json"], { env })
    expect(r.exit).toBe(1)
    expect(JSON.parse(r.stderr).error.kind).toBe("user")
    expect(JSON.parse(r.stderr).error.message).toBe("missing X-User-Id")
  })

  test("missing token is still auth", async () => {
    const r = await asUser(ada, () => cli.run(["notes", "list", "--json"]))
    expect(r.exit).toBe(3)
    expect(JSON.parse(r.stderr).error.kind).toBe("auth")
  })
})
