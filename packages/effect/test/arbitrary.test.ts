import { Arbitrary, Effect, Option, Schema, SchemaTransformation } from "effect"
import { expect, it } from "vite-plus/test"
import { Borsh } from "../src/index.js"

declare global {
  // ES2024, available on every runtime the package supports.
  interface String {
    isWellFormed(): boolean
  }
}

const seed = 42

function sample<S extends Schema.Codec<unknown, unknown>>(schema: S, count = 50) {
  return Effect.runSync(Arbitrary.sampleEffect(Arbitrary.schema(schema), { count, seed }))
}

/** Every sample encodes, decodes to a valid value and re-encodes to the same bytes. */
function expectRoundTrips<S extends Schema.Codec<unknown, unknown>>(schema: S, count?: number) {
  const codec = Borsh.toCodec(schema)
  const encode = Schema.encodeUnknownSync(codec)
  const decode = Schema.decodeSync(codec)
  const values = sample(schema, count)
  expect(values).toHaveLength(count ?? 50)
  for (const value of values) {
    const bytes = encode(value)
    const decoded = decode(bytes)
    expect(Schema.is(schema)(decoded)).toBe(true)
    expect(encode(decoded)).toEqual(bytes)
  }
  return values
}

const WellFormed = Schema.String.check(
  Schema.makeFilter((s) => s.isWellFormed(), { expected: "well-formed Unicode" }),
)

it("samples every Borsh constructor as encodable values", () => {
  for (const schema of [
    Borsh.U8,
    Borsh.U16,
    Borsh.U32,
    Borsh.I8,
    Borsh.I16,
    Borsh.I32,
    Borsh.U64,
    Borsh.U128,
    Borsh.I64,
    Borsh.I128,
    Borsh.F32,
    Borsh.F64,
    Borsh.Bytes,
    Borsh.Unit,
    Borsh.fixedArray(Borsh.U16, 3),
    Schema.TaggedUnion({ Off: {}, On: { level: Borsh.U8 } }).pipe(
      Borsh.discriminants({ Off: 1, On: 5 }),
    ),
  ]) {
    expectRoundTrips(schema)
  }
  for (const length of [0, 1, 5, 32, 64]) {
    for (const bytes of expectRoundTrips(Borsh.fixedBytes(length))) {
      expect(bytes).toHaveLength(length)
    }
  }
  for (const [length, count] of [
    [1952, 10],
    [65536, 2],
  ] as const) {
    for (const bytes of expectRoundTrips(Borsh.fixedBytes(length), count)) {
      expect(bytes).toHaveLength(length)
    }
  }
})

it("samples F32 as exact binary32 integers", () => {
  const values = expectRoundTrips(Borsh.F32, 200)
  for (const value of values) {
    expect(Object.is(Math.fround(value), value)).toBe(true)
    expect(Number.isInteger(value) && Math.abs(value) <= 2 ** 24).toBe(true)
  }
  expect(new Set(values).size).toBeGreaterThan(100)
  expect(() =>
    Arbitrary.schema(Borsh.F32.check(Schema.isBetween({ minimum: 0.25, maximum: 0.75 }))),
  ).toThrow()
})

