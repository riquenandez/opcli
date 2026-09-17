export type FailureKind = "user" | "usage" | "auth" | "network" | "internal"
export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5

export const EXIT_CODE = {
  user: 1,
  usage: 2,
  auth: 3,
  network: 4,
  internal: 5,
} as const satisfies Record<FailureKind, Exclude<ExitCode, 0>>

export type Failure = {
  readonly kind: FailureKind
  readonly message: string
  readonly hint?: string
  readonly details?: unknown
}

export class Fail extends Error implements Failure {
  readonly kind: FailureKind
  readonly hint?: string
  readonly details?: unknown

  constructor(failure: Failure) {
    super(failure.message)
    this.name = "Fail"
    this.kind = failure.kind
    this.hint = failure.hint
    this.details = failure.details
  }
}

export function failurePayload(failure: Failure): {
  readonly kind: FailureKind
  readonly message: string
  readonly hint?: string
  readonly details?: unknown
} {
  return {
    kind: failure.kind,
    message: failure.message,
    hint: failure.hint,
    details: failure.details,
  }
}

export function isFail(value: unknown): value is Fail {
  return value instanceof Fail
}

type FailOpts = { readonly hint?: string; readonly details?: unknown }

function raise(kind: Exclude<FailureKind, "internal">, message: string, opts?: FailOpts): never {
  throw new Fail({ kind, message, hint: opts?.hint, details: opts?.details })
}

export const fail = {
  user: (message: string, opts?: FailOpts): never => raise("user", message, opts),
  usage: (message: string, opts?: FailOpts): never => raise("usage", message, opts),
  auth: (message: string, opts?: FailOpts): never => raise("auth", message, opts),
  network: (message: string, opts?: FailOpts): never => raise("network", message, opts),
} as const

export function wantsDebugStacks(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.OPCLI_DEBUG === "1" || env.OPCLI_DEBUG === "true"
}

export function internalFail(
  error: unknown,
  opts?: {
    readonly env?: Readonly<Record<string, string | undefined>>
    readonly debugStacks?: boolean
    readonly hint?: string
  },
): Fail {
  if (isFail(error)) return error
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? error.stack : undefined
  const debug = opts?.debugStacks ?? (opts?.env ? wantsDebugStacks(opts.env) : false)
  return new Fail({
    kind: "internal",
    message,
    hint: opts?.hint ?? "this is a bug in the CLI; rerun with OPCLI_DEBUG=1 for a stack",
    details: debug && stack ? { stack } : undefined,
  })
}
