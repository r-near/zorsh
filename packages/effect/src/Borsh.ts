/**
 * Borsh codecs derived from native Effect schemas. Add a width or layout where Rust needs one, then
 * derive a codec with {@link toCodec}.
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
import { checkEnum, compile, maxLengthId, withBytesId, withLayout } from "./internal/compile.js"
import { BinaryError, Reader, type Limits, utf8Length, Writer } from "./internal/io.js"
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

/** Rust `u8`: an integer `number` from 0 to 255. */
export const U8 = integer(8, false)
/** Rust `u16`: an integer `number` from 0 to 65535. */
export const U16 = integer(16, false)
/** Rust `u32`: an integer `number` from 0 to 2^32 - 1. */
export const U32 = integer(32, false)
/** Rust `i8`: an integer `number` from -128 to 127. */
export const I8 = integer(8, true)
/** Rust `i16`: an integer `number` from -32768 to 32767. */
export const I16 = integer(16, true)
/** Rust `i32`: an integer `number` from -2^31 to 2^31 - 1. */
export const I32 = integer(32, true)
/** Rust `u64`: a `bigint` from 0 to 2^64 - 1. */
export const U64 = bigInteger(64, false)
/** Rust `u128`: a `bigint` from 0 to 2^128 - 1. */
export const U128 = bigInteger(128, false)
/** Rust `i64`: a `bigint` from -2^63 to 2^63 - 1. */
export const I64 = bigInteger(64, true)
/** Rust `i128`: a `bigint` from -2^127 to 2^127 - 1. */
export const I128 = bigInteger(128, true)

/**
 * Rust `f32`: a `number` exactly representable as binary32, so round with `Math.fround`. NaN is
 * rejected. Effect has no binary32 generator, so samples are integers within ±2^24, and refinements
 * must admit one.
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
/** Rust `f64`: a binary64 `number`. Infinities and signed zero are allowed; NaN is rejected. */
export const F64 = withLayout(Schema.Number, { kind: "float", bits: 64 }).check(
  Schema.makeFilter((n) => !Number.isNaN(n), { expected: "a non-NaN number" }),
)

/** Rust `Vec<u8>`: `Schema.Uint8Array`, written as a u32 length, then the bytes. */
export const Bytes = Schema.Uint8Array
/** Rust `()`: the empty tuple, which writes no bytes. */
export const Unit = Schema.Tuple([])

/**
 * Rust `[u8; N]`: exactly `length` bytes with no prefix. Other lengths fail the schema's length
 * check. `length` is an integer from 0 through 2^32 - 1.
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
 * Rust `[T; N]`: `Schema.Array(item)` with an exact-length check, written without a count prefix,
 * so samples have `length` items. `length` is an integer from 0 through 2^32 - 1.
 *
 * **Example** (Rust `[u16; 3]`)
 *
 * ```ts
 * const Amounts = Borsh.fixedArray(Borsh.U16, 3)
 * const bytes = Schema.encodeSync(Borsh.toCodec(Amounts))([7, 513, 0])
 * // Uint8Array [7, 0, 1, 2, 0, 0]
 * ```
 */
export function fixedArray<S extends Schema.Constraint>(item: S, length: number): Schema.$Array<S> {
  if (!isU32Length(length)) {
    throw new Error("$: fixedArray length must be a safe integer between 0 and 2^32 - 1")
  }
  return withLayout(Schema.Array(item), { kind: "fixedArray", length }).check(
    Schema.isBetweenLength(length, length),
  )
}

