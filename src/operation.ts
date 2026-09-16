import type { Contract, Field, Infer } from "./contract.ts"
import { fieldsOf } from "./contract.ts"
import { fail } from "./fail.ts"

export type Effects = "read_only" | "idempotent" | "non_idempotent"
export type Cardinality = "single" | "bounded" | "unbounded"
export type OutputKind = "data" | "stream" | "opaque"

export type OutputContract<O = unknown> =
  | { readonly kind: "data"; readonly cardinality: "single"; readonly schema: Contract<O> }
  | { readonly kind: "data"; readonly cardinality: "bounded"; readonly schema: Contract<O> }
  | { readonly kind: "data"; readonly cardinality: "unbounded"; readonly schema: Contract<O> }
  | { readonly kind: "stream"; readonly schema: Contract<O> }
  | { readonly kind: "opaque"; readonly mediaType: string }

export const out = {
  single: <C extends Contract>(schema: C) =>
    ({ kind: "data", cardinality: "single", schema }) as const,
  bounded: <C extends Contract>(schema: C) =>
    ({ kind: "data", cardinality: "bounded", schema }) as const,
  unbounded: <C extends Contract>(schema: C) =>
    ({ kind: "data", cardinality: "unbounded", schema }) as const,
  stream: <C extends Contract>(schema: C) => ({ kind: "stream", schema }) as const,
  opaque: (mediaType: string) => ({ kind: "opaque", mediaType }) as const,
} as const

export type Page<O> = {
  readonly items: readonly O[]
  readonly nextCursor?: string | null
  readonly truncated?: true
}

export type PageInput = {
  readonly limit: number
  readonly cursor?: string
}

export type Bytes = Uint8Array | ReadableStream<Uint8Array>

export type Produces<Out extends OutputContract> =
  Out extends { kind: "data"; cardinality: "single"; schema: Contract<infer O> } ? O
  : Out extends { kind: "data"; cardinality: "bounded"; schema: Contract<infer O> } ? readonly O[]
  : Out extends { kind: "data"; cardinality: "unbounded"; schema: Contract<infer O> } ? Page<O>
  : Out extends { kind: "stream"; schema: Contract<infer O> } ? AsyncIterable<O>
  : Out extends { kind: "opaque" } ? Bytes
  : never

export type HandlerInput<I, Out extends OutputContract> =
  Out extends { cardinality: "unbounded" } ? I & PageInput : I

export type AuthNeed = "required" | "optional" | "none"

export type Credential = {
  readonly token: string
  readonly source: "flag" | "env" | "config" | "keychain"
  readonly via: string
}

export type Actor = "human" | "agent" | "ci" | "pipe"

export type Ctx = {
  readonly signal: AbortSignal
  readonly auth: Credential | null
  readonly actor: Actor
  note(message: string): void
}

export const RESERVED_FLAGS = [
  "json",
  "human",
  "fields",
  "limit",
  "cursor",
  "yes",
  "input",
  "help",
  "version",
] as const

export type ReservedFlag = (typeof RESERVED_FLAGS)[number]

export type NoReserved<I> = Extract<keyof I, ReservedFlag> extends never
  ? unknown
  : { readonly "input field collides with reserved flag": Extract<keyof I, ReservedFlag> }

export type Example<I> = {
  readonly summary: string
  readonly input: I
}

export type OpName = string

export type OperationSpec<In extends Contract, Out extends OutputContract> = {
  readonly name: OpName
  readonly summary: string
  readonly description?: string
  readonly input: In & NoReserved<Infer<In>>
  readonly args?: readonly (keyof Infer<In> & string)[]
  readonly output: Out
  readonly effects: Effects
  readonly confirm?: string | ((input: Infer<In>) => string)
  readonly auth?: AuthNeed
  readonly examples: readonly [Example<Infer<In>>, ...Example<Infer<In>>[]]
  run(input: HandlerInput<Infer<In>, Out>, ctx: Ctx): Produces<Out> | Promise<Produces<Out>>
}

export type Operation<
  In extends Contract = Contract,
  Out extends OutputContract = OutputContract,
> = Omit<OperationSpec<In, Out>, "input"> & {
  readonly input: In
  readonly path: readonly string[]
  readonly inputFields: readonly Field[]
  readonly outputFields: readonly Field[]
}

export type AnyOperation = {
  readonly name: OpName
  readonly summary: string
  readonly description?: string
  readonly input: Contract
  readonly args?: readonly string[]
  readonly output: OutputContract
  readonly effects: Effects
  readonly confirm?: string | ((input: never) => string)
  readonly auth?: AuthNeed
  readonly examples: readonly Example<unknown>[]
  readonly path: readonly string[]
  readonly inputFields: readonly Field[]
  readonly outputFields: readonly Field[]
  run(input: never, ctx: Ctx): unknown
}

const NAME = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/

export function op<In extends Contract, Out extends OutputContract>(
  spec: OperationSpec<In, Out>,
): Operation<In, Out> {
  if (!NAME.test(spec.name)) {
    fail.usage(`invalid operation name "${spec.name}"`, {
      hint: "use dotted lowercase kebab segments, e.g. tasks.list",
    })
  }
  const inputFields = fieldsOf(spec.input, "input")
  const outputFields =
    spec.output.kind === "opaque" ? [] : fieldsOf(spec.output.schema, "output")
  const reserved = new Set<string>(RESERVED_FLAGS)
  for (const field of inputFields) {
    if (reserved.has(field.name)) {
      fail.usage(`input field "${field.name}" collides with a reserved flag`, {
        hint: "rename the field",
      })
    }
  }
  const names = new Set(inputFields.map((field) => field.name))
  for (const arg of spec.args ?? []) {
    if (!names.has(arg)) {
      fail.usage(`positional "${arg}" is not an input field of ${spec.name}`, {
        hint: "args must name keys of the input schema",
      })
    }
  }
  if (spec.output.kind === "data" && spec.output.cardinality === "unbounded") {
    if (names.has("limit") || names.has("cursor")) {
      fail.usage(`${spec.name} must not declare limit/cursor`, {
        hint: "pagination flags are injected for unbounded operations",
      })
    }
  }
  return {
    ...spec,
    input: spec.input,
    path: spec.name.split("."),
    inputFields,
    outputFields,
  }
}

export function outputCardinality(output: OutputContract): Cardinality | undefined {
  return output.kind === "data" ? output.cardinality : undefined
}
