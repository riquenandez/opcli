import { resolveCredential } from "./auth.ts"
import { checkFields, ownRecord, type App, type Outcome } from "./app.ts"
import { argvValues, type StdinUse } from "./at.ts"
import { camel, kebab } from "./case.ts"
import { detect, type HumanTty } from "./detect.ts"
import { helpText, manifest } from "./docs.ts"
import { EXIT_CODE, Fail, fail, failurePayload, internalFail, isFail, wantsDebugStacks, type ExitCode, type Failure } from "./fail.ts"
import type { Field } from "./contract.ts"
import type { AnyOperation, Actor } from "./operation.ts"
import { suggest } from "./suggest.ts"

export type Sink = {
  write(chunk: string | Uint8Array): Promise<void>
  readonly isTTY: boolean
}

export type ProcessIO = {
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string | undefined>>
  readonly stdin: {
    readonly isTTY: boolean
    text(): Promise<string>
    question(prompt: string): Promise<string>
  }
  readonly stdout: Sink
  readonly stderr: Sink
  readonly cwd: string
  onSignal(handler: (signal: "SIGINT" | "SIGTERM", number: number) => void): void
  readFile(path: string): Promise<string>
  readonly keychain: {
    get(service: string, account: string): Promise<string | null>
    set(service: string, account: string, token: string): Promise<void>
    delete(service: string, account: string): Promise<void>
  }
}

export type Mode = "json" | "ndjson" | "human" | "raw"

export type GlobalFlags = {
  readonly json?: true
  readonly human?: true
  readonly fields?: readonly string[]
  readonly limit?: number
  readonly cursor?: string
  readonly yes?: true
  readonly input?: string
  readonly help?: true
  readonly version?: true
  readonly token?: string
}

export type RunFlags = Omit<GlobalFlags, "input">

export type Invocation =
  | {
      readonly kind: "run"
      readonly op: AnyOperation
      readonly input: Record<string, unknown>
      readonly flags: RunFlags
      readonly stdin: StdinUse
    }
  | { readonly kind: "help"; readonly scope: readonly string[]; readonly json: boolean }
  | { readonly kind: "version" }
  | { readonly kind: "usage_error"; readonly failure: Failure; readonly scope: readonly string[]; readonly json: boolean }

const GLOBAL_BOOL = new Set(["json", "human", "yes", "help", "version"])
const GLOBAL_VALUE = new Set(["fields", "limit", "cursor", "input", "token"])

type Token = { kind: "pos"; value: string } | { kind: "flag"; name: string; value: string | true }

function tokenize(argv: readonly string[]): Token[] {
  const tokens: Token[] = []
  let i = 0
  let rest = false
  while (i < argv.length) {
    const raw = argv[i] ?? ""
    if (rest || raw === "--") {
      if (raw === "--") {
        rest = true
        i++
        continue
      }
      tokens.push({ kind: "pos", value: raw })
      i++
      continue
    }
    if (raw.startsWith("--")) {
      const body = raw.slice(2)
      const eq = body.indexOf("=")
      if (eq >= 0) {
        tokens.push({ kind: "flag", name: body.slice(0, eq), value: body.slice(eq + 1) })
        i++
        continue
      }
      if (body.startsWith("no-") && body.length > 3) {
        tokens.push({ kind: "flag", name: body, value: true })
        i++
        continue
      }
      const next = argv[i + 1]
      const knownBool = GLOBAL_BOOL.has(body)
      const knownValue = GLOBAL_VALUE.has(body)
      if (knownBool) {
        tokens.push({ kind: "flag", name: body, value: true })
        i++
        continue
      }
      if ((knownValue || (next !== undefined && !next.startsWith("-"))) && next !== undefined) {
        tokens.push({ kind: "flag", name: body, value: next })
        i += 2
        continue
      }
      tokens.push({ kind: "flag", name: body, value: true })
      i++
      continue
    }
    if (raw.startsWith("-") && raw !== "-") {
      fail.usage(`short flags are not supported: ${raw}`, {
        hint: "use the long form, e.g. --json",
      })
    }
    tokens.push({ kind: "pos", value: raw })
    i++
  }
  return tokens
}

