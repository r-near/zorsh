/**
 * Borsh codecs derived from native Effect schemas.
 *
 * Build a schema with Effect's `Schema` module, use these constants and
 * combinators where Rust needs an explicit width or layout, then derive a codec
 * with {@link toCodec}.
 *
 * @since 0.1.0
 */
import { Effect, Order, Schema, SchemaAST, SchemaIssue, SchemaTransformation } from "effect"
import { isU32Length, parseDescriptor, withLayout } from "./internal/annotations.js"
import { compile, type Layout, rejectSuspensions } from "./internal/compiler.js"
import { homogeneousItem } from "./internal/containers.js"
import { enumVariants } from "./internal/enums.js"
import { BinaryError, Reader, Writer } from "./internal/io.js"
import { integerRange } from "./internal/primitives.js"

function integer(bits: 8 | 16 | 32, signed: boolean) {
  const { minimum, maximum } = integerRange(bits, signed)
  return withLayout(Schema.Int, {
    version: 1,
    kind: "integer",
    bits,
    signed,
  }).check(Schema.isBetween({ minimum: Number(minimum), maximum: Number(maximum) }))
}

function bigInteger(bits: 64 | 128, signed: boolean): Schema.BigInt {
  return withLayout(Schema.BigInt, {
    version: 1,
    kind: "integer",
    bits,
    signed,
  }).check(Schema.isBetweenBigInt(integerRange(bits, signed)))
}

/** Reject Suspend before Schema.toEncoded can evaluate a thunk. */
function encodedAST(schema: Schema.Constraint): SchemaAST.AST {
  rejectSuspensions(schema.ast)
  return Schema.toEncoded(schema).ast
}

/**
 * Rust `u8`: an integer `number` from 0 to 255, written little endian.
 *
 * @category integers
 * @since 0.1.0
 */
export const U8 = integer(8, false)
/**
 * Rust `u16`: an integer `number` from 0 to 65535, written little endian.
 *
 * @category integers
 * @since 0.1.0
 */
export const U16 = integer(16, false)
/**
 * Rust `u32`: an integer `number` from 0 to 2^32 - 1, written little endian.
 *
 * @category integers
 * @since 0.1.0
 */
export const U32 = integer(32, false)
/**
 * Rust `i8`: an integer `number` from -128 to 127, written little endian.
 *
 * @category integers
 * @since 0.1.0
 */
export const I8 = integer(8, true)
/**
 * Rust `i16`: an integer `number` from -32768 to 32767, written little endian.
 *
 * @category integers
 * @since 0.1.0
 */
export const I16 = integer(16, true)
/**
 * Rust `i32`: an integer `number` from -2^31 to 2^31 - 1, written little endian.
 *
 * @category integers
 * @since 0.1.0
 */
export const I32 = integer(32, true)
/**
 * Rust `u64`: a `bigint` from 0 to 2^64 - 1, written little endian.
 *
 * @category integers
 * @since 0.1.0
 */
export const U64 = bigInteger(64, false)
/**
 * Rust `u128`: a `bigint` from 0 to 2^128 - 1, written little endian.
 *
 * @category integers
 * @since 0.1.0
 */
export const U128 = bigInteger(128, false)
/**
 * Rust `i64`: a `bigint` from -2^63 to 2^63 - 1, written little endian.
 *
 * @category integers
 * @since 0.1.0
 */
export const I64 = bigInteger(64, true)
/**
 * Rust `i128`: a `bigint` from -2^127 to 2^127 - 1, written little endian.
 *
 * @category integers
 * @since 0.1.0
 */
export const I128 = bigInteger(128, true)

/**
 * Rust `f32`: a `number` exactly representable as IEEE-754 binary32, written
 * little endian. Infinities and signed zero are allowed; NaN is rejected.
 * Round explicitly with `Math.fround`.
 *
 * Effect's native arbitrary has no binary32 generator, so derived samples are
 * integers within ±2^24, which binary32 represents exactly.
 *
 * @category floats
 * @since 0.1.0
 */
