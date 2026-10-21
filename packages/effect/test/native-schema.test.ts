import {
  Brand,
  Context,
  Effect,
  Exit,
  Result,
  Schema,
  SchemaAST,
  SchemaIssue,
  SchemaTransformation,
} from "effect"
import { describe, expect, expectTypeOf, it } from "vite-plus/test"
import { Borsh } from "../src/index.js"

describe("native Effect schema composition", () => {
  it("retains refinements, brands, documentation and native rebuild methods", () => {
    const Positive = Borsh.U16.check(Schema.isGreaterThan(0)).pipe(Schema.brand("Positive"))
    const Documented = Positive.annotate({ title: "Positive amount" }).check(Schema.isLessThan(100))
    const codec = Borsh.toCodec(Documented)
    expectTypeOf(codec).toEqualTypeOf<Schema.Codec<typeof Documented.Type, Uint8Array>>()
    expectTypeOf(Documented.make(1)).toEqualTypeOf<number & Brand.Brand<"Positive">>()
    expect(Schema.is(Documented)(0)).toBe(false)
    expect(Schema.is(Documented)(100)).toBe(false)
    expect(Schema.encodeSync(codec)(Documented.make(99))).toEqual(Uint8Array.of(99, 0))
    expect(Schema.decodeSync(codec)(Uint8Array.of(99, 0))).toBe(99)
    expect(() => Schema.decodeSync(codec)(Uint8Array.of(0, 0))).toThrow(Schema.SchemaError)
    expect(() => Schema.encodeUnknownSync(codec)(100)).toThrow(Schema.SchemaError)
  })

  it("keeps nested native refinement groups and their encoded metadata", () => {
    const key = "@zorsh/effect/borsh/layout"
    const check = Schema.isGreaterThan(0)
      .annotate({ [key]: { version: 1, kind: "integer", bits: 16, signed: false } })
      .and(Schema.isLessThan(10))
      .and(Schema.makeFilter((n: number) => n % 2 === 0))
    const codec = Borsh.toCodec(Borsh.U16.check(check).annotate({ title: "Small even amount" }))
    expect(Schema.decodeSync(codec)(Uint8Array.of(8, 0))).toBe(8)
    expect(Schema.encodeSync(codec)(8)).toEqual(Uint8Array.of(8, 0))
    for (const invalid of [0, 3, 10]) {
      expect(() => Schema.encodeSync(codec)(invalid)).toThrow(Schema.SchemaError)
      expect(() => Schema.decodeSync(codec)(Uint8Array.of(invalid, 0))).toThrow(Schema.SchemaError)
    }
    const conflicting = Schema.isGreaterThan(0)
      .annotate({ [key]: { version: 1, kind: "integer", bits: 32, signed: false } })
      .and(Schema.isLessThan(10))
      .and(Schema.isInt())
    expect(() => Borsh.toCodec(Borsh.U16.check(conflicting))).toThrow(/Conflicting Borsh/)
  })

  it("supports a finite template-literal application type on an integer wire schema", () => {
    const schema = Borsh.U16.pipe(
      Schema.decodeTo(
        Schema.TemplateLiteral(["item-", Schema.Int]),
        SchemaTransformation.transform({
          decode: (n): `item-${number}` => `item-${n}`,
          encode: (text) => Number(text.slice(5)),
        }),
      ),
    )
    const codec = Borsh.toCodec(schema)
    expectTypeOf(codec.Type).toEqualTypeOf<`item-${number}`>()
    expect(Schema.decodeSync(codec)(Uint8Array.of(7, 0))).toBe("item-7")
    expect(Schema.encodeSync(codec)("item-7")).toEqual(Uint8Array.of(7, 0))
    expect(() => Schema.encodeUnknownSync(codec)("other-7")).toThrow(Schema.SchemaError)
  })

  it("allows optional fields on the application side of a finite primitive transformation", () => {
    const schema = Borsh.U8.pipe(
      Schema.decodeTo(
        Schema.Struct({ count: Schema.optionalKey(Borsh.U8) }),
        SchemaTransformation.transform({
          decode: (count) => (count === 0 ? {} : { count }),
          encode: (value) => value.count ?? 0,
        }),
      ),
    )
    const codec = Borsh.toCodec(schema)
    expect(Schema.decodeSync(codec)(Uint8Array.of(0))).toEqual({})
    expect(Schema.decodeSync(codec)(Uint8Array.of(7))).toEqual({ count: 7 })
    expect(Schema.encodeSync(codec)({})).toEqual(Uint8Array.of(0))
    expect(Schema.encodeSync(codec)({ count: 7 })).toEqual(Uint8Array.of(7))
  })

  it("derives bytes from Encoded while preserving both-direction changes to the Type shape", () => {
    const Amount = Borsh.U64.pipe(
      Schema.decodeTo(
        Schema.Struct({ amount: Schema.String }),
        SchemaTransformation.transform({
          decode: (n) => ({ amount: n.toString() }),
          encode: (value) => BigInt(value.amount),
        }),
      ),
    )
    const codec = Borsh.toCodec(Amount)
    expectTypeOf(codec.Type).toEqualTypeOf<{ readonly amount: string }>()
    expectTypeOf(codec.Encoded).toEqualTypeOf<Uint8Array>()
    expect(Schema.encodeSync(codec)({ amount: "4294967296" })).toEqual(
      Uint8Array.of(0, 0, 0, 0, 1, 0, 0, 0),
    )
    expect(Schema.decodeSync(codec)(Uint8Array.of(7, 0, 0, 0, 0, 0, 0, 0))).toEqual({ amount: "7" })
    expect(() => Schema.encodeSync(codec)({ amount: "18446744073709551616" })).toThrow(
      Schema.SchemaError,
    )
  })

  it("keeps finite class/declaration Type schemas when their encoded representation is supported", () => {
    class Amount {
      constructor(readonly units: bigint) {}
    }
    const schema = Borsh.U128.pipe(
      Schema.decodeTo(
        Schema.instanceOf(Amount),
        SchemaTransformation.transform({
          decode: (n) => new Amount(n),
          encode: (amount) => amount.units,
        }),
      ),
    )
    const codec = Borsh.toCodec(schema)
    expectTypeOf(codec.Type).toEqualTypeOf<Amount>()
    expect(Schema.decodeSync(codec)(Uint8Array.of(1, ...new Uint8Array(15)))).toEqual(
      new Amount(1n),
    )
    expect(Schema.encodeSync(codec)(new Amount(1n))).toEqual(
      Uint8Array.of(1, ...new Uint8Array(15)),
    )
  })

  it("preserves distinct decoding and encoding service requirements", () => {
    class Decode extends Context.Service<Decode, { readonly prefix: string }>()("test/Decode") {}
    class Encode extends Context.Service<Encode, { readonly prefix: string }>()("test/Encode") {}
    const schema = Borsh.U8.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transformEffect({
          decode: (n) =>
            Effect.gen(function* () {
              const service = yield* Decode
              return `${service.prefix}${n}`
            }),
          encode: (text) =>
            Effect.gen(function* () {
              const service = yield* Encode
              return text.startsWith(service.prefix)
                ? Number(text.slice(service.prefix.length))
                : yield* Effect.fail(
                    new SchemaIssue.InvalidValue({ message: "Missing service prefix" }),
                  )
            }),
        }),
      ),
    )
    const codec = Borsh.toCodec(schema)
    expectTypeOf(codec).toEqualTypeOf<Schema.Codec<string, Uint8Array, Decode, Encode>>()
    expectTypeOf(Schema.decodeEffect(codec)(Uint8Array.of(7))).toEqualTypeOf<
      Effect.Effect<string, Schema.SchemaError, Decode>
    >()
    expectTypeOf(Schema.encodeEffect(codec)("v7")).toEqualTypeOf<
      Effect.Effect<Uint8Array, Schema.SchemaError, Encode>
    >()
    expect(
      Effect.runSync(
        Schema.decodeEffect(codec)(Uint8Array.of(7)).pipe(
          Effect.provideService(Decode, { prefix: "v" }),
        ),
      ),
    ).toBe("v7")
    expect(
      Effect.runSync(
        Schema.encodeEffect(codec)("v7").pipe(Effect.provideService(Encode, { prefix: "v" })),
      ),
    ).toEqual(Uint8Array.of(7))
    const nested = Borsh.toCodec(Schema.Struct({ values: Schema.Array(schema) }))
    expectTypeOf(nested).toEqualTypeOf<
      Schema.Codec<{ readonly values: readonly string[] }, Uint8Array, Decode, Encode>
    >()
    expect(
      Effect.runSync(
        Schema.encodeEffect(nested)({ values: ["v7"] }).pipe(
          Effect.provideService(Encode, { prefix: "v" }),
        ),
      ),
    ).toEqual(Uint8Array.of(1, 0, 0, 0, 7))
    expect(
      Effect.runSync(
        Schema.decodeEffect(nested)(Uint8Array.of(1, 0, 0, 0, 7)).pipe(
          Effect.provideService(Decode, { prefix: "v" }),
        ),
      ),
    ).toEqual({ values: ["v7"] })
    const failed = Effect.runSyncExit(
      Schema.encodeEffect(codec)("bad").pipe(Effect.provideService(Encode, { prefix: "v" })),
    )
    expect(Exit.hasDies(failed)).toBe(false)
    const error = Exit.findError(failed)
    expect(Result.isFailure(error)).toBe(false)
    expect(() => Schema.decodeSync(Borsh.toCodec(Borsh.U8))(Uint8Array.of(1, 2))).toThrow(
      Schema.SchemaError,
    )
  })

  it("uses the native SchemaError failure channel for binary failures", () => {
    const result = Effect.runSyncExit(
      Schema.decodeEffect(Borsh.toCodec(Borsh.U32))(Uint8Array.of(1)),
    )
    expect(Exit.hasDies(result)).toBe(false)
    const error = Exit.findError(result)
    if (Result.isSuccess(error)) {
      expect(error.success).toBeInstanceOf(Schema.SchemaError)
      expect(error.success.message).toMatch(/\$ at byte 0.*Truncated/)
      expect(error.success.issue).toBeDefined()
    } else throw new Error("Expected native schema failure")
  })

  it("preserves native defects from user refinements, transformations and getters", () => {
    const defect = new Error("application defect")
    const refinement = Borsh.U8.check(
      Schema.makeFilter(() => {
        throw defect
      }),
    )
    const transformed = Borsh.U8.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transform<string, number>({
          decode: () => {
            throw defect
          },
          encode: () => {
            throw defect
          },
        }),
      ),
    )
    const object = Borsh.U8.pipe(
      Schema.decodeTo(
        Schema.Struct({ value: Borsh.U8 }),
        SchemaTransformation.transform({
          decode: (value) => ({ value }),
          encode: (value) => value.value,
        }),
      ),
    )
    const results: ReadonlyArray<Exit.Exit<unknown, Schema.SchemaError>> = [
      Effect.runSyncExit(
        Effect.suspend(() => Schema.decodeEffect(Borsh.toCodec(refinement))(Uint8Array.of(1))),
      ),
      Effect.runSyncExit(
        Effect.suspend(() => Schema.decodeEffect(Borsh.toCodec(transformed))(Uint8Array.of(1))),
      ),
      Effect.runSyncExit(
        Effect.suspend(() => Schema.encodeEffect(Borsh.toCodec(transformed))("1")),
      ),
      Effect.runSyncExit(
        Effect.suspend(() =>
          Schema.encodeEffect(Borsh.toCodec(object))({
            get value(): number {
              throw defect
            },
          }),
        ),
      ),
    ]
    for (const result of results) expect(Exit.findDefect(result)).toEqual(Result.succeed(defect))
    const bytes = Uint8Array.of(1)
    Object.defineProperty(bytes, "byteLength", {
      get() {
        throw defect
      },
    })
    const binaryDefect = Effect.runSyncExit(
      Effect.suspend(() => Schema.encodeEffect(Borsh.toCodec(Borsh.Bytes))(bytes)),
    )
    expect(Exit.findDefect(binaryDefect)).toEqual(Result.succeed(defect))
  })

  it("executes the original encoder before binary limits; limits do not bound user work", () => {
    let encodes = 0
    const schema = Borsh.U64.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transform({
          decode: String,
          encode: (value) => {
            encodes++
            return BigInt(value)
          },
        }),
      ),
    )
    expect(() => Schema.encodeSync(Borsh.toCodec(schema, { maxBytes: 1 }))("1")).toThrow(/maxBytes/)
    expect(encodes).toBe(1)
  })

  it("enforces wire constraints on middleware output when native checks are disabled", () => {
    function replaceEncoded<S extends Schema.Constraint>(schema: S, value: S["Encoded"]) {
      return Schema.middlewareEncoding<S, never>(() => Effect.succeedSome(value))(schema)
    }
    const cases = [
      { schema: replaceEncoded(Borsh.U8, 256), value: 256, error: /outside u8 range/ },
      { schema: replaceEncoded(Borsh.I8, -129), value: -129, error: /outside i8 range/ },
      {
        schema: replaceEncoded(Borsh.U64, 1n << 64n),
        value: 1n << 64n,
        error: /outside u64 range/,
      },
      { schema: replaceEncoded(Borsh.F32, 0.1), value: 0.1, error: /exact non-NaN f32/ },
      { schema: replaceEncoded(Borsh.F64, NaN), value: NaN, error: /exact non-NaN f64/ },
      {
        schema: replaceEncoded(Schema.String, "\uD800"),
        value: "\uD800",
        error: /Lone UTF-16 surrogate/,
      },
    ]
    for (const { schema, value, error } of cases) {
      expect(Schema.encodeUnknownSync(schema, { disableChecks: true })(0)).toEqual(value)
      expect(() =>
        Schema.encodeUnknownSync(Borsh.toCodec(schema), { disableChecks: true })(0),
      ).toThrow(error)
    }
  })
})