function stripPath(tokens: Token[], path: readonly string[]): Token[] {
  let i = 0
  const leftover: Token[] = []
  for (const token of tokens) {
    if (token.kind === "pos" && i < path.length && token.value === path[i]) {
      i++
      continue
    }
    leftover.push(token)
  }
  return leftover
}

function collectGlobals(tokens: Token[], authFlag?: string): { flags: GlobalFlags; rest: Token[] } {
  const rest: Token[] = []
  const seen = new Map<string, string | true>()
  const flags: {
    json?: true
    human?: true
    fields?: string[]
    limit?: number
    cursor?: string
    yes?: true
    input?: string
    help?: true
    version?: true
    token?: string
  } = {}
  const isGlobal = (name: string) =>
    GLOBAL_BOOL.has(name) || GLOBAL_VALUE.has(name) || name === authFlag || kebab(authFlag ?? "") === name

  for (const token of tokens) {
    if (token.kind !== "flag" || !isGlobal(token.name)) {
      rest.push(token)
      continue
    }
    const name = token.name
    if (seen.has(name) && name !== "fields") {
      fail.usage(`repeated flag --${kebab(name)}`, { hint: "pass it once" })
    }
    seen.set(name, token.value)
    if (name === "json") flags.json = true
    else if (name === "human") flags.human = true
    else if (name === "yes") flags.yes = true
    else if (name === "help") flags.help = true
    else if (name === "version") flags.version = true
    else if (name === "fields") {
      const text = token.value === true ? "" : token.value
      flags.fields = text.split(",").map((item) => item.trim()).filter(Boolean)
    } else if (name === "limit") {
      const n = Number(token.value)
      if (!Number.isInteger(n) || n < 1) fail.usage("invalid --limit", { hint: "use a positive integer" })
      flags.limit = n
    } else if (name === "cursor") flags.cursor = String(token.value)
    else if (name === "input") flags.input = String(token.value)
    else if (name === "token" || name === authFlag) flags.token = String(token.value)
  }
  return { flags, rest }
}

function coerce(field: Field, raw: string): unknown {
  if (field.type === "boolean") {
    if (raw === "true" || raw === "1") return true
    if (raw === "false" || raw === "0") return false
    fail.usage(`invalid boolean for --${kebab(field.name)}`)
  }
  if (field.type === "number" || field.type === "integer") {
    const n = Number(raw)
    if (!Number.isFinite(n)) fail.usage(`invalid number for --${kebab(field.name)}`)
    if (field.type === "integer" && !Number.isInteger(n)) fail.usage(`expected integer for --${kebab(field.name)}`)
    return n
  }
  return raw
}

async function bindOp(
  operation: AnyOperation,
  tokens: Token[],
  flags: GlobalFlags,
  values: ReturnType<typeof argvValues>,
  pagination: { defaultLimit: number; maxLimit: number },
): Promise<{ input: Record<string, unknown>; stdin: StdinUse }> {
  const positionals = tokens.filter((token) => token.kind === "pos").map((token) => token.value)
  const flagTokens = tokens.filter((token) => token.kind === "flag")
  const byName = new Map<string, Field>()
  for (const field of operation.inputFields) byName.set(field.name, field)
  const args = operation.args ?? []
  let input: Record<string, unknown> = Object.create(null)

  if (flags.input) {
    const text = await values.text({ kind: "input" }, flags.input)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      fail.usage("invalid --input JSON", { hint: "pass a JSON object or @path" })
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail.usage("--input must be a JSON object")
    }
    input = ownRecord(parsed)
  }

  for (let i = 0; i < args.length; i++) {
    const name = args[i]
    if (!name) continue
    const field = byName.get(name)
    const raw = positionals[i]
    if (raw === undefined) {
      if (field?.required && field.default === undefined) {
        fail.usage(`missing required argument <${name}>`, {
          hint: `Usage: … ${args.map((item) => `<${item}>`).join(" ")}`,
        })
      }
      continue
    }
    const text = await values.text({ kind: "arg", field, index: i }, raw)
    input[name] = field ? coerce(field, text) : text
  }
  if (positionals.length > args.length) {
    fail.usage(`unexpected argument "${positionals[args.length]}"`, {
      hint: "check the command usage",
    })
  }

  const seen = new Set<string>()
  for (const token of flagTokens) {
    const name = camel(token.name.startsWith("no-") ? token.name.slice(3) : token.name)
    const field = byName.get(name) ?? byName.get(token.name)
    if (!field) {
      const allowed = operation.inputFields
        .filter((item) => item.flagBindable && !args.includes(item.name))
        .map((item) => `--${kebab(item.name)}`)
      const did = suggest(`--${token.name}`, allowed)
      fail.usage(`unknown option --${token.name}${did ? `. Did you mean ${did}?` : ""}`, {
        hint: allowed.length ? `flags: ${allowed.join(", ")}` : "run --help",
      })
      continue
    }
    if (!field.flagBindable) {
      fail.usage(`--${kebab(field.name)} cannot be a flag`, {
        hint: "pass it inside --input JSON",
      })
      continue
    }
    if (seen.has(field.name) && field.type !== "array") {
      fail.usage(`repeated flag --${kebab(field.name)}`, { hint: "pass it once" })
    }
    seen.add(field.name)
    if (field.type === "boolean") {
      input[field.name] = token.name.startsWith("no-") ? false : token.value !== "false"
      continue
    }
    const raw = token.value === true ? "" : String(token.value)
    if (field.type === "array") {
      const current = Array.isArray(input[field.name]) ? [...(input[field.name] as unknown[])] : []
      current.push(...raw.split(",").filter(Boolean).map((part) => coerce({ ...field, type: field.items ?? "string" }, part)))
      input[field.name] = current
    } else {
      const text = await values.text({ kind: "flag", field }, raw)
      input[field.name] = coerce(field, text)
    }
  }

  if (operation.output.kind === "data" && operation.output.cardinality === "unbounded") {
    const limit = Math.min(Math.max(flags.limit ?? pagination.defaultLimit, 1), pagination.maxLimit)
    input.limit = limit
    if (flags.cursor) input.cursor = flags.cursor
  }
  return { input, stdin: values.stdin }
}

