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
import { isU32Length, maxLengthId, parseDiscriminants, withLayout } from "./internal/annotations.js"
import { compile, type Layout } from "./internal/compiler.js"
import { enumVariants } from "./internal/enums.js"
import { BinaryError, Reader, type ReaderOptions, utf8Length, Writer } from "./internal/io.js"
import { isValueWithBytes, type ValueWithBytes, withBytesId } from "./internal/natives.js"
import { integerRange } from "./internal/primitives.js"

function integer(bits: 8 | 16 | 32, signed: boolean) {
  const { minimum, maximum } = integerRange(bits, signed)
  return withLayout(Schema.Int, {
    kind: "integer",
    bits,
    signed,
  }).check(Schema.isBetween({ minimum: Number(minimum), maximum: Number(maximum) }))
}

function bigInteger(bits: 64 | 128, signed: boolean): Schema.BigInt {
  return withLayout(Schema.BigInt, {
    kind: "integer",
    bits,
    signed,
  }).check(Schema.isBetweenBigInt(integerRange(bits, signed)))
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
export const F64 = withLayout(Schema.Number, {
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
    kind: "fixedBytes",
    length,
  }).check(Schema.isBetweenLength(length, length))
}

/**
 * Rust `[T; N]`: exactly `length` items of `item` with no count prefix.
 *
 * **Details**
 *
 * The schema is a native `Schema.Array(item)` with an exact-length check, so
 * other lengths fail Schema validation, samples have `length` items and JSON
 * Schema gets `minItems` and `maxItems`. Annotate, brand or transform the
 * result like any other array schema; as with any checked schema, later
 * annotations attach to the length check. `length` must be an integer from 0
 * through 2^32 - 1.
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
 * returns `{ value, bytes }`, where `bytes` is a copy of the span that `value`
 * was read from: hash or verify a signature over it, or store or forward it
 * unchanged. Failures inside `value` are reported under `["value"]`.
 *
 * Encoding writes `value`, never `bytes`, and fails at `["bytes"]` unless that
 * reproduces `bytes` exactly, naming the output offset where they first
 * differ. Borsh decoding is strict, so a decoded value always re-encodes to its
 * bytes unless `schema` substitutes a value while decoding, as a lossy
 * transformation or decoding middleware can. To build a new outgoing value,
 * encode it with `schema` itself, which writes the same bytes.
 *
 * `bytes` is copied, never a view into the decoded input, so it stays valid
 * when the caller reuses its buffer. Samples from `Arbitrary.schema` carry the
 * bytes `schema` encodes their value to. Samples that `schema` cannot encode,
 * such as strings with lone surrogates, are discarded, and a `schema` whose
 * encoding needs services cannot be sampled. Samples of `Schema.toType`,
 * `Schema.toEncoded` or `Schema.flip` applied to this schema are still encoded
 * with `schema`, so when it has a transformation they can be discarded, or
 * carry bytes that differ from what the derived schema writes and so fail to
 * encode at `["bytes"]`.
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
 * when it is applied to a schema.
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
 * `Schema.String.check(Borsh.maxLength(1024))`. Decoding fails as soon as it
 * reads a larger length, before reading anything after it, and encoding fails
 * before writing the length, with `Length 2000 exceeds maxLength (1024)`, the
 * path and the byte offset. Like `maxBytes`, it is part of the codec, so it
 * also applies under `disableChecks`, and decoding middleware nested in the
 * schema, such as a field's `Schema.catchDecoding`, cannot recover from it. As
 * with truncated input, only middleware on the schema's root can.
 *
 * Effect also runs it as an ordinary check, so `Schema.is`, `make`, Arbitrary
 * samples and encoding agree with the wire. A string with a lone UTF-16
 * surrogate has no UTF-8 length and fails with "Lone UTF-16 surrogate".
 * `annotations` shape that schema-pass failure, not the wire one. After a
 * transformation, `maxLength` is only an ordinary check. On a layout without a
 * length prefix, such as `fixedBytes`, `fixedArray`, a tuple, a struct or an
 * enum, {@link toCodec} throws. The smallest of several bounds applies. It
 * bounds the count on the wire, so a map or set whose keys merge as they decode
 * can fail it while holding fewer entries. `n` must be an integer from 0
 * through 2^32 - 1.
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
 * The binary layer checks every length prefix against the bytes that remain,
 * so no string or byte array allocates past the input, but small items, such
 * as unit enum variants or `Option.none()`, let one input byte become one
 * decoded value. Set `maxBytes` and `maxItems` to the largest message you
 * expect, and bound single length prefixes with {@link maxLength}: vector
 * items, string UTF-8 bytes, `Borsh.Bytes` length, map entries and set
 * members. With both options set, decoding the binary layout of a schema does
 * work and allocates memory in proportion to `maxBytes` plus `maxItems`,
 * whatever the input claims. That bound covers only the binary layer: checks,
 * filters and transformations in the schema pass are the schema's own code
 * and can do any amount of work. Effect's own checks, such as
 * `Schema.isMaxLength`, run there, after the binary layer has read the value.
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
 * Unsupported layouts and invalid options throw here, at construction. Decoding
 * must consume the whole input. Binary failures are `Schema.SchemaError`s whose
 * issue names the path and byte offset. Codecs are memoized by schema identity,
 * `maxBytes` and `maxItems`, keeping up to 8 option combinations per schema.
 *
 * The only limits on the wire are the ones you write: `maxBytes` and
 * `maxItems` in {@link Options}, and {@link maxLength} on a length prefix.
 * Every other check, including Effect's own `Schema.isMaxLength` and
 * `isMaxSize`, runs in the schema pass after the binary layer has read the
 * value.
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
 * `fixedArray(item, 0)`, throws at construction, because a loop decoding it
 * would never advance. Every other schema reads at least one byte per value.
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
      prefix = read(bytes, offset)
    } catch (error) {
      throw binarySchemaError(error)
    }
    return { value: decodeValue(prefix.value, parseOptions), offset: prefix.offset }
  }
}
