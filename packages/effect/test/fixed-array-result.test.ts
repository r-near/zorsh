import { Context, Effect, Exit, Result, Schema, SchemaAST, SchemaTransformation } from "effect"
import { expect, expectTypeOf, it } from "vite-plus/test"
import { Borsh } from "../src/index.js"
import { compile } from "../src/internal/compiler.js"
import { Writer } from "../src/internal/io.js"

it("writes fixed arrays without a prefix and enforces their binary length", () => {
  const schema = Borsh.fixedArray(Borsh.U16, 3)
  const codec = Borsh.toCodec(schema)
  const raw = Uint8Array.of(0, 0, 1, 0, 255, 255)
  expect(Schema.encodeSync(codec)([0, 1, 65535])).toEqual(raw)
  expect(Schema.decodeSync(codec)(raw)).toEqual([0, 1, 65535])
  for (let cut = 0; cut < raw.length; cut++) {
    expect(() => Schema.decodeSync(codec)(raw.subarray(0, cut))).toThrow(/Truncated fixed array/)
  }
  expect(() => Schema.decodeSync(codec)(Uint8Array.of(...raw, 0))).toThrow(/Trailing/)
  for (const value of [[], [1, 2], [1, 2, 3, 4], {}, null]) {
    expect(() => Schema.encodeUnknownSync(codec)(value)).toThrow(Schema.SchemaError)
  }
  expect(() => Schema.encodeUnknownSync(codec, { disableChecks: true })([1, 2])).toThrow(
    /^Expected fixed array of length 3 at byte 0$/,
  )
  const layout = compile(Schema.toEncoded(schema).ast)
  for (const value of [[], [1, 2, 3, 4], {}]) {
    expect(() => layout.write(new Writer(32), value)).toThrow(/Expected fixed array of length 3/)
  }
  expect(() => Schema.encodeSync(Borsh.toCodec(schema, { maxBytes: 5 }))([0, 1, 2])).toThrow(
    /maxBytes/,
  )
  expect(() => Schema.decodeSync(Borsh.toCodec(schema, { maxBytes: 5 }))(raw)).toThrow(/maxBytes/)
  const vector = Schema.Array(Borsh.U8).check(Schema.isBetweenLength(1, 1))
  expect(Schema.encodeSync(Borsh.toCodec(vector))([7])).toEqual(Uint8Array.of(1, 0, 0, 0, 7))
})

it("rejects invalid fixed-array lengths", () => {
  for (const length of [-1, 0.5, NaN, Infinity, 0x1_0000_0000]) {
    expect(() => Borsh.fixedArray(Borsh.U8, length)).toThrow(
      /fixedArray length must be a safe integer/,
    )
  }
  const huge = Borsh.fixedArray(Borsh.fixedArray(Borsh.U16, 0xffff_ffff), 0xffff_ffff)
  expect(compile(Schema.toEncoded(huge).ast).minBytes).toBe(Number.MAX_SAFE_INTEGER)
  expect(() => Schema.decodeSync(Borsh.toCodec(huge))(new Uint8Array())).toThrow(
    /Truncated fixed array/,
  )
})

it("matches fixed-array zero-sized visitation", () => {
  for (const [schema, value] of [
    [Borsh.fixedArray(Borsh.Unit, 0), []],
    [Borsh.fixedArray(Borsh.Unit, 1), [[]]],
    [Borsh.fixedArray(Schema.Array(Borsh.Unit), 0), []],
  ] as const) {
    const codec = Borsh.toCodec(schema)
    expect(Schema.encodeUnknownSync(codec)(value)).toEqual(new Uint8Array())
    expect(Schema.decodeSync(codec)(new Uint8Array())).toEqual(value)
  }
  for (const [schema, value] of [
    [Schema.Array(Borsh.fixedArray(Borsh.Unit, 1)), [[[]]]],
    [Borsh.fixedArray(Schema.Array(Borsh.Unit), 1), [[]]],
  ] as const) {
    const codec = Borsh.toCodec(schema)
    expect(() => Schema.encodeUnknownSync(codec)(value)).toThrow(/zero-sized/)
    expect(() => Schema.decodeSync(codec)(Uint8Array.of(0, 0, 0, 0))).toThrow(/zero-sized/)
  }
  const zeroItem = Schema.Array(Borsh.fixedArray(Borsh.U8, 0))
  expect(() => Schema.encodeSync(Borsh.toCodec(zeroItem))([])).toThrow(/zero-sized/)
})

