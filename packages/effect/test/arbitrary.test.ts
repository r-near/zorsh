import { Arbitrary, Effect, Option, Schema, type SchemaAST, SchemaTransformation } from "effect"
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
    Schema.Array(Borsh.U16).pipe(Borsh.fixedArray(3)),
    Schema.TaggedUnion({ Off: {}, On: { level: Borsh.U8 } }).pipe(
      Borsh.discriminants({ Off: 1, On: 5 }),
    ),
  ])
    expectRoundTrips(schema)
  for (const length of [0, 1, 5, 32, 64])
    for (const bytes of expectRoundTrips(Borsh.fixedBytes(length)))
      expect(bytes).toHaveLength(length)
  for (const [length, count] of [
    [1952, 10],
    [65536, 2],
  ] as const)
    for (const bytes of expectRoundTrips(Borsh.fixedBytes(length), count))
      expect(bytes).toHaveLength(length)
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

it("samples fixed arrays at their length unless transformed", () => {
  const item = Borsh.U16.check(Schema.isGreaterThan(0))
  for (const schema of [
    Schema.Array(item).pipe(Borsh.fixedArray(3)),
    Schema.Array(item).check(Schema.isMaxLength(5)).pipe(Borsh.fixedArray(3)),
    Schema.Array(item).pipe(Schema.brand("Triple"), Borsh.fixedArray(3)),
    Schema.mutable(Schema.Array(item)).pipe(Borsh.fixedArray(3)),
    Schema.Array(Schema.FiniteFromString).pipe(Borsh.fixedArray(3)),
  ])
    for (const value of expectRoundTrips(schema)) expect(value).toHaveLength(3)
  expectRoundTrips(Schema.Array(Borsh.Unit).pipe(Borsh.fixedArray(2)))
  expectRoundTrips(Schema.Array(Borsh.U8).pipe(Borsh.fixedArray(0)))
  const codec = Borsh.toCodec(Schema.Struct({ a: Schema.Array(item).pipe(Borsh.fixedArray(3)) }))
  for (const a of [
    [1, 2],
    [1, 2, 3, 4],
  ])
    expect(() => Schema.encodeSync(codec)({ a })).toThrow(
      /^Expected a value with a length of 3\n {2}at \["a"\]$/,
    )
  expect(() => Schema.decodeSync(codec)(Uint8Array.of(1, 0))).toThrow(
    /^Truncated fixed array payload at byte 0\n {2}at \["a"\]$/,
  )
  const unchecked = Schema.Array(item).pipe(
    Schema.decodeTo(
      Schema.Struct({ values: Schema.Array(item) }),
      SchemaTransformation.transform({
        decode: (values) => ({ values }),
        encode: ({ values }) => values,
      }),
    ),
    Borsh.fixedArray(3),
  )
  expect(() => Schema.encodeSync(Borsh.toCodec(unchecked))({ values: [1] })).toThrow(
    /^Expected fixed array of length 3 at byte 0$/,
  )
})

