import type { AnyOperation } from "./operation.ts"
import { fail } from "./fail.ts"
import { suggest } from "./suggest.ts"

export type Segment = string
export type GroupPath = string

export type GroupNode = {
  readonly kind: "group"
  readonly path: readonly Segment[]
  readonly summary: string
  readonly children: ReadonlyMap<Segment, TreeNode>
}

export type OpNode = { readonly kind: "op"; readonly op: AnyOperation }

export type TreeNode = GroupNode | OpNode
export type CommandTree = GroupNode

export type Found =
  | { readonly kind: "op"; readonly op: AnyOperation; readonly rest: readonly string[] }
  | { readonly kind: "group"; readonly node: GroupNode; readonly rest: readonly string[] }
  | {
      readonly kind: "miss"
      readonly at: readonly string[]
      readonly token: string
      readonly suggestions: readonly string[]
    }

export type TreeProblem =
  | { readonly kind: "duplicate-operation"; readonly name: string }
  | { readonly kind: "operation-is-group"; readonly name: string; readonly path: GroupPath }
  | { readonly kind: "missing-group-summary"; readonly path: GroupPath }
  | { readonly kind: "empty-group-summary"; readonly path: GroupPath }
  | {
      readonly kind: "unused-group-key"
      readonly key: string
      readonly didYouMean?: string
      readonly namesOperation?: true
    }

export type TreeInput = {
  readonly spec: {
    readonly name: string
    readonly summary: string
    readonly groups?: Readonly<Record<string, string>>
  }
  readonly operations: readonly AnyOperation[]
}

type Building = {
  kind: "group"
  path: string[]
  summary: string | undefined
  children: Map<string, Building | OpNode>
}

export function builtinGroupSummaries(spec: { readonly auth?: unknown }): Record<string, string> {
  return spec.auth ? { auth: "Identity and credentials" } : {}
}

export function buildTree(input: TreeInput): CommandTree {
  const groups = input.spec.groups ?? {}
  const problems: TreeProblem[] = []
  const byName = new Map<string, AnyOperation>()
  const root: Building = { kind: "group", path: [], summary: input.spec.summary, children: new Map() }
  const byPath = new Map<string, Building>([["", root]])

  const ensureGroup = (segments: readonly string[]): Building => {
    const key = segments.join(".")
    const existing = byPath.get(key)
    if (existing) return existing
    const parent = ensureGroup(segments.slice(0, -1))
    const seg = segments[segments.length - 1] ?? ""
    const occupant = parent.children.get(seg)
    const node: Building = { kind: "group", path: [...segments], summary: undefined, children: new Map() }
    if (occupant?.kind === "op") {
      problems.push({ kind: "operation-is-group", name: occupant.op.name, path: key })
    } else if (!occupant) {
      parent.children.set(seg, node)
    }
    byPath.set(key, occupant?.kind === "group" ? occupant : node)
    return occupant?.kind === "group" ? occupant : node
  }

  for (const operation of input.operations) {
    if (byName.has(operation.name)) {
      problems.push({ kind: "duplicate-operation", name: operation.name })
      continue
    }
    byName.set(operation.name, operation)
    const parent = ensureGroup(operation.path.slice(0, -1))
    const last = operation.path[operation.path.length - 1] ?? ""
    const occupant = parent.children.get(last)
    if (occupant?.kind === "op") {
      problems.push({ kind: "duplicate-operation", name: operation.name })
    } else if (occupant?.kind === "group") {
      problems.push({ kind: "operation-is-group", name: operation.name, path: occupant.path.join(".") })
    } else {
      parent.children.set(last, { kind: "op", op: operation })
    }
  }

  const implied = [...byPath.keys()].filter((key) => key !== "").sort()
  for (const path of implied) {
    const summary = groups[path]
    const node = byPath.get(path)
    if (!node) continue
    if (summary === undefined) {
      problems.push({ kind: "missing-group-summary", path })
    } else if (summary.trim() === "") {
      problems.push({ kind: "empty-group-summary", path })
    } else {
      node.summary = summary
    }
  }

  for (const key of Object.keys(groups).sort()) {
    if (implied.includes(key)) continue
    if (byName.has(key)) {
      problems.push({ kind: "unused-group-key", key, namesOperation: true })
      continue
    }
    problems.push({ kind: "unused-group-key", key, didYouMean: suggestUnused(key, implied) })
  }

  if (problems.length > 0) {
    const missing = problems.filter((problem) => problem.kind === "missing-group-summary")
    const hint =
      missing.length > 0
        ? `add groups: { ${missing.map((problem) => `"${problem.path}": "..."`).join(", ")} }`
        : hintsFor(problems)[0]
    fail.usage(problems.map(describeProblem).join("; "), {
      hint,
      details: { problems },
    })
  }

  return freeze(root)
}

export function find(tree: CommandTree, tokens: readonly string[]): Found {
  let node: GroupNode = tree
  const at: string[] = []
  for (const token of tokens) {
    const child = node.children.get(token)
    if (!child) {
      const names = [...node.children.keys()]
      const did = suggest(token, names)
      return { kind: "miss", at, token, suggestions: did ? [did] : [] }
    }
    if (child.kind === "op") {
      return { kind: "op", op: child.op, rest: tokens.slice(at.length + 1) }
    }
    at.push(token)
    node = child
  }
  return { kind: "group", node, rest: [] }
}

function freeze(node: Building): GroupNode {
  const children = new Map<string, TreeNode>()
  for (const [seg, child] of [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    children.set(seg, child.kind === "group" ? freeze(child) : child)
  }
  return {
    kind: "group",
    path: node.path,
    summary: node.summary ?? "",
    children,
  }
}

function suggestUnused(key: string, implied: readonly string[]): string | undefined {
  const lastHits = implied.filter((path) => (path.split(".").at(-1) ?? path) === key)
  if (lastHits.length === 1) return lastHits[0]
  if (lastHits.length > 1) return undefined
  return suggest(key, implied)
}

function describeProblem(problem: TreeProblem): string {
  switch (problem.kind) {
    case "duplicate-operation":
      return `duplicate operation "${problem.name}"`
    case "operation-is-group":
      return `"${problem.name}" occupies the same path as group "${problem.path}"`
    case "missing-group-summary":
      return `group "${problem.path}" has no summary`
    case "empty-group-summary":
      return `group "${problem.path}" has an empty summary`
    case "unused-group-key":
      if (problem.namesOperation) return `groups key "${problem.key}" names an operation, not a group`
      return problem.didYouMean
        ? `unknown groups key "${problem.key}". Did you mean "${problem.didYouMean}"?`
        : `unknown groups key "${problem.key}"`
  }
}

function hintsFor(problems: readonly TreeProblem[]): string[] {
  const hints: string[] = []
  for (const problem of problems) {
    const hint = hintFor(problem)
    if (hint && !hints.includes(hint)) hints.push(hint)
  }
  return hints
}

function hintFor(problem: TreeProblem): string | undefined {
  switch (problem.kind) {
    case "duplicate-operation":
      return "operation names must be unique"
    case "operation-is-group":
      return "an operation and a group cannot share a path; rename one"
    case "missing-group-summary":
    case "empty-group-summary":
      return `add groups: { "${problem.path}": "..." }`
    case "unused-group-key":
      if (problem.namesOperation) return "groups keys name prefixes, not operations"
      return problem.didYouMean
        ? `groups keys are full dotted paths; use "${problem.didYouMean}"`
        : "groups keys must match an implied prefix"
  }
}