export const F32 = withLayout(Schema.Number, { version: 1, kind: "float", bits: 32 }).check(
  Schema.makeFilter((n) => !Number.isNaN(n) && Object.is(Math.fround(n), n), {
    expected: "an exactly representable binary32 number",
    arbitraryConstraint: {
      order: Order.Number,
      number: "integer",
      minimum: -(2 ** 24),
      maximum: 2 ** 24,
    },
  }),
)
/**
 * Rust `f64`: an IEEE-754 binary64 `number`, written little endian.
 * Infinities and signed zero are allowed; NaN is rejected.
 *
 * @category floats
 * @since 0.1.0
 */
export const F64 = withLayout(Schema.Number, {
  version: 1,
  kind: "float",
  bits: 64,
}).check(Schema.makeFilter((n) => !Number.isNaN(n), { expected: "a non-NaN number" }))

/**
 * Rust `Vec<u8>`: a u32 byte length followed by the bytes. This is
 * `Schema.Uint8Array`, which has the same layout.
 *
 * @category bytes
 * @since 0.1.0
 */
export const Bytes = Schema.Uint8Array
/**
 * Rust `()`: the empty tuple, which writes no bytes.
 *
 * @category containers
 * @since 0.1.0
 */
export const Unit = Schema.Tuple([])

/**
 * Rust `[u8; N]`: exactly `length` bytes with no length prefix.
 *
 * **Details**
 *
 * The schema checks the byte length, so encoding and decoding reject other
 * sizes. `length` must be an integer from 0 through 2^32 - 1.
 *
 * **Example** (A 32-byte identifier)
 *
 * ```ts
 * import { Borsh } from "@zorsh/effect"
 * import { Schema } from "effect"
 *
 * const RequestId = Borsh.fixedBytes(32)
 * const bytes = Schema.encodeSync(Borsh.toCodec(RequestId))(new Uint8Array(32))
 * // bytes.length === 32
 * ```
 *
 * @category bytes
 * @since 0.1.0
 */
export function fixedBytes(length: number): Schema.Uint8Array {
  if (!isU32Length(length))
    throw new Error("$: fixedBytes length must be a safe integer between 0 and 2^32 - 1")
  return withLayout(Bytes, {
    version: 1,
    kind: "fixedBytes",
    length,
  }).check(
    Schema.makeFilter((bytes) => bytes.byteLength === length, {
      expected: `exactly ${length} bytes`,
      arbitraryConstraint: { minLength: length, maxLength: length },
    }),
  )
}

/** Filter annotations that describe the check itself rather than the schema it refines. */
const checkKeys = new Set([
  "expected",
  "message",
  "representation",
  "toJsonSchema",
  "toCode",
  "arbitraryConstraint",
  "~structural",
])

/** Effect resolves annotations from the last check, so the new check keeps the schema's. */
function exactLength(ast: SchemaAST.AST, length: number) {
  const kept = Object.entries({ ...SchemaAST.resolve(ast) }).filter(([key]) => !checkKeys.has(key))
  return Schema.isBetweenLength(length, length, Object.fromEntries(kept))
}

/**
 * Rust `[T; N]`: gives a native array schema a fixed-length layout with no
 * count prefix.
 *
 * **Details**
 *
 * The schema's encoded side must be a homogeneous array, such as
 * `Schema.Array(item)`; other shapes throw when the combinator is applied. The
 * codec requires exactly `length` items. A schema without a transformation,
 * such as a checked or branded `Schema.Array(item)`, also gets a native
 * exact-length check. A transformed schema is otherwise unchanged, so its
 * application type is kept and no check is added to the decoded value; check
 * the encoded array's length before the transformation instead. `length` must
 * be an integer from 0 through 2^32 - 1.
 *
 * **Example** (Three u16 values)
 *
 * ```ts
 * import { Borsh } from "@zorsh/effect"
 * import { Schema } from "effect"
 *
 * const Amounts = Schema.Array(Borsh.U16).pipe(Borsh.fixedArray(3))
 * const bytes = Schema.encodeSync(Borsh.toCodec(Amounts))([7, 513, 0])
 * // Uint8Array [7, 0, 1, 2, 0, 0]
 * ```
 *
 * @category containers
 * @since 0.1.0
 */
