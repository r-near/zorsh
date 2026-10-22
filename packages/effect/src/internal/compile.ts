import { Schema, SchemaAST } from "effect"
import * as L from "./layout.js"

/** The representation id of `Borsh.maxLength`. */
export const maxLengthId = "@zorsh/effect/maxLength"

/** The representation id of `Borsh.withBytes`. */
export const withBytesId = "@zorsh/effect/withBytes"

/** Private: only this package's constructors write it, through withLayout. */
const layoutKey = "@zorsh/effect/borsh/layout"

type LayoutAnnotation =
  | { readonly kind: "integer"; readonly bits: 8 | 16 | 32 | 64 | 128; readonly signed: boolean }
  | { readonly kind: "float"; readonly bits: 32 | 64 }
  | { readonly kind: "fixedBytes" | "fixedArray"; readonly length: number }
  | {
      readonly kind: "enum"
      readonly tag: string
      readonly discriminants: Readonly<Record<string, number>>
    }

type EnumAnnotation = Extract<LayoutAnnotation, { readonly kind: "enum" }>

type Compile = (ast: SchemaAST.AST, path: string) => L.Layout

/** Every u32 length fits, so a layout without Borsh.maxLength never fails its comparison. */
const unbounded = 0xffff_ffff

/** The layout of an encoded AST. Every unsupported schema throws here, naming its path. */
export function compile(root: SchemaAST.AST): L.Layout {
  // A node reused across the schema compiles once.
  const memo = new Map<SchemaAST.AST, L.Layout>()
  const compileCached: Compile = (ast, path) => {
    const cached = memo.get(ast)
    if (cached !== undefined) {
      return cached
    }
    const layout = compileNode(ast, path, compileCached)
    memo.set(ast, layout)
    return layout
  }
  return compileCached(root, "$")
}

/** An explicit layout annotation owns its node; natives and AST tags apply only without one. */
function compileNode(ast: SchemaAST.AST, path: string, compile: Compile): L.Layout {
  if (ast.context?.isOptional) {
    throw new Error(
      `${path}: Optional properties and elements have no Borsh layout on the encoded side; use Schema.Option for a Rust Option`,
    )
  }
  const annotation = layoutAnnotation(ast, path)
  if (annotation !== undefined || !hasLengthPrefix(ast)) {
    rejectMaxLength(ast, path)
  }
  if (annotation !== undefined) {
    return compileAnnotated(ast, annotation, path, compile)
  }
  const maxLength = maxLengthOf(ast) ?? unbounded
  switch (ast._tag) {
    case "Declaration":
      return compileDeclaration(ast, path, compile, maxLength)
    case "Union":
    case "Enum":
      return compileEnum(ast, undefined, path, compile)
    case "String":
      return L.string(maxLength)
    case "Boolean":
      return L.boolean
    case "Objects":
      return compileObject(ast, path, compile)
    case "Arrays":
      return compileArrays(ast, path, compile, maxLength)
    case "Number":
    case "BigInt":
      throw new Error(
        `${path}: ${ast._tag} requires an explicit Borsh width; use a Borsh numeric schema`,
      )
    case "Literal":
      throw new Error(
        `${path}: Unsupported encoded schema Literal; use Schema.Literals or a tagged union for a Rust enum`,
      )
    case "Suspend":
      // Compiling the thunk's schema would recurse forever on a recursive one, so never call it.
      throw new Error(`${path}: Suspend/recursive schemas are unsupported`)
  }
  throw new Error(`${path}: Unsupported encoded schema ${ast._tag}`)
}

/** Only this package's constructors write layout annotations, each onto the AST it lays out. */
function compileAnnotated(
  ast: SchemaAST.AST,
  annotation: LayoutAnnotation,
  path: string,
  compile: Compile,
): L.Layout {
  switch (annotation.kind) {
    case "integer":
      return L.integer(annotation.bits, annotation.signed)
    case "float":
      return L.float(annotation.bits)
    case "fixedBytes":
      return L.fixedBytes(annotation.length)
    case "fixedArray": {
      // Borsh.fixedArray builds Schema.Array(item), so rest holds exactly the item.
      const [item] = (ast as SchemaAST.Arrays).rest as [SchemaAST.AST]
      return L.array(compile(item, `${path}[]`), annotation.length)
    }
    case "enum":
      return compileEnum(ast, annotation, path, compile)
  }
}

