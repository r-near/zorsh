/**
 * Borsh codecs derived from native Effect schemas.
 *
 * Build a schema with Effect's `Schema` module, use these constants and
 * combinators where Rust needs an explicit width or layout, then derive a codec
 * with {@link toCodec}.
 *
 * @since 0.1.0
 */
import {
  Effect,
  Formatter,
  HashMap,
  HashSet,
  Order,
  Schema,
  SchemaAST,
  SchemaGetter,
  SchemaIssue,
  SchemaParser,
  SchemaTransformation,
} from "effect"
import { compile, enumVariants, maxLengthId, withBytesId, withLayout } from "./internal/compile.js"
import { BinaryError, Reader, type ReaderOptions, utf8Length, Writer } from "./internal/io.js"
import {
  integerRange,
  isValueWithBytes,
  type Layout,
  type ValueWithBytes,
} from "./internal/layout.js"

/** Rust collection and array lengths: a safe integer that fits in a u32. */
function isU32Length(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff
  )
}

function integer(bits: 8 | 16 | 32, signed: boolean) {
  const { minimum, maximum } = integerRange(bits, signed)
  return withLayout(Schema.Int, { kind: "integer", bits, signed }).check(
    Schema.isBetween({ minimum: Number(minimum), maximum: Number(maximum) }),
  )
}