export function fixedArray(length: number): <S extends Schema.Top>(schema: S) => S["Rebuild"] {
  if (!isU32Length(length))
    throw new Error("$: fixedArray length must be a safe integer between 0 and 2^32 - 1")
  return (schema) => {
    if (homogeneousItem(encodedAST(schema)) === undefined)
      throw new Error("$: fixedArray requires a homogeneous encoded array")
    const fixed = withLayout(schema, { version: 1, kind: "fixedArray", length })
    // Without a transformation the decoded value is the encoded array, so it can carry the length.
    return schema.ast.encoding === undefined
      ? fixed.check(exactLength(fixed.ast, length) as SchemaAST.Check<typeof fixed.Type>)
      : fixed
  }
}

/** TS enum member names, found through wrappers that keep the encoded (or flipped type) side. */
type EnumNames<S, Side extends "Encoded" | "Type" = "Encoded"> = S extends {
  readonly enums: infer E
}
  ? `${Extract<keyof E, string | number>}`
  : S extends { readonly from: infer F; readonly to: infer T }
    ? EnumNames<Side extends "Encoded" ? F : T, Side>
    : S extends Schema.Top & { readonly schema: infer I extends Schema.Top }
      ? [S[Side], I[Side]] extends [I[Side], S[Side]]
        ? EnumNames<I, Side>
        : Side extends "Encoded"
          ? [S[Side], I["Type"]] extends [I["Type"], S[Side]]
            ? EnumNames<I, "Type">
            : never
          : never
      : never
type EnumLabels<S extends Schema.Top, Tag extends string> = [EnumNames<S>] extends [never]
  ? S["Encoded"] extends infer E
    ? E extends SchemaAST.LiteralValue
      ? Tag extends "_tag"
        ? `${E}`
        : never
      : E extends { readonly [K in Tag]: infer L }
        ? Extract<L, string>
        : never
    : never
  : Tag extends "_tag"
    ? EnumNames<S>
    : never
type MapLabels<D, Required = false> = `${Extract<
  { [K in keyof D]-?: Required extends true ? ({} extends Pick<D, K> ? never : K) : K }[keyof D],
  string | number
>}`
type SingleTag<Tag extends string> = string extends Tag
  ? false
  : [Tag] extends [infer T]
    ? T extends unknown
      ? [Tag] extends [T]
        ? true
        : false
      : never
    : never
type ExactDiscriminants<S extends Schema.Top, D, Tag extends string> = [SingleTag<Tag>] extends [
  true,
]
  ? ExactLabels<S, D, Tag>
  : { readonly "Borsh discriminants tag must be one string literal": Tag }
type ExactLabels<S extends Schema.Top, D, Tag extends string> = [
  Exclude<EnumLabels<S, Tag>, MapLabels<D, true>>,
  Exclude<MapLabels<D>, EnumLabels<S, Tag>>,
] extends [never, never]
  ? unknown
  : {
      readonly "Missing Borsh discriminants": Exclude<EnumLabels<S, Tag>, MapLabels<D, true>>
      readonly "Unknown Borsh discriminants": Exclude<MapLabels<D>, EnumLabels<S, Tag>>
    }

/**
 * Rust `#[borsh(use_discriminant = true)]`: assigns explicit u8 discriminants
 * to an enum schema.
 *
 * **Details**
 *
 * Without this, each variant's discriminant is its declaration index. Keys are
 * the encoded `_tag` values, literal values as strings, or TS enum member
 * names; every variant needs exactly one unique integer from 0 to 255. Missing
 * and unknown keys are type errors. Pass `{ tag: "kind" }` for unions tagged by
 * another literal field. Values are checked when the combinator is called and
 * labels when it is applied to a schema.
 *
 * **Example** (Sparse discriminants)
 *
 * ```ts
 * import { Borsh } from "@zorsh/effect"
 * import { Schema } from "effect"
 *
 * // enum Flag { Off = 1, On = 5 }
 * const Flag = Schema.TaggedUnion({ Off: {}, On: {} }).pipe(
 *   Borsh.discriminants({ Off: 1, On: 5 }),
 * )
 * const bytes = Schema.encodeSync(Borsh.toCodec(Flag))({ _tag: "On" })
 * // Uint8Array [5]
 * ```
 *
 * @category enums
 * @since 0.1.0
 */
