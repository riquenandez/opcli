import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

type RunResult = {
  readonly stdout: string
  readonly stderr: string
  readonly exit: number
}

function run(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd ?? repoRoot,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", (code) => {
      resolve({ stdout, stderr, exit: code ?? 1 })
    })
    child.stdin.end(opts.stdin ?? "")
  })
}

function walkFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(path))
    else out.push(path)
  }
  return out
}

function rewriteDtsExtensions(dir: string): void {
  const relativeTs = /(["'])(\.[^"']+)\.tsx?\1/g
  for (const file of walkFiles(dir)) {
    if (!file.endsWith(".d.ts")) continue
    const text = readFileSync(file, "utf8")
    const next = text.replace(relativeTs, "$1$2.js$1")
    if (next !== text) writeFileSync(file, next)
  }
}

function assertDistClean(): string[] {
  const failures: string[] = []
  const dist = join(repoRoot, "dist")
  const files = walkFiles(dist).filter((path) => path.endsWith(".js") || path.endsWith(".d.ts"))
  const tsImport = /["']\.[^"']*\.tsx?["']/
  for (const file of files) {
    const text = readFileSync(file, "utf8")
    if (text.includes("Bun.")) failures.push(`${file} contains Bun.`)
    if (tsImport.test(text)) failures.push(`${file} has a relative .ts import`)
  }
  if (files.length === 0) failures.push("dist has no .js or .d.ts files")
  return failures
}

function smokeEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.DEMO_TOKEN
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

const appSource = `import { app, op, out } from "opcli"
import { z } from "zod"

const say = op({
  name: "say",
  summary: "Echo a string",
  input: z.object({ text: z.string() }),
  args: ["text"],
  output: out.single(z.string()),
  effects: "read_only",
  run({ text }) {
    return text
  },
})

const cli = app({
  name: "smoke",
  version: "0.0.0",
  summary: "Node host smoke",
  auth: { env: "DEMO_TOKEN" },
  operations: [say],
})

if (import.meta.main !== false) process.exit(await cli.main())
`

type Case = {
  readonly name: string
  readonly args: readonly string[]
  readonly stdin?: string
  readonly env: Record<string, string | undefined>
  readonly expectExit: number
}

async function main(): Promise<void> {
  if (process.argv.includes("--rewrite-dts")) {
    rewriteDtsExtensions(join(repoRoot, "dist"))
    return
  }

  const pack = await run("bun", ["pm", "pack"])
  if (pack.exit !== 0) {
    console.error("FAIL pack")
    console.error(pack.stderr || pack.stdout)
    process.exit(1)
  }

  const distFailures = assertDistClean()
  if (distFailures.length > 0) {
    for (const failure of distFailures) console.error(`FAIL dist ${failure}`)
    process.exit(1)
  }
  console.log("PASS dist no Bun. and no relative .ts imports")

  const tarball = readdirSync(repoRoot)
    .filter((name) => name.startsWith("opcli-") && name.endsWith(".tgz"))
    .map((name) => join(repoRoot, name))[0]
  if (!tarball) {
    console.error("FAIL pack produced no opcli tarball")
    process.exit(1)
  }

  const tmp = mkdtempSync(join(tmpdir(), "opcli-smoke-"))
  const xdg = join(tmp, "xdg")
  const fixture = join(tmp, "fixture.txt")
  const missing = join(tmp, "missing.txt")
  const appFile = join(tmp, "app.mjs")
  mkdirSync(join(xdg, "demo"), { recursive: true })
  writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "smoke-app", type: "module", private: true }))
  writeFileSync(fixture, "from-file")
  writeFileSync(appFile, appSource)

  const install = await run("bun", ["install", tarball, "zod"], { cwd: tmp })
  if (install.exit !== 0) {
    console.error("FAIL install")
    console.error(install.stderr || install.stdout)
    rmSync(tmp, { recursive: true, force: true })
    process.exit(1)
  }

  const tokenEnv = { DEMO_TOKEN: "t_smoke", XDG_CONFIG_HOME: xdg }
  const noTokenEnv = { DEMO_TOKEN: undefined, XDG_CONFIG_HOME: xdg }
  const cases: Case[] = [
    { name: "help", args: ["--help"], env: tokenEnv, expectExit: 0 },
    { name: "at-absolute-file", args: ["say", `@${fixture}`, "--json"], env: tokenEnv, expectExit: 0 },
    { name: "at-stdin", args: ["say", "@-", "--json"], stdin: "from-stdin", env: tokenEnv, expectExit: 0 },
    { name: "at-stdin-empty", args: ["say", "@-", "--json"], stdin: "", env: tokenEnv, expectExit: 0 },
    { name: "at-absolute-missing", args: ["say", `@${missing}`, "--json"], env: tokenEnv, expectExit: 2 },
    { name: "auth-config", args: ["say", "ok", "--json"], env: noTokenEnv, expectExit: 0 },
    { name: "auth-missing", args: ["say", "ok", "--json"], env: noTokenEnv, expectExit: 3 },
  ]

  let failed = false
  try {
    for (const testCase of cases) {
      if (testCase.name === "auth-config") {
        writeFileSync(join(xdg, "demo", "config.json"), JSON.stringify({ token: "t_cfg" }))
      }
      if (testCase.name === "auth-missing") {
        rmSync(join(xdg, "demo", "config.json"), { force: true })
      }

      const env = smokeEnv(testCase.env)
      const node = await run("node", [appFile, ...testCase.args], { env, stdin: testCase.stdin })
      const bun = await run("bun", [appFile, ...testCase.args], { env, stdin: testCase.stdin })
      const same =
        node.exit === bun.exit && node.stdout === bun.stdout && node.stderr === bun.stderr
      const ok = same && node.exit === testCase.expectExit
      const line =
        `${ok ? "PASS" : "FAIL"} ${testCase.name} node_exit=${node.exit} bun_exit=${bun.exit}` +
        ` stdout=${node.stdout === bun.stdout ? "eq" : "diff"} stderr=${node.stderr === bun.stderr ? "eq" : "diff"}`
      console.log(line)
      if (!ok) {
        failed = true
        if (!same) {
          console.error(`  node stdout: ${JSON.stringify(node.stdout)}`)
          console.error(`  bun  stdout: ${JSON.stringify(bun.stdout)}`)
          console.error(`  node stderr: ${JSON.stringify(node.stderr)}`)
          console.error(`  bun  stderr: ${JSON.stringify(bun.stderr)}`)
        }
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
    rmSync(tarball, { force: true })
  }

  if (failed) process.exit(1)
}

await main()