/** Whether ast's layout starts with a u32 length that Borsh.maxLength can bound. */
function hasLengthPrefix(ast: SchemaAST.AST): boolean {
  switch (ast._tag) {
    case "String":
      return true
    case "Arrays":
      return homogeneousItem(ast) !== undefined
    case "Declaration": {
      const id = representationId(ast)
      return id !== undefined && lengthPrefixedIds.has(id)
    }
  }
  return false
}

/** A Rust struct: fields in declaration order. `omit` skips an enum variant's tag field. */
function compileObject(
  ast: SchemaAST.Objects,
  path: string,
  compile: Compile,
  omit?: string,
): L.Layout {
  if (ast.indexSignatures.length > 0) {
    throw new Error(
      `${path}: Index signatures have no Borsh layout; use Schema.ReadonlyMap or Schema.HashMap for a Rust map`,
    )
  }
  const fields = ast.propertySignatures
    .filter((field) => field.name !== omit)
    .map((field) => {
      if (typeof field.name === "symbol") {
        throw new Error(
          `${path}: Symbol key ${String(field.name)} has no Borsh layout; use a string key`,
        )
      }
      return {
        name: field.name,
        layout: compile(field.type, `${path}[${JSON.stringify(field.name)}]`),
      }
    })
  return L.struct(fields)
}

/** The item of a plain `ReadonlyArray<T>`, with no leading or trailing elements. */
function homogeneousItem(ast: SchemaAST.Arrays): SchemaAST.AST | undefined {
  if (ast.elements.length === 0 && ast.rest.length === 1) {
    return ast.rest[0]
  }
  return undefined
}

function compileArrays(
  ast: SchemaAST.Arrays,
  path: string,
  compile: Compile,
  maxLength: number,
): L.Layout {
  if (ast.rest.length === 0) {
    return L.tuple(ast.elements.map((item, i) => compile(item, `${path}[${i}]`)))
  }
  const item = homogeneousItem(ast)
  if (item === undefined) {
    throw new Error(
      `${path}: Mixed tuple rests have no Borsh layout; move the rest into its own Schema.Array element, or use Schema.Array with Schema.isMinLength`,
    )
  }
  return L.vector(compile(item, `${path}[]`), maxLength)
}

/** A declaration's compiled context: its path, its length bound and its type parameters. */
interface Declared {
  readonly path: string
  readonly maxLength: number
  readonly child: (index: number, segment: string) => L.Layout
}

/** Effect declarations with a Borsh layout, keyed by their representation id. */
const declarations: Readonly<Record<string, (node: Declared) => L.Layout>> = {
  "effect/schema/Uint8Array": ({ maxLength }) => L.bytes(maxLength),
  "effect/schema/Option": ({ child }) => L.option(child(0, "value")),
  "effect/schema/Result": ({ child }) => L.result(child(0, "success"), child(1, "failure")),
  "effect/schema/ReadonlyMap": map("ReadonlyMap", L.readonlyMap),
  "effect/schema/ReadonlySet": set("ReadonlySet", L.readonlySet),
  "effect/schema/HashMap": map("HashMap", L.hashMap),
  "effect/schema/HashSet": set("HashSet", L.hashSet),
  [withBytesId]: ({ child }) => L.withBytes(child(0, "value")),
}

/** Declarations whose layout starts with a u32 length, which Borsh.maxLength can bound. */
const lengthPrefixedIds: ReadonlySet<string> = new Set([
  "effect/schema/Uint8Array",
  "effect/schema/ReadonlyMap",
  "effect/schema/ReadonlySet",
  "effect/schema/HashMap",
  "effect/schema/HashSet",
])

function map(name: string, kind: L.Collection) {
  return (node: Declared) =>
    L.collection(kind, orderedKey(node, name), node.child(1, "value"), node.maxLength)
}

