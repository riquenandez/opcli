import type { Actor } from "./operation.ts"

export const BUILTIN_AGENT_ENV = [
  "CLAUDECODE",
  "CURSOR_AGENT",
  "CODEX_SANDBOX",
  "GEMINI_CLI",
  "OPENCODE",
  "AGENT",
  "OPCLI_AGENT",
] as const

export type HumanTty = {
  readonly prompt: (question: string) => Promise<string>
}

export type Detection = {
  readonly actor: Actor
  readonly human: HumanTty | null
}

export type DetectIO = {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly stdinIsTTY: boolean
  readonly stdoutIsTTY: boolean
  readonly stderrIsTTY: boolean
  prompt?: (question: string) => Promise<string>
}

export function agentEnvPresent(
  env: Readonly<Record<string, string | undefined>>,
  extra: readonly string[] = [],
): boolean {
  return [...BUILTIN_AGENT_ENV, ...extra].some((key) => {
    const value = env[key]
    return value !== undefined && value !== ""
  })
}

export function detect(io: DetectIO, extraAgentEnv: readonly string[] = []): Detection {
  const ci = io.env.CI !== undefined && io.env.CI !== "" && io.env.CI !== "0"
  const agent = agentEnvPresent(io.env, extraAgentEnv)
  let actor: Actor
  if (agent) actor = "agent"
  else if (ci) actor = "ci"
  else if (!io.stdoutIsTTY) actor = "pipe"
  else actor = "human"

  const canPrompt =
    actor === "human" && io.stdinIsTTY && io.stdoutIsTTY && io.stderrIsTTY && io.prompt
  const human: HumanTty | null = canPrompt && io.prompt ? { prompt: io.prompt } : null
  return { actor, human }
}