it("preserves transformed array application values and directional services", () => {
  class Decode extends Context.Service<Decode, { readonly prefix: string }>()("FixedDecode") {}
  class Encode extends Context.Service<Encode, { readonly prefix: string }>()("FixedEncode") {}
  const schema = Borsh.fixedArray(Borsh.U16.check(Schema.isGreaterThan(0)), 2).pipe(
    Schema.decodeTo(
      Schema.Struct({ label: Schema.String }),
      SchemaTransformation.transformEffect({
        decode: (values) =>
          Effect.map(Decode, ({ prefix }) => ({ label: prefix + values.join(",") })),
        encode: ({ label }) =>
          Effect.map(Encode, ({ prefix }) => label.slice(prefix.length).split(",").map(Number)),
      }),
    ),
    Schema.brand("Pair"),
  )
  const codec = Borsh.toCodec(schema)
  expectTypeOf(codec).toEqualTypeOf<Schema.Codec<typeof schema.Type, Uint8Array, Decode, Encode>>()
  const raw = Uint8Array.of(1, 0, 2, 0)
  const value = Effect.runSync(
    Schema.decodeEffect(codec)(raw).pipe(Effect.provideService(Decode, { prefix: "v" })),
  )
  expect(value).toEqual({ label: "v1,2" })
  expect(
    Effect.runSync(
      Schema.encodeEffect(codec)(value).pipe(Effect.provideService(Encode, { prefix: "v" })),
    ),
  ).toEqual(raw)
  expect(() =>
    Effect.runSync(
      Schema.decodeEffect(codec)(Uint8Array.of(0, 0, 2, 0)).pipe(
        Effect.provideService(Decode, { prefix: "v" }),
      ),
    ),
  ).toThrow(Schema.SchemaError)
})

it("uses native Result values and Rust Err=0, Ok=1 tags", () => {
  const codec = Borsh.toCodec(Schema.Result(Borsh.U16, Schema.String))
  for (const [value, raw] of [
    [Result.succeed(513), Uint8Array.of(1, 1, 2)],
    [Result.fail("x"), Uint8Array.of(0, 1, 0, 0, 0, 120)],
  ] as const) {
    expect(Schema.encodeSync(codec)(value)).toEqual(raw)
    expect(Schema.decodeSync(codec)(raw)).toEqual(value)
    for (let cut = 0; cut < raw.length; cut++) {
      expect(() => Schema.decodeSync(codec)(raw.subarray(0, cut))).toThrow(Schema.SchemaError)
    }
    expect(() => Schema.decodeSync(codec)(Uint8Array.of(...raw, 0))).toThrow(/Trailing/)
  }
  for (let tag = 2; tag < 256; tag++) {
    expect(() => Schema.decodeSync(codec)(Uint8Array.of(tag))).toThrow(
      new RegExp(`Invalid Result tag ${tag}`),
    )
  }
  const boundary = compile(Schema.toEncoded(Schema.Result(Borsh.U8, Borsh.Unit)).ast)
  expect(() => boundary.write(new Writer(16), { _tag: "Success", success: 1 })).toThrow(
    /Expected Result/,
  )
  expect(() => boundary.write(new Writer(16), Result.succeed(256))).toThrow(
    expect.objectContaining({ message: "Integer outside u8 range at byte 1", path: ["success"] }),
  )
  expect(() => boundary.write(new Writer(16), Result.fail(7))).toThrow(
    expect.objectContaining({ message: "Expected tuple of length 0 at byte 1", path: ["failure"] }),
  )
})

