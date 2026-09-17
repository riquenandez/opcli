import { camel, kebab } from "./case.ts"
import { passthrough, schemaFingerprint, validate } from "./contract.ts"
import type { Field } from "./contract.ts"
import { skillMarkdown, manifest as buildManifest } from "./docs.ts"
import type { Manifest } from "./docs.ts"
import { fail, internalFail, isFail } from "./fail.ts"
import { Whoami, tokenPrefix, type AuthSpec } from "./auth.ts"
import {
  op,
  out,
  type Actor,
  type AnyOperation,
  type AuthNeed,
  type Credential,
  type Ctx,
  type Page,
} from "./operation.ts"
import { suggest } from "./suggest.ts"
import {
  buildTree,
  builtinGroupSummaries,
  find as findInTree,
  type CommandTree,
  type Found,
  type TreeNode,
} from "./tree.ts"

export type { Found, TreeNode }

export type { AuthSpec }

export type AppSpec = {
  readonly name: string
  readonly version: string
  readonly summary: string
  readonly operations: readonly AnyOperation[]
  /** Full dotted prefixes implied by operation names. Exhaustive both ways. */
  readonly groups?: Readonly<Record<string, string>>
  readonly auth?: AuthSpec
  readonly pagination?: { readonly defaultLimit: number; readonly maxLimit: number }
  readonly agentEnv?: readonly string[]
}

export type Runtime = {
  readonly signal: AbortSignal
  readonly auth: Credential | null
  readonly confirmed: boolean
  readonly actor: Actor
  note(message: string): void
}

export type PageMeta = {
  readonly nextCursor: string | null
  readonly truncated?: true
}

export type Outcome =
  | { readonly kind: "data"; readonly cardinality: "single" | "bounded" | "unbounded"; readonly value: unknown; readonly meta?: PageMeta }
  | { readonly kind: "stream"; readonly items: AsyncIterable<unknown> }
  | { readonly kind: "opaque"; readonly mediaType: string; readonly bytes: Uint8Array | ReadableStream<Uint8Array> }
  | { readonly kind: "failure"; readonly failure: import("./fail.ts").Failure }

export type InvokeOptions = {
  readonly fields?: readonly string[]
  readonly debugStacks?: boolean
}

export type App = {
  readonly spec: AppSpec
  readonly pagination: { readonly defaultLimit: number; readonly maxLimit: number }
  invoke(name: string, input: unknown, runtime: Partial<Runtime>, opts?: InvokeOptions): Promise<Outcome>
  invoke(op: AnyOperation, input: unknown, runtime: Runtime, opts?: InvokeOptions): Promise<Outcome>
  find(tokens: readonly string[]): Found
  main(io?: import("./cli.ts").ProcessIO): Promise<import("./fail.ts").ExitCode>
  run(argv: readonly string[], io?: import("./cli.ts").TestIO): Promise<import("./cli.ts").RunResult>
  manifest(scope?: readonly string[]): Manifest
  skill(): string
}

function checkFlagConsistency(operations: readonly AnyOperation[]): void {
  const seen = new Map<string, { fingerprint: string; op: string }>()
  for (const operation of operations) {
    for (const field of operation.inputFields) {
      const fingerprint = schemaFingerprint(operation.input, field.name)
      const prior = seen.get(field.name)
      if (prior && prior.fingerprint !== fingerprint) {
        fail.usage(`flag --${kebab(field.name)} means different things on ${prior.op} and ${operation.name}`, {
          hint: "the same flag name must share the same type, enum, and format",
        })
      }
      if (!prior) seen.set(field.name, { fingerprint, op: operation.name })
    }
  }
}

export function ownRecord(value: unknown): Record<string, unknown> {
  const out = Object.create(null) as Record<string, unknown>
  if (!value || typeof value !== "object" || Array.isArray(value)) return out
  for (const key of Object.keys(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue
    out[key] = (value as Record<string, unknown>)[key]
  }
  return out
}

function projectValue(value: unknown, fields: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => projectValue(item, fields))
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    const next: Record<string, unknown> = {}
    for (const field of fields) {
      if (field.includes(".")) {
        const [head, ...rest] = field.split(".")
        if (head && head in record) next[head] = projectValue(record[head], [rest.join(".")])
      } else if (field in record) {
        next[field] = record[field]
      }
    }
    return next
  }
  return value
}

