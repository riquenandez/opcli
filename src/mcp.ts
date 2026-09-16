import type { App } from "./app.ts"
import type { Runtime } from "./app.ts"
import { failurePayload } from "./fail.ts"
import type { JsonSchema } from "./contract.ts"

export type McpToolDef = {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonSchema
  readonly outputSchema?: JsonSchema
  readonly annotations: {
    readonly readOnlyHint: boolean
    readonly destructiveHint: boolean
    readonly idempotentHint: boolean
  }
}

export type McpToolResult =
  | {
      readonly isError: false
      readonly content: readonly ({ type: "text"; text: string } | { type: "resource"; mimeType: string; blob: string })[]
      readonly structuredContent?: unknown
    }
  | {
      readonly isError: true
      readonly content: readonly [{ type: "text"; text: string }]
      readonly structuredContent: { error: ReturnType<typeof failurePayload> }
    }

function frameworkInput(schema: JsonSchema, extras: Record<string, JsonSchema>): JsonSchema {
  const properties =
    schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? { ...(schema.properties as Record<string, JsonSchema>) }
      : {}
  return { ...schema, properties: { ...properties, ...extras } }
}

export function mcpTools(app: App): readonly McpToolDef[] {
  return app.manifest().operations.map((operation) => {
    const extras: Record<string, JsonSchema> = {}
    if (operation.confirm) extras.yes = { type: "boolean" }
    if (operation.output.kind === "data" && operation.output.cardinality === "unbounded") {
      extras.limit = { type: "integer", minimum: 1 }
      extras.cursor = { type: "string" }
    }
    return {
      name: operation.name.replaceAll(".", "_"),
      description: operation.summary,
      inputSchema: Object.keys(extras).length > 0 ? frameworkInput(operation.input, extras) : operation.input,
      outputSchema: operation.output.kind === "opaque" ? undefined : operation.output.schema,
      annotations: {
        readOnlyHint: operation.effects === "read_only",
        destructiveHint: operation.confirm,
        idempotentHint: operation.effects !== "non_idempotent",
      },
    }
  })
}

export async function mcpCall(
  app: App,
  toolName: string,
  args: unknown,
  runtime: Runtime,
): Promise<McpToolResult> {
  const name = toolName.replaceAll("_", ".")
  const yes = Boolean(args && typeof args === "object" && "yes" in (args as object) && (args as { yes?: boolean }).yes)
  const outcome = await app.invoke(name, args, { ...runtime, confirmed: runtime.confirmed || yes })
  if (outcome.kind === "failure") {
    return {
      isError: true,
      content: [{ type: "text", text: outcome.failure.message }],
      structuredContent: { error: failurePayload(outcome.failure) },
    }
  }
  if (outcome.kind === "opaque") {
    return {
      isError: false,
      content: [{ type: "text", text: `opaque ${outcome.mediaType}` }],
    }
  }
  if (outcome.kind === "stream") {
    const items: unknown[] = []
    for await (const item of outcome.items) {
      items.push(item)
      if (items.length >= app.pagination.maxLimit) break
    }
    return {
      isError: false,
      content: [{ type: "text", text: JSON.stringify(items) }],
      structuredContent: { data: items, meta: { truncated: items.length >= app.pagination.maxLimit } },
    }
  }
  return {
    isError: false,
    content: [{ type: "text", text: JSON.stringify({ data: outcome.value, meta: outcome.meta }) }],
    structuredContent: { data: outcome.value, meta: outcome.meta },
  }
}