it("retains nested Result paths, payload transformations and inactive branch nonvisitation", () => {
  const text = Borsh.U8.check(Schema.isGreaterThan(0)).pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transform({ decode: String, encode: Number }),
    ),
    Schema.brand("Text"),
  )
  const schema = Schema.Result(text, Schema.Array(Borsh.Unit))
  const codec = Borsh.toCodec(schema)
  expect(Schema.decodeSync(codec)(Uint8Array.of(1, 7))).toEqual(Result.succeed(text.make("7")))
  expect(Schema.encodeSync(codec)(Result.succeed(text.make("7")))).toEqual(Uint8Array.of(1, 7))
  expect(() => Schema.decodeSync(codec)(Uint8Array.of(1, 0))).toThrow(Schema.SchemaError)
  expect(() => Schema.decodeSync(codec)(Uint8Array.of(0, 0, 0, 0, 0))).toThrow(
    /Borsh forbids vectors of zero-sized values at byte 1\n {2}at \["failure"\]$/,
  )
  const Nested = Schema.TaggedUnion({
    Empty: {},
    Values: {
      rows: Borsh.fixedArray(Schema.Option(Schema.Result(Schema.Boolean, Borsh.Bytes)), 1),
    },
  }).pipe(Borsh.discriminants({ Empty: 0, Values: 3 }))
  const nested = Borsh.toCodec(Nested)
  expect(() => Schema.decodeSync(nested)(Uint8Array.of(3, 1, 1, 2))).toThrow(
    /Invalid bool tag 2 at byte 3\n {2}at \["rows"\]\[0\]\["value"\]\["success"\]$/,
  )
  const raw = Uint8Array.of(3, 1, 0, 1, 0, 0, 0, 7)
  const value = Schema.decodeSync(nested)(raw)
  raw[7] = 9
  expect(Schema.encodeSync(nested)(value)).toEqual(Uint8Array.of(3, 1, 0, 1, 0, 0, 0, 7))
  const bounded = Borsh.toCodec(Schema.Result(Borsh.Unit, Borsh.Unit), { maxBytes: 1 })
  expect(Schema.encodeSync(bounded)(Result.fail([]))).toEqual(Uint8Array.of(0))
  expect(Schema.decodeSync(bounded)(Uint8Array.of(1))).toEqual(Result.succeed([]))
  const defect = new Error("result payload defect")
  const withDefect = Borsh.toCodec(Schema.Result(Schema.Struct({ value: Borsh.U8 }), Borsh.Unit))
  const exit = Effect.runSyncExit(
    Effect.suspend(() =>
      Schema.encodeEffect(withDefect)(
        Result.succeed({
          get value(): number {
            throw defect
          },
        }),
      ),
    ),
  )
  expect(Exit.findDefect(exit)).toEqual(Result.succeed(defect))
  const shared = Schema.Result(Schema.Boolean, Borsh.Unit)
  expect(() =>
    Schema.decodeSync(Borsh.toCodec(Schema.Tuple([shared, shared])))(Uint8Array.of(0, 1, 2)),
  ).toThrow(/Invalid bool tag 2 at byte 2\n {2}at \[1\]\["success"\]$/)
})

it("validates Result arity and explicitly annotated fixed-array shapes", () => {
  const ast = Schema.Result(Borsh.U8, Borsh.Unit).ast
  const sparse: SchemaAST.AST[] = []
  sparse[1] = Borsh.Unit.ast
  for (const parameters of [
    [],
    [Borsh.U8.ast],
    [Borsh.U8.ast, Borsh.Unit.ast, Borsh.U8.ast],
    sparse,
  ]) {
    expect(() => compile(new SchemaAST.Declaration(parameters, ast.run, ast.annotations))).toThrow(
      /^\$: Result requires exactly 2 encoded type parameters$/,
    )
  }
})