export function discriminants<
  const D extends Readonly<Record<string, number>>,
  Tag extends string = "_tag",
>(
  map: D,
  options?: { readonly tag?: Tag | undefined },
): <S extends Schema.Top>(schema: S & ExactDiscriminants<S, D, Tag>) => S["Rebuild"] {
  const layout = parseDescriptor(
    {
      version: 1,
      kind: "enum",
      tag: options?.tag ?? "_tag",
      discriminants: map,
    },
    "$",
  )
  return (schema) => {
    enumVariants(encodedAST(schema), layout, "$")
    return withLayout(schema, layout)
  }
}

/**
 * Options for {@link toCodec}.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /**
   * Maximum input or output byte length per operation, as a positive safe
   * integer. Default: 16 MiB.
   *
   * @since 0.1.0
   */
  readonly maxBytes?: number | undefined
}

function binaryFailure(error: unknown): SchemaIssue.Issue {
  if (!(error instanceof BinaryError)) throw error
  const issue = new SchemaIssue.InvalidValue({ message: error.message })
  return error.path.length === 0 ? issue : new SchemaIssue.Pointer(error.path, issue)
}

const codecCache = new WeakMap<
  Schema.Constraint,
  { readonly layout: Layout; readonly codecs: Map<number, unknown> }
>()
/** Bound the codecs retained per schema when callers vary maxBytes. */
const maxBytesCacheSize = 8

/**
 * Derives a Borsh codec from a schema.
 *
 * **Details**
 *
 * The binary layout is compiled from the encoded side of the schema, and the
 * schema's own checks, brands, transformations and services still apply.
 * Unsupported layouts and invalid options throw here, at construction. Decoding
 * must consume the whole input. Binary failures are `Schema.SchemaError`s whose
 * issue names the path and byte offset. Codecs are memoized by schema identity
 * and `maxBytes`, keeping up to 8 `maxBytes` values per schema.
 *
 * **Example** (Encoding contract arguments)
 *
 * ```ts
 * import { Borsh } from "@zorsh/effect"
 * import { Schema } from "effect"
 *
 * const Transfer = Schema.Struct({ receiver: Schema.String, amount: Borsh.U128 })
 * const codec = Borsh.toCodec(Transfer)
 *
 * const bytes = Schema.encodeSync(codec)({ receiver: "alice.near", amount: 123n })
 * const transfer = Schema.decodeSync(codec)(bytes)
 * // { receiver: "alice.near", amount: 123n }
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export function toCodec<S extends Schema.Constraint>(
  schema: S,
  options?: Options,
): Schema.Codec<S["Type"], Uint8Array, S["DecodingServices"], S["EncodingServices"]> {
  const maxBytes = options?.maxBytes === undefined ? 16 * 1024 * 1024 : options.maxBytes
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new Error("$: maxBytes must be a positive safe integer")
  let entry = codecCache.get(schema)
  const cached = entry?.codecs.get(maxBytes)
  if (cached !== undefined)
    return cached as Schema.Codec<
      S["Type"],
      Uint8Array,
      S["DecodingServices"],
      S["EncodingServices"]
    >
  if (entry === undefined) {
    entry = { layout: compile(encodedAST(schema)), codecs: new Map() }
    codecCache.set(schema, entry)
  }
  const { layout, codecs } = entry
  const binary = Schema.Uint8Array.pipe(
    Schema.decodeTo(
      Schema.Unknown,
      SchemaTransformation.transformEffect({
        decode: (bytes) =>
          Effect.try({
            try: () => {
              const reader = new Reader(bytes, maxBytes)
              const value = layout.read(reader)
              if (reader.offset !== bytes.byteLength)
                throw new BinaryError(reader.offset, "Trailing bytes")
              return value
            },
            catch: binaryFailure,
          }),
        encode: (value) =>
          Effect.try({
            try: () => {
              const writer = new Writer(maxBytes)
              layout.write(writer, value)
              return writer.finish()
            },
            catch: binaryFailure,
          }),
      }),
    ),
  )
  const codec = binary.pipe(Schema.decodeTo(schema))
  if (codecs.size >= maxBytesCacheSize) codecs.delete(codecs.keys().next().value as number)
  codecs.set(maxBytes, codec)
  return codec
}