function set(name: string, kind: L.Collection) {
  return (node: Declared) => L.collection(kind, orderedKey(node, name), undefined, node.maxLength)
}

function orderedKey(node: Declared, name: string): L.Key {
  const key = node.child(0, "key")
  if (!isKey(key)) {
    throw new Error(`${node.path}: ${name} keys require Boolean, integer or String Rust ordering`)
  }
  return key
}

function isKey(layout: L.Layout): layout is L.Key {
  return layout.compare !== undefined
}

function compileDeclaration(
  ast: SchemaAST.Declaration,
  path: string,
  compile: Compile,
  maxLength: number,
): L.Layout {
  const id = representationId(ast)
  // Own keys only, so an id such as "constructor" cannot select an Object.prototype member.
  const declared =
    id !== undefined && Object.hasOwn(declarations, id) ? declarations[id] : undefined
  if (declared === undefined) {
    const subject = id === undefined ? "Declaration" : `Declaration ${id}`
    throw new Error(
      `${path}: ${subject} has no Borsh layout; decode it from a Borsh-encodable schema with Schema.decodeTo`,
    )
  }
  return declared({
    path,
    maxLength,
    // The constructors behind these representation ids fix each declaration's type parameters.
    child: (index, segment) =>
      compile(ast.typeParameters[index] as SchemaAST.AST, `${path}[${JSON.stringify(segment)}]`),
  })
}

function representationId(ast: SchemaAST.Declaration): string | undefined {
  // Hand-built declarations can carry a representation and id of any type.
  const representation = ast.annotations?.representation as { readonly id?: unknown } | undefined
  const id = representation?.id
  return typeof id === "string" ? id : undefined
}

interface EnumVariant {
  readonly label: string
  readonly discriminant: number
  readonly value?: unknown
  readonly member?: SchemaAST.Objects
}

type UnnumberedVariant = Omit<EnumVariant, "discriminant">

const explicitDiscriminantsHint =
  "pass the Rust wire discriminants (declaration indices unless #[borsh(use_discriminant = true)]) to Borsh.discriminants"

function compileEnum(
  ast: SchemaAST.AST,
  annotation: EnumAnnotation | undefined,
  path: string,
  compile: Compile,
): L.Layout {
  const tag = annotation === undefined ? "_tag" : annotation.tag
  const variants = enumVariants(ast, annotation, path).map(({ member, ...variant }): L.Variant =>
    member === undefined
      ? variant
      : { ...variant, payload: compileObject(member, path, compile, tag) },
  )
  // One dataless variant is a Rust ZST, unless an explicit map implies repr(u8).
  const isZeroSized =
    annotation === undefined &&
    variants.length === 1 &&
    variants.every(({ payload }) => payload === undefined || payload.isZeroSized)
  return L.enumOf(variants, tag, isZeroSized)
}

