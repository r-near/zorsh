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
import { compile, type Layout, prepare } from "./internal/compiler.js"
import { homogeneousItem } from "./internal/containers.js"
import { enumVariants } from "./internal/enums.js"
import { BinaryError, Reader, type ReaderOptions, Writer } from "./internal/io.js"
import type { DeferredChecks } from "./internal/limits.js"
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

/** Reject Suspend, with its path, before deriving the encoded AST. */
function encodedAST(schema: Schema.Constraint): SchemaAST.AST {
  prepare(schema.ast)
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
 * integers within ±2^24, which binary32 represents exactly. Refinements must
 * admit such an integer for sampling.
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
  if (!isU32Length(length)) {
    throw new Error("$: fixedBytes length must be a safe integer between 0 and 2^32 - 1")
  }
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

/** Annotations describing a check itself, which the length check keeps as its own. */
const checkKeys = new Set([
  "expected",
  "message",
  "representation",
  "toJsonSchema",
  "toCode",
  "arbitraryConstraint",
  "~structural",
])

/** Annotations JSON Schema emits from the schema and again from every check that carries them. */
const jsonSchemaKeys = [
  "title",
  "description",
  "default",
  "examples",
  "readOnly",
  "writeOnly",
  "format",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
]

/**
 * Appends an exact-length check. Effect resolves annotations from the last
 * check, so the schema's annotations move onto the new one. JSON Schema
 * keywords are cleared where they were, so they are emitted once.
 */
function withExactLength<S extends Schema.Top>(schema: S, length: number): S["Rebuild"] {
  const checks = schema.ast.checks
  // `.check()` with no checks leaves an empty array, which `resolve` and `annotate` do not handle.
  const emptyChecks = checks !== undefined && checks.length === 0
  const annotations = (emptyChecks ? schema.ast.annotations : SchemaAST.resolve(schema.ast)) ?? {}
  if (emptyChecks) {
    // The schema's own annotations cannot be cleared here, so JSON Schema keywords stay on it.
    // Effect could not resolve this schema's annotations before the check was added either.
    const kept = Object.entries(annotations).filter(
      ([key]) => !checkKeys.has(key) && !jsonSchemaKeys.includes(key),
    )
    const lengthCheck = Schema.isBetweenLength(length, length, Object.fromEntries(kept))
    return schema.check(lengthCheck as SchemaAST.Check<S["Type"]>)
  }
  const moved = Object.entries(annotations).filter(([key]) => !checkKeys.has(key))
  const lengthCheck = Schema.isBetweenLength(length, length, Object.fromEntries(moved))
  const cleared = jsonSchemaKeys.filter((key) => key in annotations).map((key) => [key, undefined])
  return schema
    .annotate(Object.fromEntries(cleared))
    .check(lengthCheck as SchemaAST.Check<S["Type"]>) as S["Rebuild"]
}

/** Whether a check, such as an earlier `fixedArray`, already enforces exactly `length` items. */
function pinsLength(check: SchemaAST.Check<never>, length: number): boolean {
  if (check._tag === "FilterGroup") {
    return check.checks.some((inner) => pinsLength(inner, length))
  }
  const representation = check.annotations?.representation
  return (
    representation?.id === "effect/schema/isBetweenLength" &&
    JSON.stringify(representation.payload) === JSON.stringify({ minimum: length, maximum: length })
  )
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
 * application type is kept and no check is added to the decoded value; apply
 * `fixedArray` before the transformation instead. `length` must be an integer
 * from 0 through 2^32 - 1.
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
  if (!isU32Length(length)) {
    throw new Error("$: fixedArray length must be a safe integer between 0 and 2^32 - 1")
  }
  return (schema) => {
    if (homogeneousItem(encodedAST(schema)) === undefined) {
      throw new Error("$: fixedArray requires a homogeneous encoded array")
    }
    const fixed = withLayout(schema, { version: 1, kind: "fixedArray", length })
    // Without a transformation the decoded value is the encoded array, so it can carry the length.
    return schema.ast.encoding === undefined &&
      !schema.ast.checks?.some((check) => pinsLength(check, length))
      ? withExactLength(fixed, length)
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
// The labels a discriminant map must cover: TS enum names, literal values or variant tags.
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
// The keys of a discriminant map, or only its required keys.
type MapLabels<D, Required = false> = `${Extract<
  { [K in keyof D]-?: Required extends true ? ({} extends Pick<D, K> ? never : K) : K }[keyof D],
  string | number
>}`
// True only for a single string literal, not `string` or a union.
type SingleTag<Tag extends string> = string extends Tag
  ? false
  : [Tag] extends [infer T]
    ? T extends unknown
      ? [Tag] extends [T]
        ? true
        : false
      : never
    : never
// A type error naming the problem unless Tag is one literal and the map covers exactly the labels.
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
 * Options for {@link toCodec}, {@link decodePrefixEffect} and {@link decodePrefixSync}.
 *
 * **Untrusted input**
 *
 * The binary layer checks every length prefix against the bytes that remain,
 * but small items, such as unit enum variants or `Option.none()`, let one input
 * byte become one decoded value. Set `maxBytes` and `maxItems` to the largest
 * message you expect, and put `Schema.isMaxLength` or `Schema.isMaxSize` on the
 * encoded side of each collection. Both are enforced before any item is read.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /**
   * Maximum input or output byte length per operation, as a positive safe
   * integer. For a prefix decoder, this limits the bytes the value may
   * consume, not the length of the buffer. Default: 16 MiB.
   *
   * @since 0.1.0
   */
  readonly maxBytes?: number | undefined
  /**
   * Maximum number of collection items per operation, nested ones included,
   * as a non-negative safe integer. This is one budget for the whole value,
   * not a limit per collection: every vector or fixed-array item, map entry
   * and set member counts once, however deeply it is nested. Byte arrays and
   * strings do not count, because `maxBytes` bounds them. A collection is
   * charged as soon as its length is known, before any of its items is read,
   * and the budget applies to encoding too, so anything a codec encodes it can
   * also decode. Default: no limit.
   *
   * @since 0.1.0
   */
  readonly maxItems?: number | undefined
}

/** Turn a binary failure into a schema issue; any other error is a defect and is rethrown. */
function binaryFailure(error: unknown): SchemaIssue.Issue {
  if (!(error instanceof BinaryError)) {
    throw error
  }
  const leaf = new SchemaIssue.InvalidValue({ message: error.message })
  // An early schema check fails as a Filter on the user's own check, as the schema pass would.
  const issue = error.check === undefined ? leaf : new SchemaIssue.Filter(error.check, leaf)
  return error.path.length === 0 ? issue : new SchemaIssue.Pointer(error.path, issue)
}

interface CodecCacheEntry {
  readonly encoded: SchemaAST.AST
  readonly deferred: DeferredChecks
  /** Keyed by whether collections charge maxItems; each variant compiles on first use. */
  readonly layouts: Map<boolean, Layout>
  /** Keyed by `maxBytes`, or `maxBytes/maxItems` when maxItems is set. */
  readonly codecs: Map<number | string, unknown>
}

const codecCache = new WeakMap<Schema.Constraint, CodecCacheEntry>()
const defaultMaxBytes = 16 * 1024 * 1024
/** Bound the codecs retained per schema when callers vary the options. */
const optionsCacheSize = 8

/**
 * Derives a Borsh codec from a schema.
 *
 * **Details**
 *
 * The binary layout is compiled from the encoded side of the schema, and the
 * schema's own checks, brands, transformations and services still apply.
 * Unsupported layouts and invalid options throw here, at construction. Decoding
 * must consume the whole input. Binary failures are `Schema.SchemaError`s whose
 * issue names the path and byte offset. Codecs are memoized by schema identity,
 * `maxBytes` and `maxItems`, keeping up to 8 option combinations per schema.
 *
 * The binary layer enforces the schema's own length and size checks,
 * `Schema.isMinLength`, `isMaxLength`, `isBetweenLength` (and `isNonEmpty`) on
 * vectors and `Borsh.Bytes`, and `Schema.isMinSize`, `isMaxSize` and
 * `isBetweenSize` on maps and sets, as soon as it reads the length prefix,
 * before reading any item. They must be on the encoded side of the schema,
 * before any transformation. Effect still runs them in the schema pass, so this
 * only makes oversized input fail sooner, with a `Filter` issue for the failing
 * check plus the count and byte offset. `disableChecks` skips them. Checks on
 * strings, in custom filters and after a transformation run only in the
 * schema pass, as does a maximum size on a map or set whose key schema has a
 * transformation, because decoding can merge its keys, and any check beneath
 * decoding middleware such as `Schema.catchDecoding`, or in a union containing
 * it, since the middleware can recover from the failure. See {@link Options}
 * for `maxItems`.
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
 * **Example** (Bounding untrusted input)
 *
 * ```ts
 * import { Borsh } from "@zorsh/effect"
 * import { Schema } from "effect"
 *
 * const Receipt = Schema.Struct({
 *   logs: Schema.Array(Schema.String).check(Schema.isMaxLength(100)),
 *   payload: Borsh.Bytes.check(Schema.isMaxLength(64 * 1024)),
 * })
 * const codec = Borsh.toCodec(Receipt, { maxBytes: 256 * 1024, maxItems: 10_000 })
 * // A `logs` count of 2^32 - 1 fails right after its 4-byte prefix:
 * // Expected a value with a length of at most 100, got 4294967295 items at byte 0
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export function toCodec<S extends Schema.Constraint>(
  schema: S,
  options?: Options,
): Schema.Codec<S["Type"], Uint8Array, S["DecodingServices"], S["EncodingServices"]> {
  const { maxBytes, maxItems } = validLimits(options)
  const entry = cacheEntry(schema)
  // Without maxItems the key stays a number, so the common lookup builds no string.
  const key = maxItems === undefined ? maxBytes : `${maxBytes}/${maxItems}`
  const cached = entry.codecs.get(key)
  if (cached !== undefined) {
    return cached as Schema.Codec<
      S["Type"],
      Uint8Array,
      S["DecodingServices"],
      S["EncodingServices"]
    >
  }
  const codec = binaryCodec(layoutOf(entry, maxItems !== undefined), maxBytes, maxItems).pipe(
    Schema.decodeTo(schema),
  )
  // Maps iterate in insertion order, so this evicts the oldest options.
  if (entry.codecs.size >= optionsCacheSize) {
    entry.codecs.delete(entry.codecs.keys().next().value as number | string)
  }
  entry.codecs.set(key, codec)
  return codec
}

/** Validate options at construction. Only an absent option takes the default; null is rejected. */
function validLimits(options: Options | undefined): {
  readonly maxBytes: number
  readonly maxItems: number | undefined
} {
  const maxBytes = options?.maxBytes === undefined ? defaultMaxBytes : options.maxBytes
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("$: maxBytes must be a positive safe integer")
  }
  const maxItems = options?.maxItems
  const isValidMaxItems =
    maxItems === undefined || (Number.isSafeInteger(maxItems) && maxItems >= 0)
  if (!isValidMaxItems) {
    throw new Error("$: maxItems must be a non-negative safe integer")
  }
  return { maxBytes, maxItems }
}

function cacheEntry(schema: Schema.Constraint): CodecCacheEntry {
  const cached = codecCache.get(schema)
  if (cached !== undefined) {
    return cached
  }
  const deferred = prepare(schema.ast)
  const entry: CodecCacheEntry = {
    encoded: Schema.toEncoded(schema).ast,
    deferred,
    layouts: new Map(),
    codecs: new Map(),
  }
  codecCache.set(schema, entry)
  return entry
}

/** Without maxItems, collections compile to layouts that do no counting at all. */
function layoutOf(entry: CodecCacheEntry, countItems: boolean): Layout {
  const cached = entry.layouts.get(countItems)
  if (cached !== undefined) {
    return cached
  }
  const layout = compile(entry.encoded, { countItems, ...entry.deferred })
  entry.layouts.set(countItems, layout)
  return layout
}

/**
 * Reader options for the parse options of a decode, where `disableChecks` turns off the schema's
 * own length checks. Both variants are built once, so decoding allocates no options object.
 */
function readerOptions(
  maxBytes: number,
  maxItems = Infinity,
): (parseOptions: SchemaAST.ParseOptions | undefined) => ReaderOptions {
  const checked = { maxBytes, maxItems, checks: true }
  const unchecked = { maxBytes, maxItems, checks: false }
  return (parseOptions) => (parseOptions?.disableChecks === true ? unchecked : checked)
}

/** Bytes to the schema's encoded value and back; toCodec layers the schema itself on top. */
function binaryCodec(layout: Layout, maxBytes: number, maxItems = Infinity) {
  const optionsFor = readerOptions(maxBytes, maxItems)
  return Schema.Uint8Array.pipe(
    Schema.decodeTo(
      Schema.Unknown,
      SchemaTransformation.transformEffect({
        decode: (bytes, options) =>
          Effect.try({
            try: () => {
              const reader = new Reader(bytes, optionsFor(options))
              const value = layout.read(reader)
              if (reader.offset !== bytes.byteLength) {
                throw new BinaryError(reader.offset, "Trailing bytes")
              }
              return value
            },
            catch: binaryFailure,
          }),
        encode: (value) =>
          Effect.try({
            try: () => {
              const writer = new Writer(maxBytes, maxItems)
              layout.write(writer, value)
              return writer.finish()
            },
            catch: binaryFailure,
          }),
      }),
    ),
  )
}

/**
 * A value decoded from the start of a byte range, with the offset just past it.
 *
 * **Example** (Reading the rest of a packet)
 *
 * ```ts
 * import { Borsh } from "@zorsh/effect"
 *
 * const decodeId = Borsh.decodePrefixSync(Borsh.U32)
 * const { value: id, offset } = decodeId(Uint8Array.of(7, 0, 0, 0, 0xff))
 * // id: 7, offset: 4
 * ```
 *
 * @category models
 * @since 0.1.0
 */
export interface Prefix<A> {
  readonly value: A
  /** Where the next value starts: the input offset plus the bytes this value used. */
  readonly offset: number
}

/** Read one encoded value at offset; the prefix decoders run the schema pass on top. */
type PrefixReader = (
  bytes: Uint8Array,
  offset: number,
  parseOptions: SchemaAST.ParseOptions | undefined,
) => Prefix<unknown>

function prefixReader(schema: Schema.Constraint, options: Options | undefined): PrefixReader {
  const { maxBytes, maxItems } = validLimits(options)
  const layout = layoutOf(cacheEntry(schema), maxItems !== undefined)
  // Every layout whose length can vary starts with a length prefix or a tag, so a minimum of zero
  // bytes means the value always encodes to none, and a loop decoding it would never advance.
  if (layout.minBytes === 0) {
    throw new Error(
      "$: Prefix decoding requires a schema that encodes to at least one byte; this one always encodes to zero bytes, so a decoding loop would never advance",
    )
  }
  const optionsFor = readerOptions(maxBytes, maxItems)
  return (bytes, offset, parseOptions) => {
    // Not BinaryErrors: invalid arguments are caller bugs, so they are defects.
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("Prefix decoding requires a Uint8Array")
    }
    // Schema.decodeSync takes parse options second, so this is an easy slip.
    if (typeof offset !== "number") {
      throw new TypeError("Prefix offset must be a number; parse options are the third argument")
    }
    const isValidOffset = Number.isSafeInteger(offset) && offset >= 0 && offset <= bytes.byteLength
    if (!isValidOffset) {
      throw new RangeError(
        `Prefix offset must be an integer from 0 through ${bytes.byteLength}, got ${offset}`,
      )
    }
    const reader = new Reader(bytes, optionsFor(parseOptions), offset)
    return { value: layout.read(reader), offset: reader.offset }
  }
}

