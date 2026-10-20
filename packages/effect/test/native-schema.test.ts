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
      Schema.Struct({ value: Borsh.U8 }),
      Schema.Array(Borsh.U8),
      Schema.Tuple([Borsh.U8]),
      Schema.Union([Borsh.U8, Borsh.U16]),
      Schema.Option(Borsh.U8),
      Schema.Literal(1),
      Schema.Unknown,
      Schema.Null,
      Schema.Undefined,
      Schema.Record(Schema.String, Borsh.U8),
    ])
      expect(() => Borsh.toCodec(schema)).toThrow(/\$: Unsupported encoded/)
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