it("samples fixed arrays at their length", () => {
  const item = Borsh.U16.check(Schema.isGreaterThan(0))
  for (const schema of [
    Borsh.fixedArray(item, 3),
    Borsh.fixedArray(item, 3).check(Schema.isMaxLength(5)),
    Borsh.fixedArray(item, 3).pipe(Schema.brand("Triple")),
    Schema.mutable(Borsh.fixedArray(item, 3)),
    Borsh.fixedArray(Schema.FiniteFromString, 3),
  ]) {
    for (const value of expectRoundTrips(schema)) {
      expect(value).toHaveLength(3)
    }
  }
  for (const value of expectRoundTrips(Borsh.fixedArray(Borsh.U8, 4096), 3)) {
    expect(value).toHaveLength(4096)
  }
  expectRoundTrips(Borsh.fixedArray(Borsh.Unit, 2))
  expectRoundTrips(Borsh.fixedArray(Borsh.U8, 0))
  const codec = Borsh.toCodec(Schema.Struct({ a: Borsh.fixedArray(item, 3) }))
  for (const a of [
    [1, 2],
    [1, 2, 3, 4],
  ]) {
    expect(() => Schema.encodeSync(codec)({ a })).toThrow(
      /^Expected a value with a length of 3\n {2}at \["a"\]$/,
    )
  }
  expect(() => Schema.decodeSync(codec)(Uint8Array.of(1, 0))).toThrow(
    /^Truncated fixed array payload at byte 0\n {2}at \["a"\]$/,
  )
  const transformed = Borsh.fixedArray(item, 3).pipe(
    Schema.decodeTo(
      Schema.Struct({ values: Schema.Array(item) }),
      SchemaTransformation.transform({
        decode: (values) => ({ values }),
        encode: ({ values }) => values,
      }),
    ),
  )
  expect(() => Schema.encodeSync(Borsh.toCodec(transformed))({ values: [1] })).toThrow(
    /^Expected a value with a length of 3$/,
  )
  // A transformation to a fixed shape keeps samples at the encoded length.
  const Range = Borsh.fixedArray(Borsh.U32, 2).pipe(
    Schema.decodeTo(
      Schema.Struct({ start: Borsh.U32, end: Borsh.U32 }),
      SchemaTransformation.transform({
        decode: ([start = 0, end = 0]) => ({ start, end }),
        encode: ({ start, end }) => [start, end],
      }),
    ),
  )
  const range = Borsh.toCodec(Range)
  expect(Schema.encodeSync(range)({ start: 1, end: 2 })).toEqual(
    Uint8Array.of(1, 0, 0, 0, 2, 0, 0, 0),
  )
  expectRoundTrips(Range)
  expect(() => Schema.decodeSync(range)(Uint8Array.of(1, 0, 0, 0))).toThrow(Schema.SchemaError)
})

it("keeps annotations, brands and checks added after fixedArray", () => {
  const schema = Borsh.fixedArray(Borsh.U8, 3).pipe(
    Schema.overrideToFormatter(() => () => "<redacted>"),
    Schema.overrideToEquivalence(() => (a, b) => a.length === b.length),
    Schema.annotate({
      identifier: "Triple",
      title: "Triple",
      description: "Three bytes",
      examples: [[1, 2, 3]],
      default: [0, 0, 0],
    }),
  )
  expect(Schema.resolveAnnotations(schema)).toMatchObject({
    identifier: "Triple",
    title: "Triple",
    description: "Three bytes",
    examples: [[1, 2, 3]],
    default: [0, 0, 0],
  })
  expect(Schema.toFormatter(schema)([1, 2, 3])).toBe("<redacted>")
  expect(Schema.toEquivalence(schema)([1, 2, 3], [4, 5, 6])).toBe(true)
  expect(Schema.is(schema)([1, 2])).toBe(false)
  expect(Schema.is(schema)([1, 2, 3])).toBe(true)
  expect(Schema.toJsonSchemaDocument(Schema.Struct({ a: schema })).definitions).toEqual({
    Triple: {
      type: "array",
      items: { type: "integer", minimum: 0, maximum: 255 },
      title: "Triple",
      description: "Three bytes",
      examples: [[1, 2, 3]],
      default: [0, 0, 0],
      minItems: 3,
      maxItems: 3,
    },
  })
  const codec = Borsh.toCodec(schema)
  expect(Schema.encodeSync(codec)([7, 8, 9])).toEqual(Uint8Array.of(7, 8, 9))
  // As on any checked Effect schema, later annotations attach to the length check, not the array.
  expect(() => Schema.encodeUnknownSync(codec)("x")).toThrow(/^Expected array$/)
  expect(() => Schema.encodeSync(codec)([1])).toThrow(/^Expected a value with a length of 3$/)
  const Pair = Borsh.fixedArray(Borsh.U8, 2).pipe(Schema.brand("Pair"))
  expect(Schema.encodeSync(Borsh.toCodec(Pair))(Pair.make([1, 2]))).toEqual(Uint8Array.of(1, 2))
  expect(() => Pair.make([1])).toThrow(/Schema validation failed/)
  const custom = Borsh.fixedArray(Borsh.U8, 3).check(
    Schema.makeFilter((values) => values[0] === 1, { message: "need a leading one" }),
  )
  expect(() => Schema.encodeSync(Borsh.toCodec(custom))([2, 2, 2])).toThrow(/^need a leading one$/)
})

