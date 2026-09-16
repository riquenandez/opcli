# Rationale — opcli

## Problem

Build a Bun library whose default consumer is an agent harness invoking a POSIX process thousands of times. Sobiecki's policies (clean streams, JSON envelopes, pagination meta, a small exit taxonomy, never blocking on stdin) are usually README rules each command can violate. Existing kits (Rune, Goke, Trails, Commander) treat JSON as a flag on a human parser or explode into platforms. The shape has to make those policies unforgettable without replacing the author's domain schemas.

## Usage (caller's view)

See `README.md`. Authors write `op({ name, summary, input, args?, output, effects, confirm?, examples, run })` where `input`/`output` are their Standard Schema + JSON Schema contracts and `run` returns `Produces<Out>` or throws `fail.*`. `app({...}).main()` is the process. `app.run(argv)` is the in-process test harness. `app.invoke(name, json)` is the executor tests and MCP share.

## Shape

The core type is `Operation`: input contract, five-way `OutputContract` (`data/single|bounded|unbounded`, `stream`, `opaque`), effects, required examples, handler. `Produces<Out>` and injected `PageInput` for unbounded ops are computed from the output contract. `App.invoke` validates input, gates auth and confirmation, runs the handler, validates output, projects `--fields` (checked before the handler). `cli.ts` owns POSIX conventions and is the only stdout writer.

Public surface: `op`, `out`, `fail`, `app`, plus `Ctx` / `Credential` / `Page` / `Contract`, plus `opcli/mcp`. Trace: `cli.ts` → `app.ts` → handler.

## Synthesis decision

Arena base: candidate 1 (opcli / contract-first). Cross-judge agreed. Candidates 2 and 3 failed to type-check their own usage. Candidate 4 (flint) was the stronger artifact on size, but restates `wire` + enum-in-`describe`, which is the help/parser drift the article forbids, and checks `--fields` after the handler (double-delete on mutations).

Grafted from flint: drop `ok()`/`Result`; `fail.*` returns `never`; `internal` → exit 5; `console.*` redirect; type tests; repeated flags are usage errors. From kernel-cli: `confirm` as a function of input; `@-` + confirm is non-interactive. From ucho: cross-op flag-consistency at `app()`; `whoami.via`; `HumanTty | null`.

Rejected: resource DSL, bytes-only `invoke` seam, `arg`/`flag`/`wire` restatement, builtin login/logout.

## Tradeoffs accepted

- We accept requiring Standard JSON Schema emission (Zod 4, Valibot, ArkType, or `withJsonSchema`) in exchange for owning zero schema vocabulary.
- We accept a fixed JSON-Schema → argv mapping (scalars as flags, nested objects via `--input`) in exchange for never describing a flag twice.
- We accept no custom human renderer in exchange for one implementation of every command.
- We accept no short flags in exchange for argv that cannot mean two things.
- We accept keychain-read as a `ProcessIO` slot with a no-op default in exchange for not taking a native dependency in v1.

## Alternatives considered

- **flint's Param record (`arg`/`flag` + `wire`).** Help cannot show enums the validator enforces. Lost on single-source-of-truth.
- **Resource / noun-verb DSL.** Two command trees and a closed filter vocabulary. Own usage did not compile. Lost.
- **POSIX kernel with per-flag `parse`.** Authors restate types; `invoke` returns bytes. Core generic did not infer. Lost.
- **Handlers returning `Result`.** Two failure paths (`return` and `throw`). Dropped in synthesis.

## Open questions and risks

- Is Standard JSON Schema adoption broad enough, or will `withJsonSchema()` become the common path?
- Should `--fields` accept dotted paths in v1 beyond the first segment check?
- How quickly will the agent-env marker list rot, and is "stdout is not a TTY" enough of a fallback?

## Next implementation step

Done: construction, parser, invoke, JSON/human/NDJSON/opaque, pagination injection, pre-handler `--fields`, confirm/`--yes`, `@path`, whoami, help/manifest/skill, in-process `run()`, type tests.
