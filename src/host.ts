import { readFile as readUtf8File } from "node:fs/promises"

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

export async function readAllFrom(source: AsyncIterable<Uint8Array | string>): Promise<string> {
  let buf = ""
  const decoder = new TextDecoder()
  for await (const chunk of source) {
    buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
  }
  return buf + decoder.decode()
}

export function processIO(): ProcessIO {
  const env = process.env
  return {
    argv: process.argv,
    env,
    cwd: process.cwd(),
    stdin: {
      isTTY: Boolean(process.stdin.isTTY),
      text: async () => readAllFrom(process.stdin),
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
    readFile: async (path) => readUtf8File(path, "utf8"),
    keychain: {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
    },
  }
}