export async function parseArgv(app: App, argv: readonly string[], io: ProcessIO): Promise<Invocation> {
  const tokens = tokenize(argv)
  const json = tokens.some((token) => token.kind === "flag" && token.name === "json")
  try {
    const { flags, rest } = collectGlobals(tokens, app.spec.auth?.flag)
    if (flags.json && flags.human) {
      return {
        kind: "usage_error",
        failure: { kind: "usage", message: "--json and --human cannot be combined", hint: "pick one" },
        scope: [],
        json,
      }
    }
    if (flags.version && !flags.help) return { kind: "version" }
    const positionals = rest.filter((token) => token.kind === "pos").map((token) => token.value)
    const found = app.find(positionals)
    if (flags.help) {
      if (found.kind === "miss") {
        return {
          kind: "usage_error",
          failure: {
            kind: "usage",
            message: `unknown command "${found.token}"${found.suggestions[0] ? `. Did you mean "${found.suggestions[0]}"?` : ""}`,
            hint: "run --help",
          },
          scope: found.at,
          json,
        }
      }
      const scope = found.kind === "op" ? found.op.path : found.kind === "group" ? found.node.path : []
      return { kind: "help", scope: [...scope], json }
    }
    if (found.kind === "miss") {
      return {
        kind: "usage_error",
        failure: {
          kind: "usage",
          message: `unknown command "${found.token}"${found.suggestions[0] ? `. Did you mean "${found.suggestions[0]}"?` : ""}`,
          hint: "run --help",
        },
        scope: found.at,
        json,
      }
    }
    if (found.kind === "group") {
      if (found.node.path.length === 0 && rest.length === 0) {
        return { kind: "help", scope: [], json }
      }
      return { kind: "help", scope: [...found.node.path], json }
    }
    const leftover = stripPath(rest, found.op.path)
    if (flags.fields && (found.op.output.kind === "opaque" || found.op.output.kind === "stream")) {
      const streamed = found.op.output.kind === "stream"
      return {
        kind: "usage_error",
        failure: {
          kind: "usage",
          message: streamed
            ? `"${found.op.name.replaceAll(".", " ")}" streams records; --fields does not apply`
            : `"${found.op.name.replaceAll(".", " ")}" emits raw ${found.op.output.mediaType} bytes; --fields does not apply`,
          hint: streamed ? "omit --fields" : "redirect stdout to a file",
        },
        scope: found.op.path,
        json,
      }
    }
    if (flags.fields) {
      checkFields(found.op.outputFields, flags.fields)
    }
    if (found.op.output.kind === "opaque" && (flags.json || flags.human)) {
      return {
        kind: "usage_error",
        failure: {
          kind: "usage",
          message: `"${found.op.name.replaceAll(".", " ")}" emits raw ${found.op.output.mediaType} bytes; --json does not apply`,
          hint: "redirect stdout to a file",
        },
        scope: found.op.path,
        json,
      }
    }
    const values = argvValues(io)
    const bound = await bindOp(found.op, leftover, flags, values, app.pagination)
    const runFlags: RunFlags = {
      json: flags.json,
      human: flags.human,
      fields: flags.fields,
      limit: flags.limit,
      cursor: flags.cursor,
      yes: flags.yes,
      help: flags.help,
      version: flags.version,
      token: flags.token,
    }
    return { kind: "run", op: found.op, input: bound.input, flags: runFlags, stdin: bound.stdin }
  } catch (error) {
    if (isFail(error)) {
      return { kind: "usage_error", failure: error, scope: [], json }
    }
    throw error
  }
}