export function checkFields(fields: readonly Field[], requested: readonly string[]): void {
  const allowed = fields.map((field) => field.name)
  for (const name of requested) {
    const top = name.split(".")[0] ?? name
    if (!allowed.includes(top)) {
      const did = suggest(top, allowed)
      fail.usage(`unknown field "${name}"${did ? `. Did you mean "${did}"?` : ""}`, {
        hint: `fields: ${allowed.join(", ")}`,
        details: { fields: allowed },
      })
    }
  }
}

async function validateProduced(op: AnyOperation, produced: unknown): Promise<void> {
  const output = op.output
  if (output.kind === "opaque") return
  if (output.kind === "stream") return
  if (output.kind === "data" && output.cardinality === "single") {
    await validate(output.schema, produced)
    return
  }
  if (output.kind === "data" && output.cardinality === "bounded") {
    if (!Array.isArray(produced)) fail.usage("bounded handler must return an array")
    const items = produced as unknown[]
    for (const item of items) await validate(output.schema, item)
    return
  }
  const page = produced as Page<unknown>
  if (!page || !Array.isArray(page.items)) fail.usage("unbounded handler must return { items, nextCursor }")
  for (const item of page.items) await validate(output.schema, item)
}

function toOutcome(op: AnyOperation, produced: unknown, fields?: readonly string[]): Outcome {
  const output = op.output
  if (output.kind === "opaque") {
    return { kind: "opaque", mediaType: output.mediaType, bytes: produced as Uint8Array | ReadableStream<Uint8Array> }
  }
  if (output.kind === "stream") {
    return { kind: "stream", items: produced as AsyncIterable<unknown> }
  }
  if (output.kind === "data" && output.cardinality === "single") {
    const value = fields ? projectValue(produced, fields) : produced
    return { kind: "data", cardinality: "single", value }
  }
  if (output.kind === "data" && output.cardinality === "bounded") {
    const value = fields ? projectValue(produced, fields) : produced
    return { kind: "data", cardinality: "bounded", value }
  }
  const page = produced as Page<unknown>
  const value = fields ? projectValue(page.items, fields) : page.items
  return {
    kind: "data",
    cardinality: "unbounded",
    value,
    meta: {
      nextCursor: page.nextCursor ?? null,
      truncated: page.truncated,
    },
  }
}

