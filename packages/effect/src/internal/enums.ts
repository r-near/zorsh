import { SchemaAST } from "effect"
import { descriptor, type EnumDescriptor, rejectMaxLength } from "./annotations.js"
import type { Compile, Layout } from "./compiler.js"
import { compileObject, defineField } from "./containers.js"
import { BinaryError, prepend, type Reader } from "./io.js"

interface EnumVariant {
  readonly label: string
  readonly discriminant: number
  readonly value?: unknown
  readonly member?: SchemaAST.Objects
}

type UnnumberedVariant = Omit<EnumVariant, "discriminant">

interface ObjectVariant extends Omit<EnumVariant, "member"> {
  readonly payload: Layout
}

const explicitDiscriminantsHint =
  "pass the Rust wire discriminants (declaration indices unless #[borsh(use_discriminant = true)]) to Borsh.discriminants"

/** Read Rust enum variants with declaration-order or explicit discriminants. */
export function enumVariants(
  ast: SchemaAST.AST,
  layout: EnumDescriptor | undefined,
  path: string,
): ReadonlyArray<EnumVariant> {
  const tag = layout === undefined ? "_tag" : layout.tag
  const isTaggedUnion =
    ast._tag === "Union" && ast.types.length > 0 && ast.types.every(SchemaAST.isObjects)
  let variants: ReadonlyArray<UnnumberedVariant>
  if (isTaggedUnion) {
    variants = taggedVariants(ast.types, tag, path)
  } else if (ast._tag === "Union" && ast.types.every(SchemaAST.isLiteral)) {
    variants = literalVariants(ast.types, layout, path)
  } else if (ast._tag === "Enum") {
    variants = tsEnumVariants(ast, layout, path)
  } else if (ast._tag === "Union" && layout === undefined) {
    throw new Error(
      `${path}: Union has no Borsh layout; use Schema.Option for nullable values, or a tagged union, Schema.Literals or Schema.Enum for Rust enums`,
    )
  } else {
    throw new Error(`${path}: Enum layout requires a tagged union, literal union or Schema.Enum`)
  }
  // Borsh writes the discriminant as a u8.
  if (variants.length < 1 || variants.length > 256) {
    throw new Error(`${path}: Enums require 1 through 256 variants`)
  }
  if (!isTaggedUnion && tag !== "_tag") {
    throw new Error(`${path}: Only object enum variants have a tag key`)
  }
  const labels = uniqueLabels(variants, path)
  if (layout === undefined) {
    return variants.map((variant, discriminant) => ({ ...variant, discriminant }))
  }
  return withDiscriminants(variants, labels, layout.discriminants, path)
}

function taggedVariants(
  members: ReadonlyArray<SchemaAST.Objects>,
  tag: string,
  path: string,
): ReadonlyArray<UnnumberedVariant> {
  return members.map((member) => {
    assertPlainVariant(member, path)
    const tagType = member.propertySignatures.find((field) => field.name === tag)?.type
    const isRequiredString =
      tagType?._tag === "Literal" &&
      typeof tagType.literal === "string" &&
      !tagType.context?.isOptional
    if (!isRequiredString) {
      throw new Error(
        `${path}: Enum tag ${JSON.stringify(tag)} must be a required string literal; set another key with Borsh.discriminants(map, { tag })`,
      )
    }
    // The tag field is never compiled on its own, so check it here.
    rejectMaxLength(tagType, `${path}[${JSON.stringify(tag)}]`)
    return { label: tagType.literal, member }
  })
}

function literalVariants(
  members: ReadonlyArray<SchemaAST.Literal>,
  layout: EnumDescriptor | undefined,
  path: string,
): ReadonlyArray<UnnumberedVariant> {
  const variants = members.map((member) => {
    assertPlainVariant(member, path)
    return { label: String(member.literal), value: member.literal }
  })
  if (layout === undefined && variants.some((variant) => typeof variant.value !== "string")) {
    throw new Error(
      `${path}: Non-string literal enums have no Rust variant order; ${explicitDiscriminantsHint}`,
    )
  }
  return variants
}

function tsEnumVariants(
  ast: SchemaAST.Enum,
  layout: EnumDescriptor | undefined,
  path: string,
): ReadonlyArray<UnnumberedVariant> {
  const variants = ast.enums.map(([label, value]) => ({ label, value }))
  if (new Set(variants.map((variant) => typeof variant.value)).size > 1) {
    throw new Error(`${path}: Mixed string and numeric enums are unsupported`)
  }
  if (new Set(variants.map((variant) => variant.value)).size !== variants.length) {
    throw new Error(`${path}: Duplicate enum values have no Borsh layout`)
  }
  // Without a discriminant map, Rust numbers variants by declaration index, so values must match.
  const isDeclarationOrder = variants.every(
    (variant, i) => typeof variant.value !== "number" || variant.value === i,
  )
  if (layout === undefined && !isDeclarationOrder) {
    throw new Error(
      `${path}: Numeric enum values must be 0..n-1 in declaration order; ${explicitDiscriminantsHint}`,
    )
  }
  return variants
}

