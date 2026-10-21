import { Schema, type SchemaAST } from "effect"

const key = "@zorsh/effect/borsh/layout"

export type LayoutDescriptor =
  | {
      readonly version: 1
      readonly kind: "integer"
      readonly bits: 8 | 16 | 32 | 64 | 128
      readonly signed: boolean
    }
  | { readonly version: 1; readonly kind: "float"; readonly bits: 32 | 64 }
  | { readonly version: 1; readonly kind: "fixedBytes" | "fixedArray"; readonly length: number }
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

export type EnumDescriptor = Extract<LayoutDescriptor, { readonly kind: "enum" }>

/** Rust collection and array lengths: a safe integer that fits in a u32. */
export function isU32Length(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff
  )
}

export function parseDescriptor<D extends LayoutDescriptor>(value: D): D
export function parseDescriptor(value: unknown, path: string): LayoutDescriptor | undefined
export function parseDescriptor(value: unknown, path = "$"): LayoutDescriptor | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("kind" in value)
  ) {
    throw new Error(`${path}: Invalid Borsh layout annotation`)
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
    case "fixedArray":
      if ("length" in value && isU32Length(value.length)) {
        return Object.freeze({ version: 1, kind: value.kind, length: value.length })
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
            throw new Error(
              `${path}: Borsh enum discriminants must be unique integers from 0 to 255`,
            )
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
  throw new Error(`${path}: Invalid Borsh layout annotation`)
}

export function descriptor(ast: SchemaAST.AST, path = "$"): LayoutDescriptor | undefined {
  let found = parseDescriptor(ast.annotations?.[key], path)
  const checks = [...(ast.checks ?? [])]
  for (let check = checks.pop(); check !== undefined; check = checks.pop()) {
    const next = parseDescriptor(check.annotations?.[key], path)
    if (next !== undefined) found = merge(found, next, path)
    if (check._tag === "FilterGroup") checks.push(...check.checks)
  }
  return found
}

function merge(
  found: LayoutDescriptor | undefined,
  next: LayoutDescriptor,
  path: string,
): LayoutDescriptor {
  if (found !== undefined && JSON.stringify(found) !== JSON.stringify(next))
    throw new Error(`${path}: Conflicting Borsh layout annotations`)
  return next
}

export function withLayout<S extends Schema.Top>(
  schema: S,
  layout: LayoutDescriptor,
): S["Rebuild"] {
  layout = parseDescriptor(layout)
  merge(descriptor(Schema.toEncoded(schema).ast), layout, "$")
  return schema.pipe(Schema.annotateEncoded({ [key]: Object.freeze(layout) }))
}