/** A binary failure as the SchemaError a codec reports; any other error is rethrown. */
function binarySchemaError(error: unknown): Schema.SchemaError {
  return new Schema.SchemaError(binaryFailure(error))
}

/**
 * Decodes one value from `bytes` at `offset`, allowing bytes after it.
 *
 * **Details**
 *
 * It uses the same layout, limits, schema pass and errors as {@link toCodec},
 * but stops after one value instead of requiring the whole input. `maxBytes`
 * caps the bytes this value may use, not the length of `bytes`: as soon as a
 * read's length or count shows that the value cannot fit, it fails with
 * "Value exceeds maxBytes", however short `bytes` is. "Truncated" only means
 * `bytes` ended before the current read. Byte offsets in errors are positions
 * in `bytes`. Binary failures carry the same issue `toCodec`
 * reports, without the `Encoding` wrappers of its codec. Decoding middleware
 * on the schema, such as `Schema.catchDecoding`, can recover from schema-pass
 * failures but not from binary ones, unlike with `toCodec`, because a value
 * that was never read has no end to return as `offset`.
 *
 * `offset` defaults to 0 and must be an integer from 0 through
 * `bytes.byteLength`. Any other offset is a defect, not a `SchemaError`: a
 * `TypeError` if it is not a number and a `RangeError` otherwise. A `bytes`
 * that is not a `Uint8Array` is a `TypeError` defect too. A schema that always
 * encodes to zero bytes, such as `Borsh.Unit`, an empty struct or
 * `fixedArray(0)`, throws at construction, because a loop decoding it would
 * never advance. Every other schema reads at least one byte per value.
 *
 * **Example** (Concatenated frames)
 *
 * ```ts
 * import { Borsh } from "@zorsh/effect"
 * import { Effect, Schema } from "effect"
 *
 * const Frame = Schema.Struct({ id: Borsh.U32, body: Schema.String })
 * const decodeFrame = Borsh.decodePrefixEffect(Frame, { maxBytes: 1 << 20, maxItems: 10_000 })
 *
 * const decodeAll = Effect.fnUntraced(function* (buffer: Uint8Array) {
 *   const frames: Array<typeof Frame.Type> = []
 *   let offset = 0
 *   while (offset < buffer.byteLength) {
 *     const next = yield* decodeFrame(buffer, offset)
 *     frames.push(next.value)
 *     offset = next.offset
 *   }
 *   return frames
 * })
 * ```
 *
 * @category decoding
 * @since 0.1.0
 */