it("keeps native array checks and fixed-item error paths", () => {
  const schema = Borsh.fixedArray(Borsh.U8, 1).check(Schema.isMinLength(2))
  const codec = Borsh.toCodec(schema)
  expect(() => Schema.decodeSync(codec)(Uint8Array.of(1))).toThrow(Schema.SchemaError)
  expect(() => Schema.encodeSync(codec)([1])).toThrow(Schema.SchemaError)
  const shared = Borsh.fixedArray(Schema.Boolean, 1)
  const nested = Borsh.toCodec(Schema.Struct({ a: shared, b: shared }))
  expect(() => Schema.decodeSync(nested)(Uint8Array.of(1, 2))).toThrow(
    /Invalid bool tag 2 at byte 1\n {2}at \["b"\]\[0\]$/,
  )
  const layout = compile(Schema.toEncoded(shared).ast)
  const shrinking = [true, true]
  Object.defineProperty(shrinking, 0, {
    get: () => {
      shrinking.length = 1
      return true
    },
  })
  expect(() =>
    compile(Schema.toEncoded(Borsh.fixedArray(Schema.Boolean, 2)).ast).write(
      new Writer(8),
      shrinking,
    ),
  ).toThrow(expect.objectContaining({ message: "Expected boolean at byte 1", path: [1] }))
  expect(() => layout.write(new Writer(8), [2])).toThrow(
    expect.objectContaining({ message: "Expected boolean at byte 0", path: [0] }),
  )
})

it("accepts vectors and fixed arrays of Results with zero-byte payloads", () => {
  const item = Schema.Result(Borsh.Unit, Schema.String)
  const unit = Borsh.Unit.make([])
  const values = [Result.succeed(unit), Result.succeed(unit)]
  const vector = Borsh.toCodec(Schema.Array(item))
  const raw = Uint8Array.of(2, 0, 0, 0, 1, 1)
  expect(Schema.encodeSync(vector)(values)).toEqual(raw)
  expect(Schema.decodeSync(vector)(raw)).toEqual(values)
  const units = Borsh.toCodec(Schema.Array(Schema.Result(Borsh.Unit, Borsh.Unit)))
  const mixed = [Result.fail(unit), Result.succeed(unit)]
  const mixedRaw = Uint8Array.of(2, 0, 0, 0, 0, 1)
  expect(Schema.encodeSync(units)(mixed)).toEqual(mixedRaw)
  expect(Schema.decodeSync(units)(mixedRaw)).toEqual(mixed)
  const fixed = Borsh.toCodec(Borsh.fixedArray(item, 2))
  expect(Schema.encodeSync(fixed)(values)).toEqual(Uint8Array.of(1, 1))
  expect(Schema.decodeSync(fixed)(Uint8Array.of(1, 1))).toEqual(values)
})

it("rejects truncated Result vectors before visiting their payloads", () => {
  const codec = Borsh.toCodec(Schema.Array(Schema.Result(Borsh.U16, Borsh.U64)))
  for (const raw of [
    Uint8Array.of(1, 0, 0, 0, 255, 0),
    Uint8Array.of(2, 0, 0, 0, 255, 0, 0, 0, 0),
  ]) {
    expect(() => Schema.decodeSync(codec)(raw)).toThrow(/^Truncated vector payload at byte 4$/)
  }
})

it("rejects fixed-array Suspend when deriving the codec, without evaluating its thunk", () => {
  let calls = 0
  const item = Schema.suspend(() => {
    calls++
    return Borsh.U8
  })
  const schema = Borsh.fixedArray(item, 2)
  expect(() => Borsh.toCodec(schema)).toThrow(
    new Error("$[]: Suspend/recursive schemas are unsupported"),
  )
  expect(calls).toBe(0)
})

it("uses the shorter Result failure minimum inside vectors", () => {
  const shorterErr = Borsh.toCodec(Schema.Array(Schema.Result(Borsh.U64, Borsh.U16)))
  const bytes = Uint8Array.of(1, 0, 0, 0, 0, 7, 0)
  expect(Schema.decodeSync(shorterErr)(bytes)).toEqual([Result.fail(7)])
  expect(Schema.encodeSync(shorterErr)([Result.fail(7)])).toEqual(bytes)
})
