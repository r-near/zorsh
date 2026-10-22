import { Equal, Schema, type SchemaAST } from "effect"

/** Private: only this package's constructors write it, through withLayout. */
const key = "@zorsh/effect/borsh/layout"

export type LayoutAnnotation =
  | { readonly kind: "integer"; readonly bits: 8 | 16 | 32 | 64 | 128; readonly signed: boolean }
  | { readonly kind: "float"; readonly bits: 32 | 64 }
  | { readonly kind: "fixedBytes" | "fixedArray"; readonly length: number }
  | {
      readonly kind: "enum"
      readonly tag: string
      readonly discriminants: Readonly<Record<string, number>>
    }

export type EnumAnnotation = Extract<LayoutAnnotation, { readonly kind: "enum" }>

/** The representation id of `Borsh.maxLength`. */
export const maxLengthId = "@zorsh/effect/maxLength"

/** The smallest Borsh.maxLength bound among ast's checks, groups included, if it has any. */
export function maxLengthOf(ast: SchemaAST.AST): number | undefined {
  let smallest: number | undefined
  for (const check of filters(ast.checks ?? [])) {
    const representation = check.annotations?.representation
    if (representation?.id === maxLengthId) {
      const { maxLength } = representation.payload as { readonly maxLength: number }
      smallest = Math.min(smallest ?? maxLength, maxLength)
    }
  }
  return smallest
}

/** Every filter, including those in groups. */
function filters(
  checks: ReadonlyArray<SchemaAST.Check<unknown>>,
): Array<SchemaAST.Filter<unknown>> {
  return checks.flatMap((check) => (check._tag === "FilterGroup" ? filters(check.checks) : [check]))
}

/** Throw if ast carries Borsh.maxLength, for a node whose layout has no length prefix. */
export function rejectMaxLength(ast: SchemaAST.AST, path: string): void {
  if (maxLengthOf(ast) !== undefined) {
    throw new Error(
      `${path}: Borsh.maxLength requires a length-prefixed layout (string, bytes, vector, map or set)`,
    )
  }
}

/** Rust collection and array lengths: a safe integer that fits in a u32. */
export function isU32Length(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff
  )
}

/** A frozen copy of a user's discriminant map, which must assign unique u8 values. */
export function parseDiscriminants(
  map: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  const seen = new Set<number>()
  for (const discriminant of Object.values(map)) {
    if (!isU8(discriminant) || seen.has(discriminant)) {
      throw new Error("$: Borsh enum discriminants must be unique integers from 0 to 255")
    }
    seen.add(discriminant)
  }
  return Object.freeze({ ...map })
}

function isU8(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255
}

export function layoutAnnotation(ast: SchemaAST.AST, path: string): LayoutAnnotation | undefined {
  let found = ast.annotations?.[key] as LayoutAnnotation | undefined
  // Annotating a schema that ends in a filter annotates the filter, as Borsh.U8 does Schema.Int's.
  for (const check of ast.checks ?? []) {
    const next = check.annotations?.[key] as LayoutAnnotation | undefined
    if (next !== undefined) {
      found = merge(found, next, path)
    }
  }
  return found
}

function merge(
  found: LayoutAnnotation | undefined,
  next: LayoutAnnotation,
  path: string,
): LayoutAnnotation {
  if (found !== undefined && !Equal.equals(found, next)) {
    throw new Error(`${path}: Conflicting Borsh layout annotations`)
  }
  return next
}

export function withLayout<S extends Schema.Top>(
  schema: S,
  layout: LayoutAnnotation,
): S["Rebuild"] {
  const merged = merge(layoutAnnotation(Schema.toEncoded(schema).ast, "$"), layout, "$")
  return schema.pipe(Schema.annotateEncoded({ [key]: Object.freeze(merged) }))
}