it("samples native composites as encodable values", () => {
  for (const schema of [
    Schema.Boolean,
    Schema.Literal("sign").pipe(Schema.encodeTo(Schema.String)),
    Schema.String.check(Schema.isPattern(/^[a-z0-9]+\.near$/)),
    Schema.Literals(["Pending", "Done"]),
    Schema.Struct({ receiver: WellFormed, amount: Borsh.U128, memo: Schema.Option(WellFormed) }),
    Schema.Tuple([Borsh.U8, Schema.Boolean, Borsh.I64]),
    Schema.Array(Borsh.U32),
    Schema.Array(Borsh.fixedArray(Borsh.U8, 2)),
    Schema.Option(Schema.Option(Borsh.U8)),
    Schema.Result(Borsh.U8, WellFormed),
    Schema.ReadonlyMap(WellFormed, Borsh.U8),
    Schema.ReadonlyMap(Borsh.I32, Borsh.Unit),
    Schema.ReadonlySet(Borsh.U64),
    Schema.HashMap(Borsh.U16, Schema.Boolean),
    Schema.HashSet(Borsh.U32),
    Schema.TaggedUnion({
      Empty: {},
      Square: { value: Borsh.U32 },
      Rect: { width: Borsh.U16, height: Borsh.F32 },
    }),
  ]) {
    expectRoundTrips(schema)
  }
})

it("keeps lone surrogates and zero-sized vectors unencodable", () => {
  const strings = Borsh.toCodec(Schema.String)
  expect(Schema.is(Schema.String)("\uD800")).toBe(true)
  expect(() => Schema.encodeSync(strings)("\uD800")).toThrow(/^Lone UTF-16 surrogate at byte 0$/)
  const raw = sample(Schema.String, 200)
  expect(raw.some((s) => !s.isWellFormed())).toBe(true)
  for (const s of raw) {
    if (s.isWellFormed()) {
      expect(Schema.decodeSync(strings)(Schema.encodeSync(strings)(s))).toBe(s)
    } else {
      expect(() => Schema.encodeSync(strings)(s)).toThrow(/Lone UTF-16 surrogate/)
    }
  }
  expect(() => Schema.encodeSync(Borsh.toCodec(WellFormed))("\uD800")).toThrow(
    /^Expected well-formed Unicode$/,
  )
  const units = Borsh.toCodec(Schema.Array(Borsh.Unit))
  for (const value of sample(Schema.Array(Borsh.Unit))) {
    expect(() => Schema.encodeSync(units)(value)).toThrow(
      /^Borsh forbids vectors of zero-sized values at byte 0$/,
    )
  }
  const none = Schema.Option(Schema.Array(Borsh.Unit))
  expect(Schema.encodeSync(Borsh.toCodec(none))(Option.none())).toEqual(Uint8Array.of(0))
})

it("runs the package README fixture examples", () => {
  const Request = Schema.Struct({
    receiver: Schema.String.check(Schema.isPattern(/^[a-z0-9]+\.near$/)),
    method: Schema.Literal("sign").pipe(Schema.encodeTo(Schema.String)),
    memo: Schema.String.check(
      Schema.makeFilter((s) => s.isWellFormed(), { expected: "well-formed Unicode" }),
    ),
    amount: Borsh.U128,
  })
  const requestCodec = Borsh.toCodec(Request)
  const fixtures = Effect.runSync(
    Arbitrary.sampleEffect(Arbitrary.schema(Request), { count: 100, seed: 42 }),
  ).map((request) => Schema.encodeSync(requestCodec)(request))
  expect(fixtures).toHaveLength(100)
  expect(() => Borsh.toCodec(Schema.Literal("sign"))).toThrow(/Unsupported encoded schema Literal/)
})