export function resolveMode(kind: "data" | "stream" | "opaque", flags: GlobalFlags, actor: Actor): Mode | Fail {
  if (flags.json && flags.human) {
    return new Fail({ kind: "usage", message: "--json and --human cannot be combined", hint: "pick one" })
  }
  if (kind === "opaque") {
    if (flags.json || flags.human) {
      return new Fail({
        kind: "usage",
        message: "opaque commands write raw bytes; --json does not apply",
        hint: "redirect stdout to a file",
      })
    }
    return "raw"
  }
  const machine = Boolean(flags.json) || actor !== "human"
  if (kind === "stream") {
    if (flags.human) return "human"
    if (machine) return "ndjson"
    return "human"
  }
  if (flags.human) return "human"
  if (machine) return "json"
  return "human"
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return iso
  const delta = Date.now() - then
  const minutes = Math.round(delta / 60000)
  if (Math.abs(minutes) < 1) return "now"
  if (Math.abs(minutes) < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

function cell(value: unknown, format?: string): string {
  if (value === null || value === undefined) return "—"
  if (format === "date-time" && typeof value === "string") return relativeTime(value)
  return String(value)
}

function at(value: unknown, path: string): unknown {
  let current: unknown = value
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function formatOf(fields: readonly Field[] | undefined, path: string): string | undefined {
  if (path.includes(".")) return undefined
  return fields?.find((field) => field.name === path)?.format
}

function table(rows: Record<string, unknown>[], columns: readonly string[], fields?: readonly Field[]): string {
  if (rows.length === 0) return ""
  const header = columns.map((col) => col.toUpperCase())
  const body = rows.map((row) =>
    columns.map((col) => cell(at(row, col), formatOf(fields, col))),
  )
  const widths = columns.map((_, i) =>
    Math.max(header[i]?.length ?? 0, ...body.map((line) => line[i]?.length ?? 0)),
  )
  const fmt = (line: string[]) => line.map((item, i) => item.padEnd(widths[i] ?? 0)).join("  ")
  return [fmt(header), ...body.map(fmt)].join("\n")
}

function kv(value: Record<string, unknown>, fields?: readonly Field[], columns?: readonly string[]): string {
  const keys = columns && columns.length > 0 ? columns : Object.keys(value)
  return keys
    .map((key) => `${key}: ${cell(at(value, key), formatOf(fields, key))}`)
    .join("\n")
}

async function writeError(failure: Failure, json: boolean, io: ProcessIO): Promise<ExitCode> {
  if (json) {
    await io.stderr.write(`${JSON.stringify({ error: failurePayload(failure) })}\n`)
  } else {
    await io.stderr.write(`error[${failure.kind}]: ${failure.message}\n`)
    if (failure.hint) await io.stderr.write(`  hint: ${failure.hint}\n`)
  }
  return EXIT_CODE[failure.kind]
}

export async function render(outcome: Outcome, opts: { mode: Mode; fields?: readonly string[] }, io: ProcessIO, operation?: AnyOperation): Promise<ExitCode> {
  if (outcome.kind === "failure") {
    return writeError(outcome.failure, opts.mode === "json" || opts.mode === "ndjson" || !io.stdout.isTTY, io)
  }
  if (outcome.kind === "opaque") {
    const bytes = outcome.bytes
    if (bytes instanceof Uint8Array) await io.stdout.write(bytes)
    else {
      for await (const chunk of streamToAsync(bytes)) await io.stdout.write(chunk)
    }
    return 0
  }
  if (outcome.kind === "stream") {
    for await (const record of outcome.items) {
      if (opts.mode === "human") {
        await io.stdout.write(`${compactLine(record)}\n`)
      } else {
        await io.stdout.write(`${JSON.stringify(record)}\n`)
      }
    }
    return 0
  }
  if (opts.mode === "json" || opts.mode === "ndjson") {
    const body =
      outcome.cardinality === "unbounded" || outcome.cardinality === "bounded"
        ? { data: outcome.value, meta: outcome.meta ?? (outcome.cardinality === "bounded" ? { count: Array.isArray(outcome.value) ? outcome.value.length : 0 } : undefined) }
        : { data: outcome.value }
    await io.stdout.write(`${JSON.stringify(body)}\n`)
    return 0
  }
  const fields = operation?.outputFields
  const columns = opts.fields ?? fields?.map((field) => field.name) ?? []
  if (outcome.cardinality === "single") {
    await io.stdout.write(`${kv(asRecord(outcome.value), fields, opts.fields)}\n`)
    return 0
  }
  const rows = Array.isArray(outcome.value) ? outcome.value.map(asRecord) : []
  await io.stdout.write(`${table(rows, columns.length ? columns : Object.keys(rows[0] ?? {}), fields)}\n`)
  if (outcome.cardinality === "unbounded" && outcome.meta?.nextCursor) {
    await io.stderr.write(`more: --cursor ${outcome.meta.nextCursor}\n`)
  }
  return 0
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  return { value }
}

function compactLine(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.values(value as Record<string, unknown>).map(String).join("  ")
  }
  return String(value)
}

async function* streamToAsync(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      if (value) yield value
    }
  } finally {
    reader.releaseLock()
  }
}

