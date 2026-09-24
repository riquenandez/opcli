import { describe, test } from "node:test"
import { expect } from "./expect.ts"
import { z } from "zod"
import { app, op, out } from "../src/index.ts"
import { isFail } from "../src/fail.ts"
import { buildTree, find, type TreeProblem } from "../src/tree.ts"

function leaf(name: string) {
  return op({
    name,
    summary: name,
    input: z.object({}),
    output: out.single(z.object({ ok: z.boolean() })),
    effects: "read_only",
    examples: [{ summary: name, input: {} }],
    run: () => ({ ok: true }),
  })
}

function spec(groups: Record<string, string> | undefined, names: string[]) {
  return {
    spec: { name: "x", summary: "x", groups },
    operations: names.map(leaf),
  }
}

function problemsOf(run: () => unknown): { message: string; hint?: string; problems: TreeProblem[] } {
  try {
    run()
  } catch (error) {
    if (!isFail(error)) throw error
    return {
      message: error.message,
      hint: error.hint,
      problems: (error.details as { problems: TreeProblem[] }).problems,
    }
  }
  throw new Error("expected usage failure")
}

describe("tree uniqueness and groups", () => {
  test("prefix collision is operation-is-group", () => {
    const { problems } = problemsOf(() =>
      app({
        name: "x",
        version: "1",
        summary: "x",
        groups: { projects: "Projects" },
        operations: [leaf("projects"), leaf("projects.list")],
      }),
    )
    expect(problems).toContainEqual({
      kind: "operation-is-group",
      name: "projects",
      path: "projects",
    })
  })

  test("group summaries key by full path, not last segment", () => {
    const tree = buildTree(
      spec(
        {
          projects: "Projects",
          "projects.comments": "Project comments",
          tasks: "Tasks",
          "tasks.comments": "Task comments",
        },
        ["projects.comments.list", "tasks.comments.list"],
      ),
    )
    const projects = tree.children.get("projects")
    const tasks = tree.children.get("tasks")
    expect(projects?.kind).toBe("group")
    expect(tasks?.kind).toBe("group")
    if (projects?.kind !== "group" || tasks?.kind !== "group") return
    expect(projects.summary).toBe("Projects")
    expect(tasks.summary).toBe("Tasks")
    const projectComments = projects.children.get("comments")
    const taskComments = tasks.children.get("comments")
    expect(projectComments?.kind).toBe("group")
    expect(taskComments?.kind).toBe("group")
    if (projectComments?.kind === "group") expect(projectComments.summary).toBe("Project comments")
    if (taskComments?.kind === "group") expect(taskComments.summary).toBe("Task comments")
  })

  test("missing group summaries fail with an aggregated hint", () => {
    const { problems, hint } = problemsOf(() => buildTree(spec(undefined, ["projects.list", "tasks.list"])))
    expect(problems).toEqual([
      { kind: "missing-group-summary", path: "projects" },
      { kind: "missing-group-summary", path: "tasks" },
    ])
    expect(hint).toBe('add groups: { "projects": "...", "tasks": "..." }')
  })

  test("empty group summary fails", () => {
    const { problems } = problemsOf(() => buildTree(spec({ tasks: "" }, ["tasks.list"])))
    expect(problems).toEqual([{ kind: "empty-group-summary", path: "tasks" }])
  })

  test("unused last-segment key suggests the full path", () => {
    const { problems } = problemsOf(() =>
      buildTree(spec({ projects: "Projects", comments: "Nope" }, ["projects.comments.list"])),
    )
    expect(problems).toContainEqual({
      kind: "unused-group-key",
      key: "comments",
      didYouMean: "projects.comments",
    })
    expect(problems).toContainEqual({ kind: "missing-group-summary", path: "projects.comments" })
  })

  test("unused key that names an operation is distinct", () => {
    const { problems, message } = problemsOf(() =>
      buildTree(spec({ tasks: "Tasks", "tasks.list": "not a group" }, ["tasks.list"])),
    )
    expect(problems).toEqual([{ kind: "unused-group-key", key: "tasks.list", namesOperation: true }])
    expect(message).toContain("names an operation")
  })

  test("duplicate operation names fail", () => {
    const { problems } = problemsOf(() => buildTree(spec({ tasks: "Tasks" }, ["tasks.list", "tasks.list"])))
    expect(problems).toEqual([{ kind: "duplicate-operation", name: "tasks.list" }])
  })

  test("root-level ops do not require groups", () => {
    const tree = buildTree(spec(undefined, ["ping"]))
    expect(tree.children.get("ping")?.kind).toBe("op")
  })

  test("find walks Map children and suggests siblings", () => {
    const tree = buildTree(spec({ tasks: "Tasks" }, ["tasks.list", "tasks.get"]))
    const hit = find(tree, ["tasks", "list"])
    expect(hit.kind).toBe("op")
    const miss = find(tree, ["tasks", "lst"])
    expect(miss.kind).toBe("miss")
    if (miss.kind !== "miss") return
    expect(miss.suggestions).toEqual(["list"])
  })

  test("help lists every group caption", async () => {
    const cli = app({
      name: "work",
      version: "1",
      summary: "Work",
      groups: {
        tasks: "Create, inspect and manage tasks",
        opportunities: "Track deals through the pipeline",
        projects: "Delivery work attached to a deal or internal",
      },
      operations: [leaf("tasks.list"), leaf("opportunities.list"), leaf("projects.list")],
    })
    const r = await cli.run(["--help"])
    expect(r.exit).toBe(0)
    expect(r.stdout).toContain("Create, inspect and manage tasks")
    expect(r.stdout).toContain("Track deals through the pipeline")
    expect(r.stdout).toContain("Delivery work attached to a deal or internal")
  })
})