function bigInteger(bits: 64 | 128, signed: boolean): Schema.BigInt {
  return withLayout(Schema.BigInt, { kind: "integer", bits, signed }).check(
    Schema.isBetweenBigInt(integerRange(bits, signed)),
  )
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
export const F32 = withLayout(Schema.Number, { kind: "float", bits: 32 }).check(
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
export const F64 = withLayout(Schema.Number, { kind: "float", bits: 64 }).check(
  Schema.makeFilter((n) => !Number.isNaN(n), { expected: "a non-NaN number" }),
)

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
 * Other lengths fail the schema's length check. `length` must be an integer
 * from 0 through 2^32 - 1.
 *
 * @category bytes
 * @since 0.1.0
 */
export function fixedBytes(length: number): Schema.Uint8Array {
  if (!isU32Length(length)) {
    throw new Error("$: fixedBytes length must be a safe integer between 0 and 2^32 - 1")
  }
  return withLayout(Bytes, { kind: "fixedBytes", length }).check(
    Schema.isBetweenLength(length, length),
  )
}

/**
 * Rust `[T; N]`: exactly `length` items of `item` with no count prefix.
 *
 * **Details**
 *
 * The schema is a native `Schema.Array(item)` with an exact-length check, so
 * other lengths fail validation and samples have `length` items. `length`
 * must be an integer from 0 through 2^32 - 1.
 *
 * **Example** (Rust `[u16; 3]`)
 *
 * ```ts
 * import { Borsh } from "@zorsh/effect"
 * import { Schema } from "effect"
 *
 * const Amounts = Borsh.fixedArray(Borsh.U16, 3)
 * const bytes = Schema.encodeSync(Borsh.toCodec(Amounts))([7, 513, 0])
 * // Uint8Array [7, 0, 1, 2, 0, 0]
 * ```
 *
 * @category containers
 * @since 0.1.0
 */
export function fixedArray<S extends Schema.Constraint>(item: S, length: number): Schema.$Array<S> {
  if (!isU32Length(length)) {
    throw new Error("$: fixedArray length must be a safe integer between 0 and 2^32 - 1")
  }
  return withLayout(Schema.Array(item), { kind: "fixedArray", length }).check(
    Schema.isBetweenLength(length, length),
  )
}

/**
 * The schema returned by {@link withBytes}.
 *
 * @category models
 * @since 0.1.0
 */
export interface withBytes<S extends Schema.Top> extends Schema.declareConstructor<
  { readonly value: S["Type"]; readonly bytes: Uint8Array },
  { readonly value: S["Encoded"]; readonly bytes: Uint8Array },
  readonly [S],
  { readonly value: S["Iso"]; readonly bytes: Uint8Array }
> {
  readonly Rebuild: withBytes<S>
  readonly schema: S
}

/**
 * Keeps the exact Borsh bytes of a value next to the decoded value.
 *
 * **Details**
 *
 * The wire layout is the layout of `schema`, with nothing added. Decoding
 * returns `{ value, bytes }`, where `bytes` is a copy of the span `value` was
 * read from, safe to keep after the input buffer is reused. Encoding writes
 * `value`, never `bytes`, and fails at `["bytes"]`, with the first differing
 * offset, unless that reproduces `bytes` exactly. A decoded value always
 * re-encodes to its bytes unless `schema` substitutes a value while decoding,
 * as a lossy transformation or decoding middleware can. To build a new
 * outgoing value, encode it with `schema` itself, which writes the same bytes.
 * `Arbitrary.schema` samples carry the bytes `schema` encodes their value to,
 * so samples of `Schema.toType`, `toEncoded` or `flip` applied to this schema
 * can fail to encode when `schema` has a transformation.
 *
 * **Example** (Verify a signature over the transaction's exact bytes)
 *
 * ```ts
 * import { Borsh } from "@zorsh/effect"
 * import { Schema } from "effect"
 *
 * const Transaction = Schema.Struct({ receiverId: Schema.String, nonce: Borsh.U64 })
 * const SignedTransaction = Schema.Struct({
 *   transaction: Borsh.withBytes(Transaction),
 *   signature: Borsh.fixedBytes(64),
 * })
 *
 * const signed = Schema.decodeSync(Borsh.toCodec(SignedTransaction))(input)
 * verify(signed.signature, sha256(signed.transaction.bytes))
 * signed.transaction.value.receiverId
 * ```
 *
 * @category containers
 * @since 0.1.0
 */
export function withBytes<S extends Schema.Top>(schema: S): withBytes<S> {
  const declaration = Schema.declareConstructor<
    ValueWithBytes<S["Type"]>,
    ValueWithBytes<S["Encoded"]>,
    ValueWithBytes<S["Iso"]>
  >()(
    [schema],
    ([value]) =>
      (input, ast, options) => {
        if (!isValueWithBytes(input)) {
          return Effect.fail(new SchemaIssue.InvalidType(ast, input, options))
        }
        return Effect.mapBothEager(SchemaParser.decodeUnknownEffect(value)(input.value, options), {
          onSuccess: (decoded) => ({ value: decoded, bytes: input.bytes }),
          onFailure: (issue) =>
            new SchemaIssue.Composite(
              ast,
              [new SchemaIssue.Pointer(["value"], issue)],
              input,
              options,
            ),
        })
      },
    {
      representation: { id: withBytesId, payload: null },
      expected: "a value with its Borsh bytes",
      toCode: ({ typeParameters: [value] }) => ({
        runtime: `Borsh.withBytes(${value?.runtime})`,
        Type: `{ readonly value: ${value?.Type}; readonly bytes: Uint8Array }`,
        importDeclarations: [`import { Borsh } from "@zorsh/effect"`],
      }),
      // JSON and other canonical codecs see a plain struct, with `bytes` in Effect's usual form.
      toCodec: ([value]) =>
        Schema.link<ValueWithBytes<S["Encoded"]>>()(
          Schema.Struct({ value, bytes: Schema.Uint8Array }),
          SchemaTransformation.passthrough(),
        ),
      toCodecArbitrary: ({ typeParameters: [value] }) => sampleWithBytes(schema, value),
      toEquivalence:
        ([value]) =>
        (left, right) =>
          sameBytes(left.bytes, right.bytes) && value(left.value, right.value),
      toFormatter:
        ([value]) =>
        ({ value: item, bytes }) =>
          `{ "value": ${value(item)}, "bytes": ${Formatter.format(bytes)} }`,
    },
  )
  return Schema.make<withBytes<S>>(declaration.ast, { schema })
}

/**
 * Generates `value` from the hook's type-side parameter and derives `bytes` by encoding it with
 * `schema`. The hook cannot tell this schema from `Schema.toType`, `toEncoded` or `flip` applied
 * to it, so it always describes this one; the encode check rejects bytes that do not match.
 */
function sampleWithBytes(schema: Schema.Top, parameter: Schema.Codec<unknown>): SchemaAST.Link {
  // Arbitrary links cannot require services, so a schema that needs them dies when sampled.
  const encode = SchemaParser.encodeUnknownEffect(
    toCodec(schema) as Schema.Codec<unknown, Uint8Array>,
  )
  return Schema.link<ValueWithBytes<unknown>>()(parameter, {
    // A failure discards the sample, so samples that cannot be encoded never carry wrong bytes.
    decode: SchemaGetter.transformEffect((value) =>
      Effect.map(encode(value), (bytes) => ({ value, bytes })),
    ),
    // Arbitrary only generates through the link, from the parameter to `{ value, bytes }`.
    encode: SchemaGetter.forbiddenEncoding,
  })
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, i) => byte === right[i])
}

