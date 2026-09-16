import { z } from "zod"
import { fail, op, out } from "../src/index.ts"

const Task = z.object({
  id: z.string(),
  title: z.string(),
})

export const goodList = op({
  name: "tasks.list",
  summary: "List",
  input: z.object({ status: z.string().optional() }),
  output: out.unbounded(Task),
  effects: "read_only",
  examples: [{ summary: "all", input: {} }],
  async run({ limit }) {
    return { items: [{ id: "1", title: "t" }], nextCursor: limit > 0 ? undefined : undefined }
  },
})

export const goodGet = op({
  name: "tasks.get",
  summary: "Get",
  input: z.object({ id: z.string() }),
  args: ["id"],
  output: out.single(Task),
  effects: "read_only",
  examples: [{ summary: "one", input: { id: "1" } }],
  run({ id }) {
    return { id, title: "t" }
  },
})

export const badUnbounded = op({
  name: "tasks.badlist",
  summary: "Bad",
  input: z.object({}),
  output: out.unbounded(Task),
  effects: "read_only",
  examples: [{ summary: "x", input: {} }],
  // @ts-expect-error unbounded handler must return a page, not an array
  async run() {
    return [{ id: "1", title: "t" }]
  },
})

export const reservedJson = op({
  name: "tasks.reserved",
  summary: "Bad flag",
  // @ts-expect-error json is a reserved flag
  input: z.object({ json: z.boolean() }),
  output: out.single(Task),
  effects: "read_only",
  examples: [{ summary: "x", input: { json: true } }],
  run() {
    return { id: "1", title: "t" }
  },
})

export const badArgs = op({
  name: "tasks.badargs",
  summary: "Bad args",
  input: z.object({ id: z.string() }),
  // @ts-expect-error positional must be an input field
  args: ["nope"],
  output: out.single(Task),
  effects: "read_only",
  examples: [{ summary: "x", input: { id: "1" } }],
  run({ id }) {
    return { id, title: "t" }
  },
})

export const emptyExamples = op({
  name: "tasks.empty",
  summary: "Empty examples",
  input: z.object({}),
  output: out.single(Task),
  effects: "read_only",
  // @ts-expect-error examples must be non-empty
  examples: [],
  run() {
    return { id: "1", title: "t" }
  },
})

export const noLimitOnBounded = op({
  name: "tasks.bounded",
  summary: "Bounded",
  input: z.object({}),
  output: out.bounded(Task),
  effects: "read_only",
  examples: [{ summary: "x", input: {} }],
  async run() {
    return [{ id: "1", title: "t" }]
  },
})

void fail