/** The schema returned by {@link withBytes}. */
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
 * Keeps a value's exact Borsh bytes: decodes to `{ value, bytes }`, where `bytes` is a copy of the
 * span `value` was read from, and adds nothing to the wire. Encoding writes `value` and fails at
 * `["bytes"]`, at the first differing offset, unless that reproduces `bytes`.
 *
 * A decoded value re-encodes to its bytes unless `schema` substitutes a value while decoding, as a
 * lossy transformation or decoding middleware can. Samples carry the bytes `schema` encodes their
 * value to, so samples of `Schema.toType`, `toEncoded` or `flip` of this schema can fail to encode
 * when `schema` has a transformation.
 *
 * **Example** (Verify a signature over the transaction's exact bytes)
 *
 * ```ts
 * const Transaction = Schema.Struct({ receiverId: Schema.String, nonce: Borsh.U64 })
 * const SignedTransaction = Schema.Struct({
 *   transaction: Borsh.withBytes(Transaction),
 *   signature: Borsh.fixedBytes(64),
 * })
 * const signed = Schema.decodeSync(Borsh.toCodec(SignedTransaction))(input)
 * verify(signed.signature, sha256(signed.transaction.bytes))
 * ```
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
 * Rust `#[borsh(use_discriminant = true)]`: explicit u8 discriminants for an enum schema, keyed by
 * `_tag` value, literal value as a string, or TS enum member name. Pass `{ tag: "kind" }` for a
 * union tagged by another field, and apply `Schema.toTaggedUnion("kind")` after this, not before.
 *
 * The map annotates the union itself, so a union rebuilt from its members needs it again. A dataless
 * single-variant enum is zero-sized without a map and `#[repr(u8)]` with one. borsh-rs still treats
 * a `use_discriminant` one without `#[repr]` as zero-sized, and rejects vectors of it that this
 * codec accepts.
 *
 * **Example** (Sparse discriminants)
 *
 * ```ts
 * // enum Flag { Off = 1, On = 5 }
 * const Flag = Schema.TaggedUnion({ Off: {}, On: {} }).pipe(Borsh.discriminants({ Off: 1, On: 5 }))
 * const bytes = Schema.encodeSync(Borsh.toCodec(Flag))({ _tag: "On" })
 * // Uint8Array [5]
 * ```
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
    checkEnum(Schema.toEncoded(schema).ast, layout)
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
 * Bounds one Borsh length prefix: vector items, string UTF-8 bytes, `Bytes` length, map entries or
 * set members. The smallest of several bounds applies. `n` is an integer from 0 through 2^32 - 1.
 *
 * Effect also runs it as an ordinary check, so `Schema.is`, `make` and samples agree with the wire,
 * and `annotations` shape that failure; a lone UTF-16 surrogate fails it. After a transformation,
 * including on a union with a transformed member, it is only that check, and on a layout without a
 * length prefix {@link toCodec} throws. Maps and sets are bounded by their count on the wire,
 * before keys that decode equal merge.
 *
 * **Example** (Bounded strings and vectors)
 *
 * ```ts
 * const Log = Schema.Struct({
 *   message: Schema.String.check(Borsh.maxLength(1024)),
 *   tags: Schema.Array(Schema.String).check(Borsh.maxLength(16)),
 * })
 * const codec = Borsh.toCodec(Log, { maxItems: 1_000 })
 * ```
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
 * Wire limits for {@link toCodec} and the prefix decoders. With both set, decoding the binary layout
 * does work and allocates memory in proportion to `maxBytes` plus `maxItems`; the schema pass runs
 * the schema's own code, `Schema.isMaxLength` included, and is not bounded.
 */
export interface Options {
  /**
   * Maximum bytes per operation, as a positive safe integer; for a prefix decoder, the bytes the
   * value may use. Default: 16 MiB.
   */
  readonly maxBytes?: number | undefined
  /**
   * Maximum collection items per operation, as a non-negative safe integer: every vector or
   * fixed-array item, map entry and set member, however nested, charged when its length is read or
   * written. Strings and bytes count toward `maxBytes` only. Default: no limit.
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
 * Derives a Borsh codec from the encoded side of a schema, whose checks, brands, transformations and
 * services still apply. Unsupported layouts and invalid options throw here. Decoding must consume
 * the whole input. Codecs are memoized per schema for up to 8 option combinations.
 *
 * **Example** (Bounding untrusted input)
 *
 * ```ts
 * const Receipt = Schema.Struct({
 *   logs: Schema.Array(Schema.String).check(Borsh.maxLength(100)),
 *   payload: Borsh.Bytes.check(Borsh.maxLength(64 * 1024)),
 * })
 * const codec = Borsh.toCodec(Receipt, { maxBytes: 256 * 1024, maxItems: 10_000 })
 * // A `logs` count of 2^32 - 1 fails right after its 4-byte prefix:
 * // Length 4294967295 exceeds maxLength (100) at byte 0
 * ```
 */
export function toCodec<S extends Schema.Constraint>(
  schema: S,
  options?: Options,
): Schema.Codec<S["Type"], Uint8Array, S["DecodingServices"], S["EncodingServices"]> {
  const limits = validLimits(options)
  const entry = cacheEntry(schema)
  // Without maxItems the key stays a number, so the common lookup builds no string.
  const key =
    limits.maxItems === Infinity ? limits.maxBytes : `${limits.maxBytes}/${limits.maxItems}`
  const cached = entry.codecs.get(key)
  if (cached !== undefined) {
    return cached as Schema.Codec<
      S["Type"],
      Uint8Array,
      S["DecodingServices"],
      S["EncodingServices"]
    >
  }
  const codec = binaryCodec(entry.layout, limits).pipe(Schema.decodeTo(schema))
  // Maps iterate in insertion order, so this evicts the oldest options.
  if (entry.codecs.size >= optionsCacheSize) {
    entry.codecs.delete(entry.codecs.keys().next().value as number | string)
  }
  entry.codecs.set(key, codec)
  return codec
}

/** Validate options at construction. Only an absent option takes the default; null is rejected. */
function validLimits(options: Options | undefined): Limits {
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
  return { maxBytes, maxItems: maxItems ?? Infinity }
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
function binaryCodec(layout: Layout, limits: Limits) {
  return Schema.Uint8Array.pipe(
    Schema.decodeTo(
      Schema.Unknown,
      SchemaTransformation.transformEffect({
        decode: (bytes) =>
          Effect.try({
            try: () => {
              const reader = new Reader(bytes, limits)
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
              const writer = new Writer(limits.maxBytes, limits.maxItems)
              layout.write(writer, value)
              return writer.finish()
            },
            catch: binaryFailure,
          }),
      }),
    ),
  )
}

/** A value decoded from the start of a byte range, with the offset just past it. */
export interface Prefix<A> {
  readonly value: A
  /** Where the next value starts: the input offset plus the bytes this value used. */
  readonly offset: number
}

/** Read one encoded value at offset; the prefix decoders run the schema pass on top. */
type PrefixReader = (bytes: Uint8Array, offset: number) => Prefix<unknown>

function prefixReader(schema: Schema.Constraint, options: Options | undefined): PrefixReader {
  const limits = validLimits(options)
  const layout = cacheEntry(schema).layout
  // Every layout whose length can vary starts with a length prefix or a tag, so a minimum of zero
  // bytes means the value always encodes to none, and a loop decoding it would never advance.
  if (layout.minBytes === 0) {
    throw new Error(
      "$: Prefix decoding requires a schema that encodes to at least one byte; this one always encodes to zero bytes, so a decoding loop would never advance",
    )
  }
  return (bytes, offset) => {
    // Not a BinaryError: an offset outside the input is a caller bug, so it is a defect.
    const isValidOffset = Number.isSafeInteger(offset) && offset >= 0 && offset <= bytes.byteLength
    if (!isValidOffset) {
      throw new RangeError(
        `Prefix offset must be an integer from 0 through ${bytes.byteLength}, got ${offset}`,
      )
    }
    const reader = new Reader(bytes, limits, offset)
    return { value: layout.read(reader), offset: reader.offset }
  }
}

/** A binary failure as the SchemaError a codec reports; any other error is rethrown. */
function binarySchemaError(error: unknown): Schema.SchemaError {
  return new Schema.SchemaError(binaryFailure(error))
}

/**
 * Decodes one value from `bytes` at `offset`, 0 by default, allowing bytes after it. It shares
 * {@link toCodec}'s layout, limits, schema pass and errors. Decoding middleware on the schema can
 * recover from schema-pass failures but not binary ones, which leave no `offset` to return.
 *
 * **Example** (Concatenated frames)
 *
 * ```ts
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
 * Like {@link decodePrefixEffect}, but synchronous: it throws `Schema.SchemaError`, or a `RangeError`
 * for an offset outside `bytes`, and accepts only schemas without decoding services.
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