/**
 * Rust `#[borsh(use_discriminant = true)]`: assigns explicit u8 discriminants
 * to an enum schema.
 *
 * **Details**
 *
 * Without this, each variant's discriminant is its declaration index. Keys are
 * the encoded `_tag` values, literal values as strings, or TS enum member
 * names; every variant needs exactly one unique integer from 0 to 255. Pass
 * `{ tag: "kind" }` for unions tagged by another literal field. Values are
 * checked when the combinator is called, and missing or unknown keys throw
 * when it is applied to a schema. The map annotates the union itself, so a
 * union rebuilt from its members needs it again. With `{ tag: "kind" }`,
 * apply `Schema.toTaggedUnion("kind")` after this combinator, not before, to
 * keep the union's helpers.
 *
 * A dataless single-variant enum is zero-sized in Rust unless it has a
 * `#[repr]`, which only matters for vectors of it. Without a map it is treated
 * as zero-sized, and with one as `#[repr(u8)]`, so `#[repr(u8)] enum E { Only }`
 * takes `Borsh.discriminants({ Only: 0 })`. A `use_discriminant` single-variant
 * enum without `#[repr]` is still zero-sized in Rust, so borsh-rs rejects
 * vectors of it that this codec accepts.
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
export function discriminants(
  map: Readonly<Record<string, number>>,
  options?: { readonly tag?: string | undefined },
): <S extends Schema.Top>(schema: S) => S["Rebuild"] {
  const layout = {
    kind: "enum",
    tag: options?.tag ?? "_tag",
    discriminants: parseDiscriminants(map),
  } as const
  return (schema) => {
    enumVariants(Schema.toEncoded(schema).ast, layout, "$")
    return withLayout(schema, layout)
  }
}

/** A frozen copy of a user's discriminant map, which must assign unique u8 values. */
function parseDiscriminants(
  map: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  // Read the map once, so a getter cannot pass validation and then store something else.
  const entries = Object.entries(map)
  const seen = new Set<number>()
  for (const [, discriminant] of entries) {
    const isU8 = Number.isInteger(discriminant) && discriminant >= 0 && discriminant <= 255
    if (!isU8 || seen.has(discriminant)) {
      throw new Error("$: Borsh enum discriminants must be unique integers from 0 to 255")
    }
    seen.add(discriminant)
  }
  return Object.freeze(Object.fromEntries(entries))
}

/** What a Borsh length prefix can count. */
type LengthPrefixed =
  | string
  | Uint8Array
  | ReadonlyArray<unknown>
  | ReadonlyMap<unknown, unknown>
  | ReadonlySet<unknown>
  | HashMap.HashMap<unknown, unknown>
  | HashSet.HashSet<unknown>

/**
 * Bounds a Borsh length prefix, whatever it counts: vector items, the UTF-8
 * bytes of a string, the bytes of `Borsh.Bytes`, map entries or set members.
 *
 * **Details**
 *
 * Put it on the encoded side, before any transformation, as in
 * `Schema.String.check(Borsh.maxLength(1024))`. Decoding fails right after
 * reading a larger length, and encoding before writing one, with
 * `Length 2000 exceeds maxLength (1024)`, the path and the byte offset. Like
 * `maxBytes`, it applies under `disableChecks`, and decoding middleware inside
 * the schema, such as a field's `Schema.catchDecoding`, cannot recover from it.
 *
 * Effect also runs it as an ordinary check, so `Schema.is`, `make` and
 * Arbitrary samples agree with the wire; `annotations` shape that failure. A
 * string with a lone UTF-16 surrogate fails it. After a transformation,
 * including on a union with a transformed member, it is only an ordinary
 * check. On a layout without a length prefix, such as `fixedBytes`, a tuple, a
 * struct or an enum, {@link toCodec} throws. The smallest of several bounds
 * applies. Maps and sets are bounded by their count on the wire, before keys
 * that decode equal merge. `n` must be an integer from 0 through 2^32 - 1.
 *
 * **Example** (Bounded strings and vectors)
 *
 * ```ts
 * import { Borsh } from "@zorsh/effect"
 * import { Schema } from "effect"
 *
 * const Log = Schema.Struct({
 *   message: Schema.String.check(Borsh.maxLength(1024)),
 *   tags: Schema.Array(Schema.String).check(Borsh.maxLength(16)),
 * })
 * const codec = Borsh.toCodec(Log, { maxItems: 1_000 })
 * ```
 *
 * @category limits
 * @since 0.1.0
 */
