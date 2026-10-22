import { SchemaAST } from "effect"
import { descriptor, type EnumDescriptor } from "./annotations.js"
import type { Compile, Layout } from "./compiler.js"
import { compileObject, defineField } from "./containers.js"
import { BinaryError, prepend, type Reader } from "./io.js"

interface EnumVariant {
  readonly label: string
  readonly discriminant: number
  readonly value?: unknown
  readonly member?: SchemaAST.Objects
}

/** Read Rust enum variants with declaration-order or explicit discriminants. */
export function enumVariants(
  ast: SchemaAST.AST,
  layout: EnumDescriptor | undefined,
  path: string,
): ReadonlyArray<EnumVariant> {
  const tag = layout === undefined ? "_tag" : layout.tag
  const explicit =
    "pass the Rust wire discriminants (declaration indices unless #[borsh(use_discriminant = true)]) to Borsh.discriminants"
  const objects =
    ast._tag === "Union" && ast.types.length > 0 && ast.types.every(SchemaAST.isObjects)
  const required = (member: SchemaAST.AST) => {
    if (member.context?.isOptional || descriptor(member, path) !== undefined) {
      throw new Error(`${path}: Enum variants must be required and have no layout annotations`)
    }
  }
  let variants: ReadonlyArray<Omit<EnumVariant, "discriminant">>
  if (objects) {
    variants = ast.types.map((member) => {
      required(member)
      const field = member.propertySignatures.find((field) => field.name === tag)?.type
      if (
        field?._tag !== "Literal" ||
        typeof field.literal !== "string" ||
        field.context?.isOptional
      ) {
        throw new Error(
          `${path}: Enum tag ${JSON.stringify(tag)} must be a required string literal; set another key with Borsh.discriminants(map, { tag })`,
        )
      }
      return { label: field.literal, member }
    })
  } else if (ast._tag === "Union" && ast.types.every(SchemaAST.isLiteral)) {
    variants = ast.types.map((member) => {
      required(member)
      return { label: String(member.literal), value: member.literal }
    })
    if (layout === undefined && variants.some((variant) => typeof variant.value !== "string")) {
      throw new Error(`${path}: Non-string literal enums have no Rust variant order; ${explicit}`)
    }
  } else if (ast._tag === "Enum") {
    variants = ast.enums.map(([label, value]) => ({ label, value }))
    if (new Set(variants.map((variant) => typeof variant.value)).size > 1) {
      throw new Error(`${path}: Mixed string and numeric enums are unsupported`)
    }
    if (new Set(variants.map((variant) => variant.value)).size !== variants.length) {
      throw new Error(`${path}: Duplicate enum values have no Borsh layout`)
    }
    if (
      layout === undefined &&
      variants.some((variant, i) => typeof variant.value === "number" && variant.value !== i)
    ) {
      throw new Error(
        `${path}: Numeric enum values must be 0..n-1 in declaration order; ${explicit}`,
      )
    }
  } else if (ast._tag === "Union" && layout === undefined) {
    throw new Error(
      `${path}: Union has no Borsh layout; use Schema.Option for nullable values, or a tagged union, Schema.Literals or Schema.Enum for Rust enums`,
    )
  } else {
    throw new Error(`${path}: Enum layout requires a tagged union, literal union or Schema.Enum`)
  }
  if (variants.length < 1 || variants.length > 256) {
    throw new Error(`${path}: Enums require 1 through 256 variants`)
  }
  if (!objects && tag !== "_tag") {
    throw new Error(`${path}: Only object enum variants have a tag key`)
  }
  const labels = new Set<string>()
  for (const { label } of variants) {
    if (labels.has(label)) {
      throw new Error(`${path}: Duplicate enum label ${label}`)
    }
    labels.add(label)
  }
  if (layout === undefined) {
    return variants.map((variant, discriminant) => ({ ...variant, discriminant }))
  }
  const discriminants = new Map(Object.entries(layout.discriminants))
  const extra = [...discriminants.keys()].filter((label) => !labels.has(label))
  if (extra.length > 0) {
    throw new Error(`${path}: Unknown enum discriminants ${extra.join(", ")}`)
  }
  return variants.map((variant) => {
    const discriminant = discriminants.get(variant.label)
    if (discriminant === undefined) {
      throw new Error(`${path}: Missing enum discriminant for ${variant.label}`)
    }
    return { ...variant, discriminant }
  })
}

export function compileEnum(
  ast: SchemaAST.AST,
  layout: EnumDescriptor | undefined,
  path: string,
  compile: Compile,
): Layout {
  const tag = layout === undefined ? "_tag" : layout.tag
  const variants = enumVariants(ast, layout, path)
  const select = <V extends EnumVariant>(variants: ReadonlyArray<V>) => {
    const byDiscriminant = new Map(variants.map((variant) => [variant.discriminant, variant]))
    return (r: Reader) => {
      const offset = r.offset
      const discriminant = r.u8()
      const variant = byDiscriminant.get(discriminant)
      if (variant === undefined) {
        throw new BinaryError(offset, `Invalid enum tag ${discriminant}`)
      }
      return variant
    }
  }
  const objects = variants.flatMap(({ member, ...variant }) =>
    member === undefined
      ? []
      : [{ ...variant, payload: compileObject(member, path, compile, tag) }],
  )
  // A default-discriminant enum with one dataless variant is a Rust ZST; explicit maps imply repr(u8).
  const isZeroSized =
    layout === undefined &&
    variants.length === 1 &&
    objects.every((variant) => variant.payload.isZeroSized)
  if (objects.length === 0) {
    const read = select(variants)
    const byValue = new Map(variants.map((variant) => [variant.value, variant.discriminant]))
    return {
      minBytes: 1,
      isZeroSized,
      read: (r) => read(r).value,
      write: (w, value) => {
        const discriminant = byValue.get(value)
        if (discriminant === undefined) {
          throw new BinaryError(w.offset, "Invalid enum value")
        }
        w.u8(discriminant)
      },
    }
  }
  const read = select(objects)
  const byLabel = new Map(objects.map((variant) => [variant.label, variant]))
  // As for struct fields, assignment would hit an inherited setter or a frozen inherited property.
  const define = tag in Object.prototype
  return {
    minBytes: 1 + Math.min(...objects.map((variant) => variant.payload.minBytes)),
    isZeroSized,
    read: (r) => {
      const variant = read(r)
      const value = variant.payload.read(r) as Record<string, unknown>
      if (define) {
        defineField(value, tag, variant.label)
      } else {
        value[tag] = variant.label
      }
      return value
    },
    write: (w, value) => {
      if (typeof value !== "object" || value === null) {
        throw new BinaryError(w.offset, "Expected enum object")
      }
      const label = Object.hasOwn(value, tag) ? Reflect.get(value, tag) : undefined
      const variant = typeof label === "string" ? byLabel.get(label) : undefined
      if (variant === undefined) {
        throw prepend(new BinaryError(w.offset, "Invalid enum label"), tag)
      }
      w.u8(variant.discriminant)
      variant.payload.write(w, value)
    },
  }
}
