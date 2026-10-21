import { Effect, Schema, type SchemaAST, SchemaIssue, SchemaTransformation } from "effect"
import { parseDescriptor, withLayout } from "./internal/annotations.js"
import { compile, enumVariants, type Layout, rejectSuspensions } from "./internal/compiler.js"
import { BinaryError, Reader, Writer } from "./internal/io.js"

function integer(bits: 8 | 16 | 32, signed: boolean) {
  const minimum = signed ? -(2 ** (bits - 1)) : 0
  const maximum = 2 ** (signed ? bits - 1 : bits) - 1
  return withLayout(Schema.Int, {
    version: 1,
    kind: "integer",
    bits,
    signed,
  }).check(Schema.isBetween({ minimum, maximum }))
}

function bigInteger(bits: 64 | 128, signed: boolean): Schema.BigInt {
  const minimum = signed ? -(1n << BigInt(bits - 1)) : 0n
  const maximum = (1n << BigInt(signed ? bits - 1 : bits)) - 1n
  return withLayout(Schema.BigInt, {
    version: 1,
    kind: "integer",
    bits,
    signed,
  }).check(Schema.isBetweenBigInt({ minimum, maximum }))
}

export const U8 = integer(8, false)
export const U16 = integer(16, false)
export const U32 = integer(32, false)
export const I8 = integer(8, true)
export const I16 = integer(16, true)
export const I32 = integer(32, true)
export const U64 = bigInteger(64, false)
export const U128 = bigInteger(128, false)
export const I64 = bigInteger(64, true)
export const I128 = bigInteger(128, true)

/** Exact IEEE-754 binary32 values; narrow explicitly with Math.fround. */
export const F32 = withLayout(Schema.Number, { version: 1, kind: "float", bits: 32 }).check(
  Schema.makeFilter((n) => !Number.isNaN(n) && Object.is(Math.fround(n), n), {
    expected: "an exactly representable binary32 number",
  }),
)
/** IEEE-754 binary64, including infinities and signed zero, excluding NaN. */
export const F64 = withLayout(Schema.Number, {
  version: 1,
  kind: "float",
  bits: 64,
}).check(Schema.makeFilter((n) => !Number.isNaN(n), { expected: "a non-NaN number" }))

/** A u32 byte length followed by the bytes, like Rust Vec<u8>. */
export const Bytes = Schema.Uint8Array
/** The empty tuple uses Rust unit's empty wire representation. */
export const Unit = Schema.Tuple([])

/** Exactly length bytes, with no length prefix, like Rust [u8; N]. */
export function fixedBytes(length: number): Schema.Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0 || length > 0xffff_ffff)
    throw new Error("$: fixedBytes length must be a safe integer between 0 and 2^32 - 1")
  return withLayout(Bytes, {
    version: 1,
    kind: "fixedBytes",
    length,
  }).check(
    Schema.makeFilter((bytes) => bytes.byteLength === length, {
      expected: `exactly ${length} bytes`,
    }),
  )
}

/** Give a native encoded array Rust [T; N]'s layout, without a count prefix. */
export function fixedArray(length: number): <S extends Schema.Top>(schema: S) => S["Rebuild"] {
  if (!Number.isSafeInteger(length) || length < 0 || length > 0xffff_ffff)
    throw new Error("$: fixedArray length must be a safe integer between 0 and 2^32 - 1")
  return (schema) => {
    rejectSuspensions(schema.ast)
    const ast = Schema.toEncoded(schema).ast
    if (ast._tag !== "Arrays" || ast.elements.length !== 0 || ast.rest.length !== 1)
      throw new Error("$: fixedArray requires a homogeneous encoded array")
    return withLayout(schema, { version: 1, kind: "fixedArray", length })
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
 * Assign explicit u8 discriminants, like Rust `#[borsh(use_discriminant = true)]`. Keys are
 * encoded tag values, literals as strings or TS enum member names; `tag` selects another tag key.
 */
export function discriminants<
  const D extends Readonly<Record<string, number>>,
  Tag extends string = "_tag",
>(
  map: D,
  options?: { readonly tag?: Tag | undefined },
): <S extends Schema.Top>(schema: S & ExactDiscriminants<S, D, Tag>) => S["Rebuild"] {
  const layout = parseDescriptor({
    version: 1,
    kind: "enum",
    tag: options?.tag ?? "_tag",
    discriminants: map,
  })
  return (schema) => {
    rejectSuspensions(schema.ast)
    enumVariants(Schema.toEncoded(schema).ast, layout, "$")
    return withLayout(schema, layout)
  }
}

export interface Options {
  /** Maximum input/output byte length per operation. Default: 16 MiB. */
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
 * Derive Borsh from the encoded side while retaining the original native parser.
 * Codecs are memoized by schema identity and maxBytes; layouts by schema identity.
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
    rejectSuspensions(schema.ast)
    entry = { layout: compile(Schema.toEncoded(schema).ast), codecs: new Map() }
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
