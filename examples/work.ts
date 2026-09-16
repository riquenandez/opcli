import { app, fail, op, out } from "../src/index.ts"
import { z } from "zod"

const Task = z.object({
  id: z.string(),
  title: z.string(),
  projectId: z.string(),
  status: z.enum(["open", "done"]),
})

const Opportunity = z.object({
  id: z.string(),
  name: z.string(),
  stage: z.enum(["discover", "propose", "won", "lost"]),
})

const Project = z.object({
  id: z.string(),
  name: z.string(),
  opportunityId: z.string().nullable(),
})

const tasks = [
  { id: "tsk_1", title: "Draft proposal", projectId: "prj_1", status: "open" as const },
  { id: "tsk_2", title: "Kickoff call", projectId: "prj_1", status: "done" as const },
]

const opportunities = [
  { id: "opp_1", name: "Acme rollout", stage: "propose" as const },
  { id: "opp_2", name: "Northwind renewal", stage: "discover" as const },
]

const projects = [
  { id: "prj_1", name: "Acme implementation", opportunityId: "opp_1" },
  { id: "prj_2", name: "Internal tooling", opportunityId: null },
]

const tasksList = op({
  name: "tasks.list",
  summary: "List tasks",
  input: z.object({
    projectId: z.string().optional().describe("Only tasks on this project"),
    status: Task.shape.status.optional(),
  }),
  output: out.unbounded(Task),
  effects: "read_only",
  examples: [{ summary: "Open on a project", input: { projectId: "prj_1", status: "open" } }],
  async run({ projectId, status, limit }) {
    const items = tasks.filter(
      (task) => (!projectId || task.projectId === projectId) && (!status || task.status === status),
    )
    return { items: items.slice(0, limit), nextCursor: items[limit]?.id }
  },
})

const tasksGet = op({
  name: "tasks.get",
  summary: "Show one task",
  input: z.object({ id: z.string() }),
  args: ["id"],
  output: out.single(Task),
  effects: "read_only",
  examples: [{ summary: "By id", input: { id: "tsk_1" } }],
  run({ id }) {
    const task = tasks.find((item) => item.id === id)
    if (!task) return fail.user(`no such task: ${id}`, { hint: "work tasks list" })
    return task
  },
})

const opportunitiesList = op({
  name: "opportunities.list",
  summary: "List opportunities",
  input: z.object({ stage: Opportunity.shape.stage.optional() }),
  output: out.unbounded(Opportunity),
  effects: "read_only",
  examples: [{ summary: "In proposal", input: { stage: "propose" } }],
  async run({ stage, limit }) {
    const items = opportunities.filter((item) => !stage || item.stage === stage)
    return { items: items.slice(0, limit), nextCursor: items[limit]?.id }
  },
})

const opportunitiesGet = op({
  name: "opportunities.get",
  summary: "Show one opportunity",
  input: z.object({ id: z.string() }),
  args: ["id"],
  output: out.single(Opportunity),
  effects: "read_only",
  examples: [{ summary: "By id", input: { id: "opp_1" } }],
  run({ id }) {
    const item = opportunities.find((row) => row.id === id)
    if (!item) return fail.user(`no such opportunity: ${id}`, { hint: "work opportunities list" })
    return item
  },
})

const projectsList = op({
  name: "projects.list",
  summary: "List projects",
  input: z.object({}),
  output: out.unbounded(Project),
  effects: "read_only",
  examples: [{ summary: "All", input: {} }],
  async run({ limit }) {
    return { items: projects.slice(0, limit), nextCursor: projects[limit]?.id }
  },
})

const projectsGet = op({
  name: "projects.get",
  summary: "Show one project",
  input: z.object({ id: z.string() }),
  args: ["id"],
  output: out.single(Project),
  effects: "read_only",
  examples: [{ summary: "By id", input: { id: "prj_1" } }],
  run({ id }) {
    const item = projects.find((row) => row.id === id)
    if (!item) return fail.user(`no such project: ${id}`, { hint: "work projects list" })
    return item
  },
})

export const cli = app({
  name: "work",
  version: "0.1.0",
  summary: "Tasks, opportunities, and projects",
  groups: {
    tasks: "Create, inspect and manage tasks",
    opportunities: "Track deals through the pipeline",
    projects: "Delivery work attached to a deal or internal",
  },
  operations: [tasksList, tasksGet, opportunitiesList, opportunitiesGet, projectsList, projectsGet],
})

if (import.meta.main) process.exit(await cli.main())