it("keeps schema annotations when fixedArray adds its length check", () => {
  const schema = Schema.Array(Borsh.U8).pipe(
    Schema.overrideToFormatter(() => () => "<redacted>"),
    Schema.overrideToEquivalence(() => (a, b) => a.length === b.length),
    Schema.annotate({
      identifier: "Triple",
      title: "Triple",
      description: "Three bytes",
      examples: [[1, 2, 3]],
      default: [0, 0, 0],
    }),
    Borsh.fixedArray(3),
  )
  expect(Schema.resolveAnnotations(schema)).toMatchObject({
    identifier: "Triple",
    title: "Triple",
    description: "Three bytes",
    examples: [[1, 2, 3]],
    default: [0, 0, 0],
    expected: "a value with a length of 3",
  })
  expect(Schema.toFormatter(schema)([1, 2, 3])).toBe("<redacted>")
  expect(Schema.toEquivalence(schema)([1, 2, 3], [4, 5, 6])).toBe(true)
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
  // An earlier check's annotations move to the length check too.
  const checked = Schema.Array(Borsh.U8)
    .check(Schema.isMinLength(1, { description: "Non-empty", format: "bytes" }))
    .pipe(Borsh.fixedArray(3))
  expect(Schema.resolveAnnotations(checked)).toMatchObject({
    description: "Non-empty",
    format: "bytes",
  })
  expect(Schema.toJsonSchemaDocument(checked).schema).toEqual({
    type: "array",
    items: { type: "integer", minimum: 0, maximum: 255 },
    minItems: 1,
    allOf: [{ minItems: 3, maxItems: 3, description: "Non-empty", format: "bytes" }],
  })
  const codec = Borsh.toCodec(schema)
  expect(() => Schema.encodeUnknownSync(codec)("x")).toThrow(/^Expected Triple$/)
  expect(() => Schema.encodeSync(codec)([1])).toThrow(/^Expected a value with a length of 3$/)
  const lengthChecks = (schema: Schema.Top) =>
    schema
      .pipe(Borsh.fixedArray(3))
      .ast.checks?.filter(
        (check) => check.annotations?.representation?.id === "effect/schema/isBetweenLength",
      ).length
  const array = Schema.Array(Borsh.U8)
  expect(lengthChecks(array)).toBe(1)
  expect(lengthChecks(array.pipe(Borsh.fixedArray(3)))).toBe(1)
  expect(lengthChecks(array.check(Schema.isBetweenLength(3, 3)))).toBe(1)
  expect(lengthChecks(array.check(Schema.makeFilterGroup([Schema.isBetweenLength(3, 3)])))).toBe(0)
  expect(
    lengthChecks(
      array.check(
        Schema.isMinLength(3),
        Schema.makeFilter(() => true),
      ),
    ),
  ).toBe(1)
  expect(lengthChecks(array.check(Schema.isBetweenLength(2, 3)))).toBe(2)
  // A generation hint alone does not enforce the length.
  const hinted = array.check(
    Schema.isMaxLength(5, { arbitraryConstraint: { minLength: 3, maxLength: 3 } }),
  )
  expect(Schema.is(hinted.pipe(Borsh.fixedArray(3)))([1])).toBe(false)
  // Spreading a list that turns out empty leaves `checks` as `[]`.
  const none = [] as unknown as [SchemaAST.Check<ReadonlyArray<number>>]
  const unchecked = Schema.Array(Borsh.U8)
    .annotate({ identifier: "Pair", description: "Two bytes" })
    .check(...none)
    .pipe(Borsh.fixedArray(2))
  expect(Schema.toJsonSchemaDocument(unchecked).definitions).toEqual({
    Pair: {
      type: "array",
      items: { type: "integer", minimum: 0, maximum: 255 },
      description: "Two bytes",
      minItems: 2,
      maxItems: 2,
    },
  })
  expect(Schema.encodeSync(Borsh.toCodec(unchecked))([1, 2])).toEqual(Uint8Array.of(1, 2))
  expect(() => Schema.encodeUnknownSync(Borsh.toCodec(unchecked))("x")).toThrow(/^Expected Pair$/)
  const custom = Schema.Array(Borsh.U8).check(Schema.isMinLength(1, { message: "need one" }))
  expect(() => Schema.encodeSync(Borsh.toCodec(custom.pipe(Borsh.fixedArray(3))))([])).toThrow(
    /^need one$/,
  )
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
    Schema.Array(Schema.Array(Borsh.U8).pipe(Borsh.fixedArray(2))),
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
  ])
    expectRoundTrips(schema)
})

it("keeps lone surrogates and zero-sized vectors unencodable", () => {
  const strings = Borsh.toCodec(Schema.String)
  expect(Schema.is(Schema.String)("\uD800")).toBe(true)
  expect(() => Schema.encodeSync(strings)("\uD800")).toThrow(/^Lone UTF-16 surrogate at byte 0$/)
  const raw = sample(Schema.String, 200)
  expect(raw.some((s) => !s.isWellFormed())).toBe(true)
  for (const s of raw)
    if (s.isWellFormed()) expect(Schema.decodeSync(strings)(Schema.encodeSync(strings)(s))).toBe(s)
    else expect(() => Schema.encodeSync(strings)(s)).toThrow(/Lone UTF-16 surrogate/)
  expect(() => Schema.encodeSync(Borsh.toCodec(WellFormed))("\uD800")).toThrow(
    /^Expected well-formed Unicode$/,
  )
  const units = Borsh.toCodec(Schema.Array(Borsh.Unit))
  for (const value of sample(Schema.Array(Borsh.Unit)))
    expect(() => Schema.encodeSync(units)(value)).toThrow(
      /^Borsh forbids vectors of zero-sized values at byte 0$/,
    )
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
  const Range = Schema.Array(Borsh.U32).pipe(
    Borsh.fixedArray(2),
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