export function maxLength(
  n: number,
  annotations?: Schema.Annotations.Filter,
): SchemaAST.Filter<LengthPrefixed> {
  if (!isU32Length(n)) {
    throw new Error("$: maxLength must be a safe integer between 0 and 2^32 - 1")
  }
  return Schema.makeFilter<LengthPrefixed>(
    (value) => {
      const length = prefixedLength(value, n)
      if (length < 0) {
        return "Lone UTF-16 surrogate"
      }
      return length <= n
    },
    {
      expected: `a Borsh length of at most ${n}`,
      ...annotations,
      // Last, so user annotations cannot remove the bound the compiler reads or the sampling hint.
      representation: { id: maxLengthId, payload: { maxLength: n } },
      // Strings sample in UTF-16 units; the predicate discards the few that overshoot in UTF-8.
      arbitraryConstraint: { maxLength: n, maxSize: n },
      // Effect drops non-structural checks from the encoded side of a container whose items
      // transform, and the compiler only sees the encoded side.
      "~structural": true,
    },
  )
}

/**
 * The count value's length prefix holds, -1 for a string with a lone surrogate, or Infinity for
 * a value without one. A string's count stops once it passes stop.
 */
function prefixedLength(value: unknown, stop: number): number {
  if (typeof value === "string") {
    return utf8Length(value, stop)
  }
  if (HashMap.isHashMap(value)) {
    return HashMap.size(value)
  }
  if (HashSet.isHashSet(value)) {
    return HashSet.size(value)
  }
  // Count bytes as the writer does, whatever a subclass reports as its length.
  if (value instanceof Uint8Array) {
    return value.byteLength
  }
  if (Array.isArray(value)) {
    return value.length
  }
  if (value instanceof Map || value instanceof Set) {
    return value.size
  }
  return Infinity
}

