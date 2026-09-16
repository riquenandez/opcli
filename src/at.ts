import { kebab } from "./case.ts"
import type { Field } from "./contract.ts"
import { fail, isFail } from "./fail.ts"

export type Slot =
  | { readonly kind: "input" }
  | { readonly kind: "flag"; readonly field: Field }
  | { readonly kind: "arg"; readonly field: Field | undefined; readonly index: number }

export type AtRef =
  | { readonly kind: "literal"; readonly text: string }
  | { readonly kind: "stdin" }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "empty" }

export type StdinUse = { readonly kind: "unused" } | { readonly kind: "consumed"; readonly by: string }

export type ValueIO = {
  readonly cwd: string
  readFile(path: string): Promise<string>
  readonly stdin: { text(): Promise<string> }
}

export type ArgvValues = {
  text(slot: Slot, raw: string): Promise<string>
  readonly stdin: StdinUse
}

export const AT_CONVENTION = {
  appliesTo: "string values and --input",
  file: "@<path>",
  stdin: "@-",
  escape: "@@",
  helpLine: "String values accept @<path> (file contents), @- (stdin, once), @@ (literal @).",
  agentRule: [
    "Inline one-line strings directly.",
    "For multi-line text, write a temp file and pass @/absolute/path in the same turn.",
    "@- reads stdin once; destructive commands then need --yes.",
    "Handlers receive contents, never paths. MCP and invoke take the string itself; @ is argv-only.",
  ],
} as const

export type AtConvention = typeof AT_CONVENTION

export function parseAt(raw: string): AtRef {
  if (raw.startsWith("@@")) return { kind: "literal", text: raw.slice(1) }
  if (raw === "@-") return { kind: "stdin" }
  if (raw === "@") return { kind: "empty" }
  if (raw.startsWith("@")) return { kind: "file", path: raw.slice(1) }
  return { kind: "literal", text: raw }
}

export function expandsAt(slot: Slot): boolean {
  if (slot.kind === "input") return true
  return slot.field?.type === "string"
}

export function describeSlot(slot: Slot): string {
  if (slot.kind === "input") return "--input"
  if (slot.kind === "flag") return `--${kebab(slot.field.name)}`
  if (slot.field) return `<${slot.field.name}>`
  return `argument ${slot.index + 1}`
}

export function resolvePath(cwd: string, path: string): string {
  const joined = path.startsWith("/") ? path : `${cwd.replace(/\/+$/, "")}/${path}`
  const parts: string[] = []
  const absolute = joined.startsWith("/")
  for (const part of joined.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return absolute ? `/${parts.join("/")}` : parts.join("/")
}

export function argvValues(io: ValueIO): ArgvValues {
  let stdin: StdinUse = { kind: "unused" }
  return {
    get stdin() {
      return stdin
    },
    async text(slot, raw) {
      if (!expandsAt(slot)) return raw
      const ref = parseAt(raw)
      switch (ref.kind) {
        case "empty":
          return fail.usage(`empty @ for ${describeSlot(slot)}`, {
            hint: "use @<path>, @-, or @@ for a literal @",
          })
        case "literal":
          return ref.text
        case "stdin": {
          if (stdin.kind === "consumed") {
            return fail.usage(`stdin was already read for ${stdin.by}`, {
              hint: "@- can appear once per command",
            })
          }
          stdin = { kind: "consumed", by: describeSlot(slot) }
          return io.stdin.text()
        }
        case "file": {
          try {
            return await io.readFile(resolvePath(io.cwd, ref.path))
          } catch (error) {
            if (isFail(error)) throw error
            return fail.usage(`cannot read ${ref.path} for ${describeSlot(slot)}`, {
              hint: `the path is relative to ${io.cwd}; use @@${ref.path} for a literal "@${ref.path}"`,
              details: { path: ref.path, slot: describeSlot(slot) },
            })
          }
        }
      }
    },
  }
}
