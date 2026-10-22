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
      expect(error.success.message).toMatch(/^Truncated input: need 4 bytes at byte 0$/)
      expect(error.success.issue).toBeDefined()
    } else {
      throw new Error("Expected native schema failure")
    }
  })

  it("renders binary failures as native pointer issues, like schema validation", () => {
    const Owner = Schema.Struct({ owner: Schema.String, items: Schema.Array(Borsh.U8) })
    const codec = Borsh.toCodec(Owner)
    const failure = (run: () => unknown) => {
      try {
        run()
      } catch (error) {
        if (Schema.isSchemaError(error)) {
          return error
        }
      }
      throw new Error("Expected SchemaError")
    }
    const validation = failure(() => Schema.decodeUnknownSync(Owner)({ owner: 1, items: [] }))
    expect(validation.message).toBe('Expected string\n  at ["owner"]')
    const binary = failure(() => Schema.decodeSync(codec)(Uint8Array.of(0, 0, 0, 0, 2, 0, 0, 0, 1)))
    expect(binary.message).toBe('Truncated vector payload at byte 8\n  at ["items"]')
    const leaf = (issue: SchemaIssue.Issue): SchemaIssue.Issue =>
      issue._tag === "Encoding" ? leaf(issue.issue) : issue
    const pointer = leaf(binary.issue)
    if (!(pointer instanceof SchemaIssue.Pointer)) {
      throw new Error("Expected Pointer")
    }
    expect(pointer.path).toEqual(["items"])
    expect(pointer.issue).toBeInstanceOf(SchemaIssue.InvalidValue)
    const nested = failure(() => Schema.encodeSync(codec)({ owner: "\ud800", items: [] }))
    expect(nested.message).toBe('Lone UTF-16 surrogate at byte 0\n  at ["owner"]')
    const root = failure(() => Schema.decodeSync(codec)(new Uint8Array(9)))
    expect(root.message).toBe("Trailing bytes at byte 8")
    expect(leaf(root.issue)).toBeInstanceOf(SchemaIssue.InvalidValue)
  })

  it("memoizes codecs by schema identity and maxBytes", () => {
    const schema = Schema.Struct({ value: Borsh.U8 })
    const codec = Borsh.toCodec(schema)
    expect(Borsh.toCodec(schema)).toBe(codec)
    expect(Borsh.toCodec(schema, {})).toBe(codec)
    expect(Borsh.toCodec(schema, { maxBytes: 16 * 1024 * 1024 })).toBe(codec)
    const bounded = Borsh.toCodec(schema, { maxBytes: 1 })
    expect(bounded).not.toBe(codec)
    expect(Borsh.toCodec(schema, { maxBytes: 1 })).toBe(bounded)
    expect(Borsh.toCodec(Schema.Struct({ value: Borsh.U8 }))).not.toBe(codec)
    expect(() => Borsh.toCodec(schema, { maxBytes: 0 })).toThrow(/maxBytes must be/)
    expect(() => Schema.decodeSync(bounded)(Uint8Array.of(7, 0))).toThrow(/maxBytes \(1\)/)
    expect(Schema.decodeSync(codec)(Uint8Array.of(7))).toEqual({ value: 7 })
    expect(Borsh.toCodec(schema.annotate({}))).not.toBe(codec)
    for (let maxBytes = 2; maxBytes < 10; maxBytes++) {
      Borsh.toCodec(schema, { maxBytes })
    }
    expect(Borsh.toCodec(schema, { maxBytes: 9 })).toBe(Borsh.toCodec(schema, { maxBytes: 9 }))
    expect(Borsh.toCodec(schema)).not.toBe(codec)
  })

  it("treats empty and detached inputs as truncated or complete, not as defects", () => {
    const detached = () => {
      const bytes = new Uint8Array(1)
      structuredClone(bytes.buffer, { transfer: [bytes.buffer] })
      return bytes
    }
    const failed = Effect.runSyncExit(Schema.decodeEffect(Borsh.toCodec(Borsh.U8))(detached()))
    expect(Exit.hasDies(failed)).toBe(false)
    expect(String(failed)).toMatch(/Truncated input: need 1 bytes at byte 0/)
    expect(Schema.decodeSync(Borsh.toCodec(Borsh.Unit))(detached())).toEqual([])
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
    for (const result of results) {
      expect(Exit.findDefect(result)).toEqual(Result.succeed(defect))
    }
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

it("rejects structurally invalid container middleware output with checks disabled", () => {
  const sparse: number[] = []
  sparse.length = 1
  for (const [schema, output] of [
    [Schema.Tuple([Borsh.U8]), [1, 2]],
    [Schema.Struct({ value: Borsh.U8 }), {}],
    [Schema.Array(Borsh.U8), sparse],
  ] as const) {
    const changed = Schema.middlewareEncoding<Schema.Constraint, never>(() =>
      Effect.succeedSome(output),
    )(schema)
    expect(() =>
      Schema.encodeUnknownSync(Borsh.toCodec(changed), { disableChecks: true })(0),
    ).toThrow(Schema.SchemaError)
  }
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
    expect(() => Borsh.toCodec(Schema.Union([Borsh.U8, Borsh.U16]))).toThrow(
      /\$: Union has no Borsh layout/,
    )
    for (const schema of [Schema.Literal(1), Schema.Unknown, Schema.Null, Schema.Undefined]) {
      expect(() => Borsh.toCodec(schema)).toThrow(/\$: Unsupported encoded/)
    }
    for (const schema of [Schema.optionalKey(Borsh.U8), Schema.optional(Borsh.U8)]) {
      expect(() => Borsh.toCodec(schema)).toThrow(
        /^\$: Optional properties and elements have no Borsh layout on the encoded side; use Schema.Option for a Rust Option$/,
      )
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
    expect(() => Borsh.toCodec(mismatched)).toThrow(
      new Error("$: Float layout does not match encoded String"),
    )
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
    for (const [schema, tag] of [
      [integerOnString, "String"],
      [bigintWidthOnNumber, "Number"],
      [numberWidthOnBigint, "BigInt"],
    ] as const) {
      expect(() => Borsh.toCodec(schema)).toThrow(
        new Error(`$: Integer layout does not match encoded ${tag}`),
      )
    }
    const fixedOnString = Schema.String.pipe(
      Schema.annotateEncoded({
        [key]: { version: 1, kind: "fixedBytes", length: 2 },
      }),
    )
    expect(() => Borsh.toCodec(fixedOnString)).toThrow(
      new Error("$: Fixed bytes layout requires an encoded Uint8Array"),
    )
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

  it("reports nested metadata failures at their path", () => {
    const untypedKey: string = "@zorsh/effect/borsh/layout"
    const invalid = Schema.make(new SchemaAST.Number({ [untypedKey]: { version: 2 } }))
    expect(() => Borsh.toCodec(Schema.Struct({ amount: invalid }))).toThrow(
      new Error('$["amount"]: Invalid Borsh layout annotation'),
    )
    const discriminants = { version: 1, kind: "enum", tag: "_tag", discriminants: { A: 256 } }
    const enumLike = Schema.make(new SchemaAST.Number({ [untypedKey]: discriminants }))
    expect(() => Borsh.toCodec(Schema.Tuple([Borsh.U8, enumLike]))).toThrow(
      new Error("$[1]: Borsh enum discriminants must be unique integers from 0 to 255"),
    )
    const conflict = Borsh.U8.check(
      Schema.makeFilter(() => true, {
        [untypedKey]: { version: 1, kind: "integer", bits: 16, signed: false },
      }),
    )
    expect(() => Borsh.toCodec(Schema.Array(conflict))).toThrow(
      new Error("$[]: Conflicting Borsh layout annotations"),
    )
  })
})

describe("native declarations", () => {
  const unsupported =
    "has no Borsh layout; decode it from a Borsh-encodable schema with Schema.decodeTo"

  it("names declarations without a Borsh layout and suggests a transformation", () => {
    class Point {}
    for (const [schema, message] of [
      [Schema.Date, `$: Declaration effect/schema/Date ${unsupported}`],
      [Schema.DateTimeUtc, `$: Declaration effect/schema/DateTimeUtc ${unsupported}`],
      [Schema.Duration, `$: Declaration effect/schema/Duration ${unsupported}`],
      [Schema.instanceOf(Point), `$: Declaration ${unsupported}`],
      [
        Schema.Struct({ at: Schema.Array(Schema.Date) }),
        `$["at"][]: Declaration effect/schema/Date ${unsupported}`,
      ],
    ] as const) {
      expect(() => Borsh.toCodec(schema)).toThrow(new Error(message))
    }
  })

  it("looks up representation ids as own string keys only", () => {
    const run = Schema.Uint8Array.ast
    if (run._tag !== "Declaration") {
      throw new Error("Expected Declaration")
    }
    for (const id of ["toString", "constructor", "__proto__", 1]) {
      const ast = new SchemaAST.Declaration([], run.run, { representation: { id } })
      const name = typeof id === "string" ? `Declaration ${id}` : "Declaration"
      expect(() => Borsh.toCodec(Schema.make(ast))).toThrow(new Error(`$: ${name} ${unsupported}`))
    }
  })

  it("lets an explicit layout annotation take precedence over a native representation", () => {
    const key: string = "@zorsh/effect/borsh/layout"
    const annotate = (schema: Schema.Top, layout: object) =>
      schema.pipe(Schema.annotateEncoded({ [key]: layout }))
    const fixedBytes = { version: 1, kind: "fixedBytes", length: 2 }
    const integer = { version: 1, kind: "integer", bits: 8, signed: false }
    const enumLayout = { version: 1, kind: "enum", tag: "_tag", discriminants: {} }
    const fixedArray = { version: 1, kind: "fixedArray", length: 2 }
    for (const [schema, layout, message] of [
      [Schema.Option(Borsh.U8), fixedBytes, "$: Fixed bytes layout requires an encoded Uint8Array"],
      [
        Schema.ReadonlySet(Borsh.U8),
        fixedBytes,
        "$: Fixed bytes layout requires an encoded Uint8Array",
      ],
      [Borsh.Bytes, integer, "$: Integer layout does not match encoded Declaration"],
      [
        Schema.HashMap(Borsh.U8, Borsh.U8),
        integer,
        "$: Integer layout does not match encoded Declaration",
      ],
      [
        Schema.Result(Borsh.U8, Borsh.U8),
        enumLayout,
        "$: Enum layout requires a tagged union, literal union or Schema.Enum",
      ],
      [Borsh.Bytes, fixedArray, "$: Fixed array layout requires a homogeneous encoded array"],
      [Schema.Date, fixedBytes, "$: Fixed bytes layout requires an encoded Uint8Array"],
    ] as const) {
      expect(() => Borsh.toCodec(annotate(schema, layout))).toThrow(new Error(message))
    }
  })
})
