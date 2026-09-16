import type { App } from "./app.ts"
import { kebab } from "./case.ts"
import { EXIT_CODE } from "./fail.ts"
import type { FailureKind } from "./fail.ts"
import type { JsonSchema } from "./contract.ts"
import { jsonSchemaOf } from "./contract.ts"
import type { AnyOperation, AuthNeed, Cardinality, Effects } from "./operation.ts"
import { outputCardinality } from "./operation.ts"

export type Manifest = {
  readonly name: string
  readonly version: string
  readonly summary: string
  readonly exitCodes: Readonly<Record<FailureKind, number>>
  readonly globalFlags: readonly string[]
  readonly operations: readonly OperationManifest[]
}

export type OperationManifest = {
  readonly name: string
  readonly path: readonly string[]
  readonly summary: string
  readonly description?: string
  readonly effects: Effects
  readonly confirm: boolean
  readonly auth: AuthNeed
  readonly input: JsonSchema
  readonly args: readonly string[]
  readonly output:
    | { readonly kind: "data"; readonly cardinality: Cardinality; readonly schema: JsonSchema }
    | { readonly kind: "stream"; readonly schema: JsonSchema }
    | { readonly kind: "opaque"; readonly mediaType: string }
  readonly examples: readonly { readonly summary: string; readonly input: unknown; readonly argv: string }[]
}

export function renderArgv(app: App, operation: AnyOperation, input: Record<string, unknown>): string {
  const parts = [app.spec.name, ...operation.path]
  const args = new Set(operation.args ?? [])
  for (const name of operation.args ?? []) {
    const value = input[name]
    if (value !== undefined) parts.push(String(value))
  }
  for (const [key, value] of Object.entries(input)) {
    if (args.has(key) || value === undefined) continue
    if (typeof value === "boolean") {
      parts.push(value ? `--${kebab(key)}` : `--no-${kebab(key)}`)
    } else {
      parts.push(`--${kebab(key)}`, String(value))
    }
  }
  return parts.join(" ")
}

function outputManifest(operation: AnyOperation): OperationManifest["output"] {
  if (operation.output.kind === "opaque") {
    return { kind: "opaque", mediaType: operation.output.mediaType }
  }
  if (operation.output.kind === "stream") {
    return { kind: "stream", schema: jsonSchemaOf(operation.output.schema, "output") }
  }
  return {
    kind: "data",
    cardinality: outputCardinality(operation.output) ?? "single",
    schema: jsonSchemaOf(operation.output.schema, "output"),
  }
}

export function manifest(app: App, scope?: readonly string[]): Manifest {
  const operations = operationsOf(app).filter((operation) => {
    if (!scope || scope.length === 0) return true
    return scope.every((part, i) => operation.path[i] === part)
  })
  return {
    name: app.spec.name,
    version: app.spec.version,
    summary: app.spec.summary,
    exitCodes: { ...EXIT_CODE },
    globalFlags: ["json", "human", "fields", "limit", "cursor", "yes", "input", "help", "version"],
    operations: operations.map((operation) => ({
      name: operation.name,
      path: operation.path,
      summary: operation.summary,
      description: operation.description,
      effects: operation.effects,
      confirm: Boolean(operation.confirm),
      auth: operation.auth ?? (app.spec.auth ? "required" : "none"),
      input: jsonSchemaOf(operation.input, "input"),
      args: [...(operation.args ?? [])],
      output: outputManifest(operation),
      examples: operation.examples.map((example) => ({
        summary: example.summary,
        input: example.input,
        argv: renderArgv(app, operation, example.input as Record<string, unknown>),
      })),
    })),
  }
}

function operationsOf(app: App): AnyOperation[] {
  const found: AnyOperation[] = []
  const walk = (tokens: string[]) => {
    const result = app.find(tokens)
    if (result.kind === "op") found.push(result.op)
    if (result.kind === "group") {
      for (const child of result.node.children) {
        if (child.kind === "op") found.push(child.op)
        else walk([...child.path])
      }
    }
  }
  walk([])
  return found
}

