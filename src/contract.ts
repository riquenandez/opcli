import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
import { Fail } from "./fail.ts"

export type JsonSchema = Record<string, unknown>

export type Contract<T = unknown> = StandardSchemaV1<unknown, T> & StandardJSONSchemaV1<unknown, T>

export type Infer<C> = C extends StandardSchemaV1<unknown, infer O> ? O : never

const extraJson = new WeakMap<object, JsonSchema>()

export function withJsonSchema<S extends StandardSchemaV1>(
  schema: S,
  jsonSchema: JsonSchema,
): S & StandardJSONSchemaV1 {
  extraJson.set(schema as object, jsonSchema)
  const standard = schema["~standard"] as StandardSchemaV1.Props<unknown, unknown> &
    Partial<StandardJSONSchemaV1.Props<unknown, unknown>>
  if (standard.jsonSchema) return schema as S & StandardJSONSchemaV1
  const converter: StandardJSONSchemaV1.Converter = {
    input: () => jsonSchema,
    output: () => jsonSchema,
  }
  Object.assign(standard, { jsonSchema: converter })
  return schema as S & StandardJSONSchemaV1
}

export function jsonSchemaOf(contract: Contract, side: "input" | "output"): JsonSchema {
  const extra = extraJson.get(contract as object)
  if (extra) return extra
  const converter = (contract["~standard"] as StandardJSONSchemaV1.Props).jsonSchema
  if (!converter) {
    throw new Fail({
      kind: "internal",
      message: "contract does not emit JSON Schema",
      hint: "wrap it with withJsonSchema(schema, json)",
    })
  }
  return converter[side]({ target: "draft-2020-12" })
}

export type FieldType = "string" | "number" | "integer" | "boolean" | "array" | "object" | "null" | "unknown"

export type Field = {
  readonly name: string
  readonly type: FieldType
  readonly items?: FieldType
  readonly enum?: readonly (string | number)[]
  readonly format?: string
  readonly description?: string
  readonly required: boolean
  readonly default?: unknown
  readonly flagBindable: boolean
}

function asType(value: unknown): FieldType {
  if (
    value === "string" ||
    value === "number" ||
    value === "integer" ||
    value === "boolean" ||
    value === "array" ||
    value === "object" ||
    value === "null"
  ) {
    return value
  }
  if (Array.isArray(value) && value.includes("null") && value.length === 2) {
    const other = value.find((item) => item !== "null")
    return asType(other)
  }
  return "unknown"
}

function unwrap(schema: JsonSchema): JsonSchema {
  if (Array.isArray(schema.anyOf)) {
    const nonNull = schema.anyOf.filter(
      (item): item is JsonSchema =>
        typeof item === "object" && item !== null && (item as JsonSchema).type !== "null",
    )
    if (nonNull.length === 1 && nonNull[0]) return unwrap(nonNull[0])
  }
  return schema
}

export function fieldsOf(contract: Contract, side: "input" | "output"): readonly Field[] {
  const schema = unwrap(jsonSchemaOf(contract, side))
  const properties = schema.properties
  if (!properties || typeof properties !== "object") return []
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : [])
  return Object.entries(properties as Record<string, JsonSchema>).map(([name, raw]) => {
    const prop = unwrap(raw)
    const type = asType(prop.type)
    const itemsSchema = prop.items
    const items =
      itemsSchema && typeof itemsSchema === "object"
        ? asType((itemsSchema as JsonSchema).type)
        : undefined
    const enumValues = Array.isArray(prop.enum)
      ? prop.enum.filter((item): item is string | number => typeof item === "string" || typeof item === "number")
      : undefined
    const flagBindable =
      type === "string" ||
      type === "number" ||
      type === "integer" ||
      type === "boolean" ||
      (type === "array" && items !== "object" && items !== "array")
    return {
      name,
      type,
      items,
      enum: enumValues && enumValues.length > 0 ? enumValues : undefined,
      format: typeof prop.format === "string" ? prop.format : undefined,
      description: typeof prop.description === "string" ? prop.description : undefined,
      required: required.has(name),
      default: prop.default,
      flagBindable,
    }
  })
}

export async function validate<T>(contract: Contract<T>, value: unknown): Promise<T> {
  const result = await contract["~standard"].validate(value)
  if (result.issues) {
    throw new Fail({
      kind: "usage",
      message: result.issues.map((issue) => issue.message).join("; "),
      hint: "fix the flagged inputs and retry",
      details: {
        issues: result.issues.map((issue) => ({
          path: issue.path?.map((segment) => (typeof segment === "object" ? String(segment.key) : String(segment))),
          message: issue.message,
        })),
      },
    })
  }
  return result.value
}

export function passthrough<T>(schema: JsonSchema): Contract<T> {
  const converter: StandardJSONSchemaV1.Converter = {
    input: () => schema,
    output: () => schema,
  }
  return {
    "~standard": {
      version: 1,
      vendor: "opcli",
      validate: (value) => ({ value: value as T }),
      jsonSchema: converter,
    },
  }
}

export function schemaFingerprint(contract: Contract, name: string): string {
  const field = fieldsOf(contract, "input").find((item) => item.name === name)
  if (!field) return ""
  return JSON.stringify({
    type: field.type,
    items: field.items,
    enum: field.enum,
    format: field.format,
  })
}
