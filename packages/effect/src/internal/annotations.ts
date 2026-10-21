import { Schema, type SchemaAST } from "effect"

const key = "@zorsh/effect/borsh/layout"

type LayoutDescriptor =
  | {
      readonly version: 1
      readonly kind: "integer"
      readonly bits: 8 | 16 | 32 | 64 | 128
      readonly signed: boolean
    }
  | { readonly version: 1; readonly kind: "float"; readonly bits: 32 | 64 }
  | { readonly version: 1; readonly kind: "fixedBytes"; readonly length: number }
  | {
      readonly version: 1
      readonly kind: "enum"
      readonly tag: string
      readonly discriminants: Readonly<Record<string, number>>
    }

declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      readonly "@zorsh/effect/borsh/layout"?: LayoutDescriptor | undefined
    }
  }
}

function parseDescriptor(value: LayoutDescriptor): LayoutDescriptor
function parseDescriptor(value: unknown): LayoutDescriptor | undefined
function parseDescriptor(value: unknown): LayoutDescriptor | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("kind" in value)
  ) {
    throw new Error("$: Invalid Borsh layout annotation")
  }
  switch (value.kind) {
    case "integer":
      if (
        "bits" in value &&
        (value.bits === 8 ||
          value.bits === 16 ||
          value.bits === 32 ||
          value.bits === 64 ||
          value.bits === 128) &&
        "signed" in value &&
        typeof value.signed === "boolean"
      ) {
        return Object.freeze({
          version: 1,
          kind: "integer",
          bits: value.bits,
          signed: value.signed,
        })
      }
      break
    case "float":
      if ("bits" in value && (value.bits === 32 || value.bits === 64)) {
        return Object.freeze({ version: 1, kind: "float", bits: value.bits })
      }
      break
    case "fixedBytes":
      if (
        "length" in value &&
        typeof value.length === "number" &&
        Number.isSafeInteger(value.length) &&
        value.length >= 0 &&
        value.length <= 0xffff_ffff
      ) {
        return Object.freeze({ version: 1, kind: "fixedBytes", length: value.length })
      }
      break
    case "enum":
      if (
        "tag" in value &&
        typeof value.tag === "string" &&
        "discriminants" in value &&
        typeof value.discriminants === "object" &&
        value.discriminants !== null &&
        !Array.isArray(value.discriminants)
      ) {
        const entries = Object.entries(value.discriminants).sort(([a], [b]) => (a < b ? -1 : 1))
        const tags = new Set<number>()
        for (const [, tag] of entries) {
          if (
            typeof tag !== "number" ||
            !Number.isInteger(tag) ||
            tag < 0 ||
            tag > 255 ||
            tags.has(tag)
          )
            throw new Error("$: Invalid Borsh enum discriminants")
          tags.add(tag)
        }
        return Object.freeze({
          version: 1,
          kind: "enum",
          tag: value.tag,
          discriminants: Object.freeze(Object.fromEntries(entries)),
        })
      }
  }
  throw new Error("$: Invalid Borsh layout annotation")
}

export function descriptor(ast: SchemaAST.AST): LayoutDescriptor | undefined {
  let found = parseDescriptor(ast.annotations?.[key])
  const checks = [...(ast.checks ?? [])]
  for (let check = checks.pop(); check !== undefined; check = checks.pop()) {
    const next = parseDescriptor(check.annotations?.[key])
    if (next !== undefined) {
      if (found !== undefined && JSON.stringify(found) !== JSON.stringify(next)) {
        throw new Error("$: Conflicting Borsh layout annotations")
      }
      found = next
    }
    if (check._tag === "FilterGroup") checks.push(...check.checks)
  }
  return found
}

export function withLayout<S extends Schema.Top>(
  schema: S,
  layout: LayoutDescriptor,
): S["Rebuild"] {
  layout = parseDescriptor(layout)
  const existing = descriptor(Schema.toEncoded(schema).ast)
  if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(layout)) {
    throw new Error("$: Conflicting Borsh layout annotations")
  }
  return schema.pipe(Schema.annotateEncoded({ [key]: Object.freeze(layout) }))
}