function redirectConsole(write: (line: string) => void): () => void {
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  }
  const divert = (...args: unknown[]) => write(args.map(String).join(" "))
  console.log = divert
  console.info = divert
  console.warn = divert
  console.error = divert
  console.debug = divert
  return () => {
    console.log = original.log
    console.info = original.info
    console.warn = original.warn
    console.error = original.error
    console.debug = original.debug
  }
}

export async function main(app: App, io = processIO()): Promise<ExitCode> {
  const inv = await parseArgv(app, io.argv.slice(2), io)
  const detection = detect(
    {
      env: io.env,
      stdinIsTTY: io.stdin.isTTY,
      stdoutIsTTY: io.stdout.isTTY,
      stderrIsTTY: io.stderr.isTTY,
      prompt: (question) => io.stdin.question(question),
    },
    app.spec.agentEnv,
  )
  const machine = detection.actor !== "human"
  if (inv.kind === "version") {
    await io.stdout.write(`${app.spec.name} ${app.spec.version}\n`)
    return 0
  }
  if (inv.kind === "help") {
    if (inv.json) await io.stdout.write(`${JSON.stringify(manifest(app, inv.scope), null, 2)}\n`)
    else await io.stdout.write(`${helpText(app, inv.scope)}\n`)
    return 0
  }
  if (inv.kind === "usage_error") {
    const json = inv.json || machine
    const code = await writeError(inv.failure, json, io)
    if (!json) await io.stderr.write(`\n${helpText(app, inv.scope)}\n`)
    return code
  }
  const mode = resolveMode(inv.op.output.kind, inv.flags, detection.actor)
  if (mode instanceof Fail) return writeError(mode, Boolean(inv.flags.json) || machine, io)
  let confirmed = Boolean(inv.flags.yes)
  if (inv.op.confirm && !confirmed) {
    const human: HumanTty | null = inv.stdin.kind === "consumed" ? null : detection.human
    if (human) {
      const message = typeof inv.op.confirm === "function" ? inv.op.confirm(inv.input as never) : inv.op.confirm
      const answer = await human.prompt(`${message} [y/N] `)
      confirmed = answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes"
    }
  }
  const auth = await resolveCredential(app.spec.auth, inv.flags.token, {
    env: io.env,
    readFile: (path) => io.readFile(path),
    keychain: io.keychain,
    warn: (message) => void io.stderr.write(`${message}\n`),
  })
  const controller = new AbortController()
  let signalExit: ExitCode | undefined
  io.onSignal((signal, number) => {
    controller.abort()
    signalExit = (128 + number) as ExitCode
    void signal
  })
  const restore = redirectConsole((line) => {
    void io.stderr.write(`${line}\n`)
  })
  try {
    const outcome = await app.invoke(inv.op, inv.input, {
      signal: controller.signal,
      auth,
      confirmed,
      actor: detection.actor,
      note: (message) => {
        void io.stderr.write(`${message}\n`)
      },
    }, { fields: inv.flags.fields, debugStacks: wantsDebugStacks(io.env) })
    if (signalExit) return signalExit
    return await render(outcome, { mode, fields: inv.flags.fields }, io, inv.op)
  } catch (error) {
    return writeError(internalFail(error, { debugStacks: wantsDebugStacks(io.env) }), mode === "json" || mode === "ndjson", io)
  } finally {
    restore()
  }
}

