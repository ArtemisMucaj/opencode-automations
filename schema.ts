// The tools' input schemas: the TypeScript type each one describes, and a check that an input matches it.
// opencode hands a tool defined with a JSON schema its input unchecked, so `tool` checks it before the tool runs.

import type { ToolEditor } from "./types.ts"
import { text } from "./util.ts"

/** The part of JSON Schema the tools use. */
export interface JsonSchema {
  readonly type?: "string" | "number" | "integer" | "boolean" | "array" | "object"
  readonly description?: string
  readonly enum?: readonly string[]
  readonly items?: JsonSchema
  readonly properties?: { readonly [key: string]: JsonSchema }
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean | JsonSchema
}

/** The value a schema describes. */
export type Infer<S> =
  S extends { readonly enum: readonly (infer E)[] } ? E :
  S extends { readonly type: "string" } ? string :
  S extends { readonly type: "number" | "integer" } ? number :
  S extends { readonly type: "boolean" } ? boolean :
  S extends { readonly type: "array"; readonly items: infer I } ? Infer<I>[] :
  S extends { readonly type: "object"; readonly properties: infer P } ?
    Fields<P, S extends { readonly required: readonly (infer R)[] } ? R : never> :
  S extends { readonly type: "object"; readonly additionalProperties: infer A extends JsonSchema } ? { [key: string]: Infer<A> } :
  S extends { readonly type: "object" } ? { [key: string]: unknown } :
  unknown

type Fields<P, R> = Flat<{ [K in keyof P & R]: Infer<P[K]> } & { [K in Exclude<keyof P, R>]?: Infer<P[K]> }>
type Flat<T> = { [K in keyof T]: T[K] }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Whether `value` matches `schema`; what doesn't goes in `errors`. A null optional field is taken as left out
 * (and removed), since models often send one; a null value in a free-form map (no declared field) is kept.
 */
function valid<S extends JsonSchema>(schema: S, value: unknown, errors: string[], path = "input"): value is Infer<S> {
  const before = errors.length
  // A string, checked by its type below, else one of the values: one error for one wrong value.
  if (schema.enum && typeof value === "string" && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.join(", ")}`)
  }
  switch (schema.type) {
    case "string":
      if (typeof value !== "string") errors.push(`${path} must be a string`)
      break
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) errors.push(`${path} must be a number`)
      break
    case "integer":
      if (!Number.isInteger(value)) errors.push(`${path} must be an integer`)
      break
    case "boolean":
      if (typeof value !== "boolean") errors.push(`${path} must be true or false`)
      break
    case "array": {
      const items = schema.items
      if (!Array.isArray(value)) errors.push(`${path} must be an array`)
      else if (items) value.forEach((item, i) => valid(items, item, errors, `${path}[${i}]`))
      break
    }
    case "object": {
      if (!isRecord(value)) { errors.push(`${path} must be an object`); break }
      const props = schema.properties ?? {}
      const required = new Set(schema.required ?? [])
      for (const [key, v] of Object.entries(value)) {
        if (v === null && key in props && !required.has(key)) { delete value[key]; continue }
        const prop = props[key] ?? (typeof schema.additionalProperties === "object" ? schema.additionalProperties : undefined)
        if (prop) valid(prop, v, errors, `${path}.${key}`)
        else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not a field`)
      }
      for (const key of required) if (value[key] === undefined) errors.push(`${path}.${key} is required`)
      break
    }
  }
  return errors.length === before
}

type ToolDef = Parameters<ToolEditor["add"]>[0]
type ToolContext = Parameters<ToolDef["execute"]>[1]

/**
 * A tool whose `execute` gets its input typed from the `input` schema. Input that doesn't match the schema
 * gets an error back, and `execute` doesn't run.
 */
export function tool<const S extends JsonSchema>(
  def: Omit<ToolDef, "input" | "execute"> & {
    input: S
    execute: (input: Infer<S>, tc: ToolContext) => Promise<{ content: string }>
  },
) {
  return {
    ...def,
    execute: async (value: unknown, tc: ToolContext) => {
      const errors: string[] = []
      // A tool called with no arguments may get no input at all.
      const input = value ?? (def.input.type === "object" ? {} : value)
      return valid(def.input, input, errors) ? def.execute(input, tc) : text(`error: ${errors.join("; ")}. Nothing was done.`)
    },
  }
}
