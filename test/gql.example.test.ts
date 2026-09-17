import { describe, expect, test } from "bun:test"
import { cli } from "../examples/gql.ts"

const env = { GQL_TOKEN: "t" }

describe("gql example", () => {
  test("list is JSON with GQL_TOKEN", async () => {
    const r = await cli.run(["tasks", "list", "--json"], { env })
    expect(r.exit).toBe(0)
    expect(r.stderr).toBe("")
    const body = JSON.parse(r.stdout)
    expect(body.data).toContainEqual({
      id: "tsk_1",
      title: "Ship CLI",
      status: "OPEN",
      createdAt: "2026-09-14T18:02:11Z",
    })
    expect(body.meta.nextCursor).toBeNull()
  })

  test("missing token is auth", async () => {
    const r = await cli.run(["tasks", "list", "--json"])
    expect(r.exit).toBe(3)
    expect(JSON.parse(r.stderr).error.kind).toBe("auth")
  })

  test("get by id returns the task", async () => {
    const r = await cli.run(["tasks", "get", "tsk_1", "--json"], { env })
    expect(r.exit).toBe(0)
    expect(JSON.parse(r.stdout).data).toEqual({
      id: "tsk_1",
      title: "Ship CLI",
      status: "OPEN",
      createdAt: "2026-09-14T18:02:11Z",
    })
  })

  test("get missing is a user error", async () => {
    const r = await cli.run(["tasks", "get", "tsk_000"], { env })
    expect(r.exit).toBe(1)
    expect(r.stdout).toBe("")
    expect(JSON.parse(r.stderr).error.kind).toBe("user")
  })

  test("create returns the object", async () => {
    const r = await cli.run(["tasks", "create", "--title", "Hello", "--json"], { env })
    expect(r.exit).toBe(0)
    const task = JSON.parse(r.stdout).data
    expect(task.title).toBe("Hello")
    expect(task.status).toBe("OPEN")
    expect(task.createdAt).toBe("2026-09-15T00:00:00Z")
    expect(task.id).toBeString()
    expect(task).not.toHaveProperty("__typename")
  })

  test("list help includes --status and not --filter or __typename", async () => {
    const r = await cli.run(["tasks", "list", "--help"])
    expect(r.exit).toBe(0)
    expect(r.stdout).toContain("--status")
    expect(r.stdout).not.toContain("--filter")
    expect(r.stdout).not.toContain("__typename")
  })

  test("--fields does not advertise __typename", async () => {
    const r = await cli.run(["tasks", "list", "--fields", "__typename"], { env })
    expect(r.exit).toBe(2)
    expect(r.stderr).toContain("unknown field")
    expect(r.stderr).toContain("id")
    expect(r.stderr).not.toMatch(/fields:.*__typename/)
  })
})