export function decodePrefixEffect<S extends Schema.Constraint>(
  schema: S,
  options?: Options,
): (
  bytes: Uint8Array,
  offset?: number,
  parseOptions?: SchemaAST.ParseOptions,
) => Effect.Effect<Prefix<S["Type"]>, Schema.SchemaError, S["DecodingServices"]> {
  const read = prefixReader(schema, options)
  const decodeValue = Schema.decodeUnknownEffect(schema)
  return (bytes, offset = 0, parseOptions) =>
    Effect.try({ try: () => read(bytes, offset, parseOptions), catch: binarySchemaError }).pipe(
      Effect.flatMap((prefix) =>
        decodeValue(prefix.value, parseOptions).pipe(
          Effect.map((value) => ({ value, offset: prefix.offset })),
        ),
      ),
    )
}

/**
 * Like {@link decodePrefixEffect}, but synchronous; it throws
 * `Schema.SchemaError`, or a `TypeError` or `RangeError` for invalid
 * arguments. Like
 * `Schema.decodeSync`, it accepts only schemas without decoding services.
 *
 * **Example** (A message inside an envelope)
 *
 * ```ts
 * import { Borsh } from "@zorsh/effect"
 * import { Schema } from "effect"
 *
 * // A u32 tag, then one Borsh message, then an unrelated trailer.
 * const Message = Schema.Struct({ sender: Schema.String, amount: Borsh.U64 })
 * const decodeMessage = Borsh.decodePrefixSync(Message, { maxBytes: 64 * 1024 })
 *
 * const open = (packet: Uint8Array) => {
 *   const { value: message, offset: end } = decodeMessage(packet, 4)
 *   return { message, trailer: packet.subarray(end) }
 * }
 * ```
 *
 * @category decoding
 * @since 0.1.0
 */
export function decodePrefixSync<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  options?: Options,
): (
  bytes: Uint8Array,
  offset?: number,
  parseOptions?: SchemaAST.ParseOptions,
) => Prefix<S["Type"]> {
  const read = prefixReader(schema, options)
  const decodeValue = Schema.decodeUnknownSync(schema)
  return (bytes, offset = 0, parseOptions) => {
    let prefix: Prefix<unknown>
    try {
      prefix = read(bytes, offset, parseOptions)
    } catch (error) {
      throw binarySchemaError(error)
    }
    return { value: decodeValue(prefix.value, parseOptions), offset: prefix.offset }
  }
}