export function helpText(app: App, scope: readonly string[]): string {
  const found = app.find(scope)
  const lines: string[] = []
  if (found.kind === "miss") {
    return `error[usage]: unknown command "${found.token}"`
  }
  if (found.kind === "group") {
    if (scope.length === 0) {
      lines.push(`${app.spec.name} ${app.spec.version} — ${app.spec.summary}`, "")
      lines.push(`Usage: ${app.spec.name} <command> [flags]`, "")
    } else {
      lines.push(`${app.spec.name} ${scope.join(" ")}`, "")
    }
    for (const child of found.node.children) {
      if (child.kind === "group") {
        const name = child.path[child.path.length - 1] ?? ""
        lines.push(`  ${name.padEnd(12)} ${child.summary}`)
      } else {
        const name = child.op.path[child.op.path.length - 1] ?? ""
        lines.push(`  ${name.padEnd(12)} ${child.op.summary}`)
      }
    }
    lines.push("", `Run \`${app.spec.name} ${[...scope, "<command>"].join(" ").trim()} --help\` for details. \`${app.spec.name} --help --json\` prints the machine manifest.`)
    return lines.join("\n")
  }
  const operation = found.op
  const positionals = (operation.args ?? []).map((name) => `<${name}>`).join(" ")
  lines.push(`Usage: ${app.spec.name} ${operation.path.join(" ")}${positionals ? ` ${positionals}` : ""} [flags]`, "")
  lines.push(operation.summary)
  if (operation.description) lines.push(operation.description)
  const tags: string[] = [operation.effects]
  if (operation.output.kind === "data") tags.push(operation.output.cardinality)
  lines.push(`  (${tags.join(", ")})`, "", "Flags")
  for (const field of operation.inputFields) {
    if (operation.args?.includes(field.name)) continue
    const flag = `--${kebab(field.name)}`
    const type =
      field.enum ? `<${field.enum.join("|")}>` : field.type === "boolean" ? "" : `<${field.type}>`
    const extra = field.flagBindable ? "" : " (--input only)"
    lines.push(`  ${flag} ${type}`.trimEnd().padEnd(32) + (field.description ?? "") + extra)
  }
  if (operation.output.kind === "data" && operation.output.cardinality === "unbounded") {
    const { defaultLimit, maxLimit } = app.pagination
    lines.push(`  --limit <int>                   Page size (default ${defaultLimit}, max ${maxLimit})`)
    lines.push("  --cursor <string>               Continue from meta.nextCursor")
  }
  if (operation.output.kind === "data") {
    lines.push("  --fields <a,b,c>                Project output to these fields")
  }
  if (operation.confirm) lines.push("  --yes                           Confirm a destructive operation")
  if (operation.examples.length > 0) {
    lines.push("", "Examples")
    for (const example of operation.examples) {
      lines.push(`  ${renderArgv(app, operation, example.input as Record<string, unknown>)}`)
      lines.push(`      ${example.summary}`)
    }
  }
  return lines.join("\n")
}

export function skillMarkdown(app: App): string {
  const tree = manifest(app)
  const lines = [
    `---`,
    `name: ${tree.name}`,
    `description: ${tree.summary}. Prefer --json. Destructive commands need --yes.`,
    `---`,
    "",
    `# ${tree.name}`,
    "",
    tree.summary,
    "",
    "## Exit codes",
    "",
    ...Object.entries(EXIT_CODE).map(([kind, code]) => `- \`${code}\` ${kind}`),
    "",
  ]
  let group = ""
  for (const operation of tree.operations) {
    const g = operation.path[0] ?? operation.name
    if (g !== group) {
      group = g
      lines.push(`## ${g}`, "")
    }
    lines.push(`### ${operation.path.join(" ")}`, "")
    lines.push(operation.summary, "")
    lines.push(`- effects: \`${operation.effects}\``)
    if (operation.output.kind === "data") lines.push(`- cardinality: \`${operation.output.cardinality}\``)
    else lines.push(`- output: \`${operation.output.kind}\``)
    if (operation.confirm) lines.push("- requires `--yes` when not a human TTY")
    lines.push("", "Examples:", "")
    for (const example of operation.examples) {
      lines.push(`\`\`\``, example.argv + " --json", `\`\`\``, "")
    }
  }
  return lines.join("\n")
}