export function app(spec: AppSpec): App {
  const pagination = spec.pagination ?? { defaultLimit: 50, maxLimit: 200 }
  const holder: { app?: App; tree?: CommandTree; operations: AnyOperation[] } = {
    operations: [],
  }

  const userOps = [...spec.operations]
  checkFlagConsistency(userOps)

  const authFlag = spec.auth?.flag
  if (authFlag) {
    for (const operation of userOps) {
      if (operation.inputFields.some((field) => field.name === authFlag || camel(field.name) === authFlag)) {
        fail.usage(`input field collides with auth flag --${kebab(authFlag)}`)
      }
    }
  }

  const builtins: AnyOperation[] = []
  if (spec.auth) {
    builtins.push(
      op({
        name: "auth.whoami",
        summary: "Show which credential is in use",
        input: passthrough<Record<string, never>>({ type: "object", properties: {} }),
        output: out.single(Whoami),
        effects: "read_only",
        auth: "optional",
        examples: [{ summary: "Inspect credential", input: {} }],
        run(_input, ctx) {
          return {
            source: ctx.auth?.source ?? null,
            via: ctx.auth?.via ?? null,
            tokenPrefix: ctx.auth ? tokenPrefix(ctx.auth.token) : null,
            actor: ctx.actor,
          }
        },
      }),
    )
  }

  const ManifestSchema = passthrough<unknown>({ type: "object" })
  builtins.push(
    op({
      name: "manifest",
      summary: "Print the machine-readable command tree",
      input: passthrough<Record<string, never>>({ type: "object", properties: {} }),
      output: out.single(ManifestSchema),
      effects: "read_only",
      auth: "none",
      examples: [{ summary: "Dump manifest", input: {} }],
      run() {
        return holder.app!.manifest()
      },
    }),
    op({
      name: "skill",
      summary: "Print the agent playbook",
      input: passthrough<Record<string, never>>({ type: "object", properties: {} }),
      output: out.opaque("text/markdown"),
      effects: "read_only",
      auth: "none",
      examples: [{ summary: "Write SKILL.md", input: {} }],
      async run() {
        return new TextEncoder().encode(holder.app!.skill())
      },
    }),
  )

  const operations = [...userOps, ...builtins]
  holder.operations = operations
  const tree = buildTree({
    spec: {
      name: spec.name,
      summary: spec.summary,
      groups: { ...builtinGroupSummaries(spec), ...spec.groups },
    },
    operations,
  })
  holder.tree = tree

  const find = (tokens: readonly string[]): Found => findInTree(tree, tokens)

  const invoke = async (
    target: string | AnyOperation,
    input: unknown,
    runtime: Partial<Runtime> | Runtime,
    opts?: InvokeOptions,
  ): Promise<Outcome> => {
    const operation =
      typeof target === "string"
        ? operations.find((item) => item.name === target)
        : target
    if (!operation) {
      return {
        kind: "failure",
        failure: { kind: "usage", message: `unknown operation "${String(target)}"`, hint: "run --help" },
      }
    }
    const full: Runtime = {
      signal: runtime.signal ?? new AbortController().signal,
      auth: runtime.auth ?? null,
      confirmed: runtime.confirmed ?? false,
      actor: runtime.actor ?? "agent",
      note: runtime.note ?? (() => {}),
    }
    try {
      if (opts?.fields && opts.fields.length > 0) {
        if (operation.output.kind === "opaque" || operation.output.kind === "stream") {
          fail.usage(`--fields does not apply to ${operation.output.kind} output`, {
            hint: "omit --fields",
          })
        }
        checkFields(operation.outputFields, opts.fields)
      }
      const need: AuthNeed = operation.auth ?? (spec.auth ? "required" : "none")
      if (need === "required" && !full.auth) {
        fail.auth(`no credential found for ${spec.name}`, {
          hint: spec.auth
            ? `set ${spec.auth.env}, pass --${spec.auth.flag ?? "token"}, or provide a config token`
            : "configure auth",
        })
      }
      const parsedInput = ownRecord(input)
      const extraYes = parsedInput.yes === true
      const pageLimit = parsedInput.limit
      const pageCursor = parsedInput.cursor
      const rest = ownRecord(parsedInput)
      delete rest.yes
      delete rest.limit
      delete rest.cursor
      if (operation.confirm && !full.confirmed && !extraYes) {
        const message =
          typeof operation.confirm === "function"
            ? operation.confirm(rest as never)
            : operation.confirm
        fail.usage(`"${operation.name.replaceAll(".", " ")}" is destructive and requires --yes when no person is at the terminal`, {
          hint: `${spec.name} ${operation.path.join(" ")} --yes`,
          details: { confirm: message },
        })
      }
      const parsed = await validate(operation.input, rest)
      const ctx: Ctx = {
        signal: full.signal,
        auth: full.auth,
        actor: full.actor,
        note: full.note,
      }
      const handlerInput =
        operation.output.kind === "data" && operation.output.cardinality === "unbounded"
          ? {
              ...(parsed as object),
              limit:
                typeof pageLimit === "number"
                  ? pageLimit
                  : pagination.defaultLimit,
              cursor: typeof pageCursor === "string" ? pageCursor : undefined,
            }
          : parsed
      const produced = await operation.run(handlerInput as never, ctx)
      await validateProduced(operation, produced)
      return toOutcome(operation, produced, opts?.fields)
    } catch (error) {
      const failure = isFail(error)
        ? error
        : internalFail(error, {
            debugStacks: opts?.debugStacks,
            hint: `this is a bug in ${spec.name}; rerun with OPCLI_DEBUG=1 for a stack`,
          })
      return { kind: "failure", failure }
    }
  }

  const self: App = {
    spec,
    pagination,
    invoke: invoke as App["invoke"],
    find,
    main: async (io) => {
      const { main } = await import("./cli.ts")
      return main(self, io)
    },
    run: async (argv, io) => {
      const { run } = await import("./cli.ts")
      return run(self, argv, io)
    },
    manifest: (scope) => buildManifest(self, scope),
    skill: () => skillMarkdown(self),
  }
  holder.app = self
  return self
}