export type TestIO = {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly stdin?: string
  readonly tty?: { readonly stdin?: boolean; readonly stdout?: boolean; readonly stderr?: boolean }
  readonly files?: Readonly<Record<string, string>>
  readonly keychain?: Readonly<Record<string, string>>
  readonly cwd?: string
}

export type RunResult = {
  readonly stdout: string
  readonly stderr: string
  readonly exit: ExitCode
}

export async function run(app: App, argv: readonly string[], test: TestIO = {}): Promise<RunResult> {
  const stdout: Uint8Array[] = []
  const stderr: Uint8Array[] = []
  const decoder = new TextDecoder()
  const io: ProcessIO = {
    argv: [app.spec.name, app.spec.name, ...argv],
    env: test.env ?? {},
    cwd: test.cwd ?? "/",
    stdin: {
      isTTY: Boolean(test.tty?.stdin),
      text: async () => test.stdin ?? "",
      question: async () => "n",
    },
    stdout: {
      isTTY: Boolean(test.tty?.stdout),
      write: async (chunk) => {
        stdout.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk)
      },
    },
    stderr: {
      isTTY: Boolean(test.tty?.stderr),
      write: async (chunk) => {
        stderr.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk)
      },
    },
    onSignal: () => {},
    readFile: async (path) => {
      const files = test.files ?? {}
      if (path in files) return files[path] ?? ""
      const relative = path.replace(/^\/+/, "")
      if (relative in files) return files[relative] ?? ""
      const byName = path.split("/").pop()
      if (byName && byName in files) return files[byName] ?? ""
      throw new Error(`cannot read ${path}`)
    },
    keychain: {
      get: async (service, account) => test.keychain?.[`${service}:${account}`] ?? null,
      set: async () => {},
      delete: async () => {},
    },
  }
  const exit = await main(app, io)
  return {
    stdout: decoder.decode(concat(stdout)),
    stderr: decoder.decode(concat(stderr)),
    exit,
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

export async function readLineFrom(source: AsyncIterable<Uint8Array | string>): Promise<string> {
  let buf = ""
  const decoder = new TextDecoder()
  for await (const chunk of source) {
    buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
    const nl = buf.search(/\r?\n/)
    if (nl >= 0) return buf.slice(0, nl).trim()
  }
  return buf.trim()
}

export function processIO(): ProcessIO {
  const env = process.env
  return {
    argv: process.argv,
    env,
    cwd: process.cwd(),
    stdin: {
      isTTY: Boolean(process.stdin.isTTY),
      text: async () => new Response(process.stdin as unknown as ReadableStream).text(),
      question: async (prompt) => {
        process.stderr.write(prompt)
        return readLineFrom(process.stdin)
      },
    },
    stdout: {
      isTTY: Boolean(process.stdout.isTTY),
      write: async (chunk) => {
        process.stdout.write(chunk)
      },
    },
    stderr: {
      isTTY: Boolean(process.stderr.isTTY),
      write: async (chunk) => {
        process.stderr.write(chunk)
      },
    },
    onSignal: (handler) => {
      process.on("SIGINT", () => handler("SIGINT", 2))
      process.on("SIGTERM", () => handler("SIGTERM", 15))
    },
    readFile: async (path) => Bun.file(path).text(),
    keychain: {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
    },
  }
}

export type { Actor }
