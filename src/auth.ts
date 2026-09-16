import { passthrough } from "./contract.ts"
import type { Credential } from "./operation.ts"

export type AuthSpec = {
  readonly env: string
  readonly flag?: string
  readonly configPath?: string
  readonly keychain?: { readonly service: string; readonly account?: string }
}

export type AuthIO = {
  readonly env: Readonly<Record<string, string | undefined>>
  readFile(path: string): Promise<string>
  readonly keychain: {
    get(service: string, account: string): Promise<string | null>
  }
  warn?(message: string): void
}

export async function resolveCredential(
  spec: AuthSpec | undefined,
  flagValue: string | undefined,
  io: AuthIO,
): Promise<Credential | null> {
  if (!spec) return null
  if (flagValue) {
    return { token: flagValue, source: "flag", via: `--${spec.flag ?? "token"}` }
  }
  const envValue = io.env[spec.env]
  if (envValue) return { token: envValue, source: "env", via: spec.env }
  const configPath = spec.configPath ?? defaultConfigPath(io, spec)
  if (configPath) {
    try {
      const text = await io.readFile(configPath)
      const parsed: unknown = JSON.parse(text)
      if (parsed && typeof parsed === "object" && "token" in parsed) {
        const token = (parsed as { token: unknown }).token
        if (typeof token === "string" && token.length > 0) {
          return { token, source: "config", via: configPath }
        }
      }
    } catch {
      // absent config is not an error
    }
  }
  if (spec.keychain) {
    try {
      const token = await io.keychain.get(spec.keychain.service, spec.keychain.account ?? "token")
      if (token) {
        return {
          token,
          source: "keychain",
          via: `keychain:${spec.keychain.service}`,
        }
      }
    } catch {
      io.warn?.(`keychain read failed for ${spec.keychain.service}; skipping`)
    }
  }
  return null
}

function defaultConfigPath(io: AuthIO, spec: AuthSpec): string | undefined {
  const name = spec.env.toLowerCase().replace(/_token$/, "").replaceAll("_", "-")
  const xdg = io.env.XDG_CONFIG_HOME
  const home = io.env.HOME
  if (xdg) return `${xdg}/${name}/config.json`
  if (home) return `${home}/.config/${name}/config.json`
  return undefined
}

export const Whoami = passthrough<{
  source: string | null
  via: string | null
  tokenPrefix: string | null
  actor: string
}>({
  type: "object",
  properties: {
    source: { type: ["string", "null"] },
    via: { type: ["string", "null"] },
    tokenPrefix: { type: ["string", "null"] },
    actor: { type: "string" },
  },
  required: ["source", "via", "tokenPrefix", "actor"],
})

export function tokenPrefix(token: string): string {
  if (token.length <= 4) return "****"
  return `${token.slice(0, 2)}…${token.slice(-2)}`
}