/** Read Rust enum variants with declaration-order or explicit discriminants. */
export function enumVariants(
  ast: SchemaAST.AST,
  annotation: EnumAnnotation | undefined,
  path: string,
): ReadonlyArray<EnumVariant> {
  // Enums are classified before anything is compiled, so a suspended one is reported here.
  const isSuspended =
    SchemaAST.isSuspend(ast) || (ast._tag === "Union" && ast.types.some(SchemaAST.isSuspend))
  if (isSuspended) {
    throw new Error(`${path}: Suspend/recursive schemas are unsupported`)
  }
  const tag = annotation === undefined ? "_tag" : annotation.tag
  const isTaggedUnion =
    ast._tag === "Union" && ast.types.length > 0 && ast.types.every(SchemaAST.isObjects)
  let variants: ReadonlyArray<UnnumberedVariant>
  if (isTaggedUnion) {
    variants = taggedVariants(ast.types, tag, path)
  } else if (ast._tag === "Union" && ast.types.every(SchemaAST.isLiteral)) {
    variants = literalVariants(ast.types, annotation, path)
  } else if (ast._tag === "Enum") {
    variants = tsEnumVariants(ast, annotation, path)
  } else if (ast._tag === "Union" && annotation === undefined) {
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
  return numbered(variants, annotation, path)
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
  annotation: EnumAnnotation | undefined,
  path: string,
): ReadonlyArray<UnnumberedVariant> {
  const variants = members.map((member) => {
    assertPlainVariant(member, path)
    return { label: String(member.literal), value: member.literal }
  })
  if (annotation === undefined && variants.some((variant) => typeof variant.value !== "string")) {
    throw new Error(
      `${path}: Non-string literal enums have no Rust variant order; ${explicitDiscriminantsHint}`,
    )
  }
  return variants
}

function tsEnumVariants(
  ast: SchemaAST.Enum,
  annotation: EnumAnnotation | undefined,
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
  if (annotation === undefined && !isDeclarationOrder) {
    throw new Error(
      `${path}: Numeric enum values must be 0..n-1 in declaration order; ${explicitDiscriminantsHint}`,
    )
  }
  return variants
}

/** Variants are compiled here rather than through compile, so check what it would. */
function assertPlainVariant(member: SchemaAST.AST, path: string): void {
  if (member.context?.isOptional) {
    throw new Error(`${path}: Enum variants must be required`)
  }
  rejectMaxLength(member, path)
}

/** Number variants by declaration index, or by an explicit map that must match them exactly. */
function numbered(
  variants: ReadonlyArray<UnnumberedVariant>,
  annotation: EnumAnnotation | undefined,
  path: string,
): ReadonlyArray<EnumVariant> {
  const labels = new Set<string>()
  for (const { label } of variants) {
    if (labels.has(label)) {
      throw new Error(`${path}: Duplicate enum label ${label}`)
    }
    labels.add(label)
  }
  if (annotation === undefined) {
    return variants.map((variant, discriminant) => ({ ...variant, discriminant }))
  }
  const discriminants = new Map(Object.entries(annotation.discriminants))
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

/** The smallest Borsh.maxLength bound among ast's checks, groups included, if it has any. */
function maxLengthOf(ast: SchemaAST.AST): number | undefined {
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

function filters(
  checks: ReadonlyArray<SchemaAST.Check<unknown>>,
): Array<SchemaAST.Filter<unknown>> {
  return checks.flatMap((check) => (check._tag === "FilterGroup" ? filters(check.checks) : [check]))
}

/** Throw if ast carries Borsh.maxLength, for a node whose layout has no length prefix. */
function rejectMaxLength(ast: SchemaAST.AST, path: string): void {
  if (maxLengthOf(ast) !== undefined) {
    throw new Error(
      `${path}: Borsh.maxLength requires a length-prefixed layout (string, bytes, vector, map or set)`,
    )
  }
}

function layoutAnnotation(ast: SchemaAST.AST, path: string): LayoutAnnotation | undefined {
  let found = ast.annotations?.[layoutKey] as LayoutAnnotation | undefined
  // Annotating a schema that ends in a filter annotates the filter, as Borsh.U8 does Schema.Int's.
  for (const check of ast.checks ?? []) {
    const next = check.annotations?.[layoutKey] as LayoutAnnotation | undefined
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
  if (found !== undefined && !isSameLayout(found, next)) {
    throw new Error(`${path}: Conflicting Borsh layout annotations`)
  }
  return next
}

/**
 * Layouts are flat records apart from an enum's discriminant map. Compared by hand, because Effect's
 * Equal would treat a label such as "~effect/Equal" as its protocol method.
 */
function isSameLayout(left: LayoutAnnotation, right: LayoutAnnotation): boolean {
  if (left.kind === "enum" && right.kind === "enum") {
    return left.tag === right.tag && isSameRecord(left.discriminants, right.discriminants)
  }
  return isSameRecord(left, right)
}

function isSameRecord(left: object, right: object): boolean {
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => Object.hasOwn(right, key) && Reflect.get(left, key) === Reflect.get(right, key),
    )
  )
}

export function withLayout<S extends Schema.Top>(
  schema: S,
  annotation: LayoutAnnotation,
): S["Rebuild"] {
  const merged = merge(layoutAnnotation(Schema.toEncoded(schema).ast, "$"), annotation, "$")
  return schema.pipe(Schema.annotateEncoded({ [layoutKey]: Object.freeze(merged) }))
}