/** Variants are compiled here rather than through compile, so check what it would. */
function assertPlainVariant(member: SchemaAST.AST, path: string): void {
  if (member.context?.isOptional || descriptor(member, path) !== undefined) {
    throw new Error(`${path}: Enum variants must be required and have no layout annotations`)
  }
  rejectMaxLength(member, path)
}

function uniqueLabels(variants: ReadonlyArray<UnnumberedVariant>, path: string): Set<string> {
  const labels = new Set<string>()
  for (const { label } of variants) {
    if (labels.has(label)) {
      throw new Error(`${path}: Duplicate enum label ${label}`)
    }
    labels.add(label)
  }
  return labels
}

/** Pair each variant with its entry in an explicit discriminant map, which must match exactly. */
function withDiscriminants(
  variants: ReadonlyArray<UnnumberedVariant>,
  labels: ReadonlySet<string>,
  discriminantMap: Readonly<Record<string, number>>,
  path: string,
): ReadonlyArray<EnumVariant> {
  const discriminants = new Map(Object.entries(discriminantMap))
  const unknownLabels = [...discriminants.keys()].filter((label) => !labels.has(label))
  if (unknownLabels.length > 0) {
    throw new Error(`${path}: Unknown enum discriminants ${unknownLabels.join(", ")}`)
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
  const objectVariants = variants.flatMap(({ member, ...variant }) =>
    member === undefined
      ? []
      : [{ ...variant, payload: compileObject(member, path, compile, tag) }],
  )
  // A default-discriminant enum with one dataless variant is a Rust ZST; explicit maps imply
  // repr(u8).
  const isZeroSized =
    layout === undefined &&
    variants.length === 1 &&
    objectVariants.every((variant) => variant.payload.isZeroSized)
  // Literal and TS enum variants have no payload; tagged union variants all have one.
  if (objectVariants.length === 0) {
    return valueEnum(variants, isZeroSized)
  }
  return objectEnum(objectVariants, tag, isZeroSized)
}

/** A literal union or TS enum: each value is written as its discriminant alone. */
function valueEnum(variants: ReadonlyArray<EnumVariant>, isZeroSized: boolean): Layout {
  const readVariant = variantReader(variants)
  const discriminantByValue = new Map(
    variants.map((variant) => [variant.value, variant.discriminant]),
  )
  return {
    minBytes: 1,
    isZeroSized,
    read: (r) => readVariant(r).value,
    write: (w, value) => {
      const discriminant = discriminantByValue.get(value)
      if (discriminant === undefined) {
        throw new BinaryError(w.offset, "Invalid enum value")
      }
      w.u8(discriminant)
    },
  }
}

/** A tagged union: the discriminant, then the variant's fields without its tag. */
function objectEnum(
  variants: ReadonlyArray<ObjectVariant>,
  tag: string,
  isZeroSized: boolean,
): Layout {
  const readVariant = variantReader(variants)
  const variantByLabel = new Map(variants.map((variant) => [variant.label, variant]))
  // As for struct fields, assignment would hit an inherited setter or a frozen inherited property.
  const define = tag in Object.prototype
  return {
    minBytes: 1 + Math.min(...variants.map((variant) => variant.payload.minBytes)),
    isZeroSized,
    read: (r) => {
      const variant = readVariant(r)
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
      const variant = typeof label === "string" ? variantByLabel.get(label) : undefined
      if (variant === undefined) {
        throw prepend(new BinaryError(w.offset, "Invalid enum label"), tag)
      }
      w.u8(variant.discriminant)
      variant.payload.write(w, value)
    },
  }
}

/** Read the u8 discriminant, reporting an unknown one at its own offset. */
function variantReader<V extends EnumVariant>(variants: ReadonlyArray<V>): (r: Reader) => V {
  const variantByDiscriminant = new Map(variants.map((variant) => [variant.discriminant, variant]))
  return (r) => {
    const offset = r.offset
    const discriminant = r.u8()
    const variant = variantByDiscriminant.get(discriminant)
    if (variant === undefined) {
      throw new BinaryError(offset, `Invalid enum tag ${discriminant}`)
    }
    return variant
  }
}