describe("unsupported encoded layouts and metadata", () => {
  it("does not infer widths from numeric validation bounds", () => {
    for (const schema of [
      Schema.Number,
      Schema.Int,
      Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 255 })),
      Schema.BigInt,
    ]) {
      expect(() => Borsh.toCodec(schema)).toThrow(/\$: .*explicit Borsh width/)
    }
  })

  it("rejects ambiguous and future container layouts at construction", () => {
    for (const schema of [
      Schema.Union([Borsh.U8, Borsh.U16]),
      Schema.Option(Borsh.U8),
      Schema.Literal(1),
      Schema.Unknown,
      Schema.Null,
      Schema.Undefined,
    ])
      expect(() => Borsh.toCodec(schema)).toThrow(/\$: Unsupported encoded/)
    for (const schema of [Schema.optionalKey(Borsh.U8), Schema.optional(Borsh.U8)]) {
      expect(() => Borsh.toCodec(schema)).toThrow(/\$: Optional schemas need an explicit Borsh/)
    }
  })

  it("rejects Suspend without evaluating the thunk, including a hidden recursive Type", () => {
    let calls = 0
    const suspended = Schema.suspend(() => {
      calls++
      return Borsh.U8
    })
    expect(() => Borsh.toCodec(suspended)).toThrow(/\$: Suspend/)
    const struct = Schema.Struct({ hidden: suspended })
    const typeSide = Borsh.U8.pipe(
      Schema.decodeTo(
        struct,
        SchemaTransformation.transform({
          decode: (hidden) => ({ hidden }),
          encode: (value) => value.hidden,
        }),
      ),
    )
    expect(() => Borsh.toCodec(typeSide)).toThrow(/\$\.hidden: Suspend/)
    const declaration = Schema.declareConstructor<number>()(
      [suspended],
      () => () => Effect.succeed(1),
    )
    const declarationType = Borsh.U8.pipe(Schema.decodeTo(declaration))
    expect(() => Borsh.toCodec(declarationType)).toThrow(/\$\.typeParameters\[0\]: Suspend/)
    const encodedSide = suspended.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transform({ decode: String, encode: Number }),
      ),
    )
    expect(() => Borsh.toCodec(encodedSide)).toThrow(/encoding\[0\].*Suspend/)
    expect(calls).toBe(0)
  })

  it("finds suspended nodes nested in tuple, vector, union and record schemas without forcing them", () => {
    let calls = 0
    const suspended = Schema.suspend(() => {
      calls++
      return Schema.String
    })
    const cases = [
      { schema: Schema.Tuple([suspended]), path: "$[0]" },
      { schema: Schema.Array(suspended), path: "$.rest[0]" },
      { schema: Schema.Union([Schema.String, suspended]), path: "$.union[1]" },
      { schema: Schema.Record(Schema.String, suspended), path: "$.values[0]" },
    ]
    for (const { schema, path } of cases) {
      expect(() => Borsh.toCodec(schema)).toThrow(
        `${path}: Suspend/recursive schemas are unsupported`,
      )
    }
    expect(calls).toBe(0)
  })

  it("validates malformed, mismatched and conflicting private metadata", () => {
    const key = "@zorsh/effect/borsh/layout"
    const untypedKey: string = key
    // Native AST construction models untyped external metadata without pretending it is valid TS.
    const bad = Schema.make(
      new SchemaAST.Number({
        [untypedKey]: { version: 2, kind: "integer", bits: 8, signed: false },
      }),
    )
    expect(() => Borsh.toCodec(bad)).toThrow(/Invalid Borsh layout/)
    const wrongWidth = Schema.make(
      new SchemaAST.Number({
        [untypedKey]: { version: 1, kind: "integer", bits: 24, signed: false },
      }),
    )
    expect(() => Borsh.toCodec(wrongWidth)).toThrow(/Invalid Borsh layout/)
    for (const invalid of [
      null,
      "u8",
      { version: 1, kind: "unknown" },
      { version: 1, kind: "float", bits: 16 },
      { version: 1, kind: "fixedBytes", length: -1 },
    ]) {
      expect(() =>
        Borsh.toCodec(Schema.make(new SchemaAST.Number({ [untypedKey]: invalid }))),
      ).toThrow(/Invalid Borsh layout/)
    }
    const mismatched = Schema.String.pipe(
      Schema.annotateEncoded({ [key]: { version: 1, kind: "float", bits: 32 } }),
    )
    expect(() => Borsh.toCodec(mismatched)).toThrow(/does not match encoded/)
    const integerOnString = Schema.String.pipe(
      Schema.annotateEncoded({
        [key]: { version: 1, kind: "integer", bits: 8, signed: false },
      }),
    )
    const bigintWidthOnNumber = Schema.Int.pipe(
      Schema.annotateEncoded({
        [key]: { version: 1, kind: "integer", bits: 64, signed: false },
      }),
    )
    const numberWidthOnBigint = Schema.BigInt.pipe(
      Schema.annotateEncoded({
        [key]: { version: 1, kind: "integer", bits: 32, signed: true },
      }),
    )
    for (const schema of [integerOnString, bigintWidthOnNumber, numberWidthOnBigint]) {
      expect(() => Borsh.toCodec(schema)).toThrow(/Integer layout does not match encoded/)
    }
    const fixedOnString = Schema.String.pipe(
      Schema.annotateEncoded({
        [key]: { version: 1, kind: "fixedBytes", length: 2 },
      }),
    )
    expect(() => Borsh.toCodec(fixedOnString)).toThrow(/Borsh layout does not match encoded String/)
    const conflict = Borsh.U8.check(Schema.isGreaterThan(0)).pipe(
      Schema.annotateEncoded({ [key]: { version: 1, kind: "integer", bits: 16, signed: false } }),
    )
    expect(() => Borsh.toCodec(conflict)).toThrow(/Conflicting Borsh/)
    const same = Borsh.U8.check(Schema.isGreaterThan(0)).pipe(
      Schema.annotateEncoded({ [key]: { version: 1, kind: "integer", bits: 8, signed: false } }),
    )
    expect(Schema.encodeSync(Borsh.toCodec(same))(1)).toEqual(Uint8Array.of(1))
    const metadata = Borsh.U128.ast.annotations?.[key]
    expect(Object.isFrozen(metadata)).toBe(true)
  })
})