/**
 * Options for {@link toCodec}, {@link decodePrefixEffect} and {@link decodePrefixSync}.
 *
 * **Untrusted input**
 *
 * Every length prefix is checked against the bytes that remain, but small
 * items such as unit variants or `Option.none()` turn one input byte into one
 * value. Set `maxBytes` and `maxItems`, and bound single length prefixes with
 * {@link maxLength}. With both options set, decoding the binary layout does
 * work and allocates memory in proportion to `maxBytes` plus `maxItems`. That
 * bound covers only the binary layer: checks, filters and transformations in
 * the schema pass, Effect's own `Schema.isMaxLength` included, are the
 * schema's own code and can do any amount of work.
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
   * Maximum number of collection items per operation, as a non-negative safe
   * integer. It is one budget for the whole value: every vector or
   * fixed-array item, map entry and set member counts once, however deeply it
   * is nested. Strings and byte arrays don't count; `maxBytes` bounds them.
   * Each collection is charged when its length is read, and encoding is
   * bounded too, so anything a codec encodes it can also decode. Default: no
   * limit.
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
  const issue = new SchemaIssue.InvalidValue({ message: error.message })
  return error.path.length === 0 ? issue : new SchemaIssue.Pointer(error.path, issue)
}

interface CodecCacheEntry {
  readonly layout: Layout
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
 * Unsupported layouts and invalid options throw here. Decoding must consume
 * the whole input, and binary failures are `Schema.SchemaError`s naming the
 * path and byte offset. Codecs are memoized by schema and options, up to 8
 * option combinations per schema. The only wire limits are `maxBytes`,
 * `maxItems` and {@link maxLength}; every other check runs in the schema pass.
 *
 * **Example** (Bounding untrusted input)
 *
 * ```ts
 * import { Borsh } from "@zorsh/effect"
 * import { Schema } from "effect"
 *
 * const Receipt = Schema.Struct({
 *   logs: Schema.Array(Schema.String).check(Borsh.maxLength(100)),
 *   payload: Borsh.Bytes.check(Borsh.maxLength(64 * 1024)),
 * })
 * const codec = Borsh.toCodec(Receipt, { maxBytes: 256 * 1024, maxItems: 10_000 })
 * // A `logs` count of 2^32 - 1 fails right after its 4-byte prefix:
 * // Length 4294967295 exceeds maxLength (100) at byte 0
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
  const codec = binaryCodec(entry.layout, maxBytes, maxItems).pipe(Schema.decodeTo(schema))
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
  const entry: CodecCacheEntry = {
    layout: compile(Schema.toEncoded(schema).ast),
    codecs: new Map(),
  }
  codecCache.set(schema, entry)
  return entry
}

/** Bytes to the schema's encoded value and back; toCodec layers the schema itself on top. */
function binaryCodec(layout: Layout, maxBytes: number, maxItems = Infinity) {
  const readerOptions: ReaderOptions = { maxBytes, maxItems }
  return Schema.Uint8Array.pipe(
    Schema.decodeTo(
      Schema.Unknown,
      SchemaTransformation.transformEffect({
        decode: (bytes) =>
          Effect.try({
            try: () => {
              const reader = new Reader(bytes, readerOptions)
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
 * @category models
 * @since 0.1.0
 */
export interface Prefix<A> {
  readonly value: A
  /** Where the next value starts: the input offset plus the bytes this value used. */
  readonly offset: number
}

/** Read one encoded value at offset; the prefix decoders run the schema pass on top. */
type PrefixReader = (bytes: Uint8Array, offset: number) => Prefix<unknown>

function prefixReader(schema: Schema.Constraint, options: Options | undefined): PrefixReader {
  const { maxBytes, maxItems } = validLimits(options)
  const layout = cacheEntry(schema).layout
  // Every layout whose length can vary starts with a length prefix or a tag, so a minimum of zero
  // bytes means the value always encodes to none, and a loop decoding it would never advance.
  if (layout.minBytes === 0) {
    throw new Error(
      "$: Prefix decoding requires a schema that encodes to at least one byte; this one always encodes to zero bytes, so a decoding loop would never advance",
    )
  }
  const readerOptions: ReaderOptions = { maxBytes, maxItems: maxItems ?? Infinity }
  return (bytes, offset) => {
    // Not a BinaryError: an offset outside the input is a caller bug, so it is a defect.
    const isValidOffset = Number.isSafeInteger(offset) && offset >= 0 && offset <= bytes.byteLength
    if (!isValidOffset) {
      throw new RangeError(
        `Prefix offset must be an integer from 0 through ${bytes.byteLength}, got ${offset}`,
      )
    }
    const reader = new Reader(bytes, readerOptions, offset)
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
 * It shares the layout, limits, schema pass and errors of {@link toCodec}, but
 * stops after one value. Error offsets are positions in `bytes`. `maxBytes`
 * caps the bytes the value may use, not `bytes`: a read whose length or count
 * shows the value cannot fit fails with "Value exceeds maxBytes" however short
 * `bytes` is, while "Truncated" means `bytes` ended first. Decoding middleware
 * on the schema can recover from schema-pass failures but not binary ones,
 * which leave no `offset` to return.
 *
 * `offset` defaults to 0; an offset outside `bytes` is a `RangeError` defect,
 * not a `SchemaError`. A schema that always encodes to zero bytes, such as
 * `Borsh.Unit`, throws at construction, because a decoding loop would never
 * advance.
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
    Effect.try({ try: () => read(bytes, offset), catch: binarySchemaError }).pipe(
      Effect.flatMap((prefix) =>
        decodeValue(prefix.value, parseOptions).pipe(
          Effect.map((value) => ({ value, offset: prefix.offset })),
        ),
      ),
    )
}

/**
 * Like {@link decodePrefixEffect}, but synchronous: it throws
 * `Schema.SchemaError`, or a `RangeError` for an offset outside `bytes`. Like
 * `Schema.decodeSync`, it accepts only schemas without decoding services.
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
      prefix = read(bytes, offset)
    } catch (error) {
      throw binarySchemaError(error)
    }
    return { value: decodeValue(prefix.value, parseOptions), offset: prefix.offset }
  }
}
