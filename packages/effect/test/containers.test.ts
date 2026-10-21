import { Effect, Schema, SchemaTransformation } from "effect"
import { expect, expectTypeOf, it } from "vite-plus/test"
import { Borsh } from "../src/index.js"

it("encodes the root README Transfer example with inferred ordinary objects", () => {
  const Transfer = Schema.Struct({ receiver: Schema.String, amount: Borsh.U128 })
  type Transfer = typeof Transfer.Type
  const codec = Borsh.toCodec(Transfer)
  const bytes = Schema.encodeSync(codec)({ receiver: "alice.near", amount: 123n })
  const value = Schema.decodeSync(codec)(bytes)
  expectTypeOf(value).toEqualTypeOf<Transfer>()
  expect(value).toEqual({ receiver: "alice.near", amount: 123n })
  expect(bytes).toEqual(
    Uint8Array.of(
      10,
      0,
      0,
      0,
      ...new TextEncoder().encode("alice.near"),
      123,
      ...new Uint8Array(15),
    ),
  )
})

it("runs the package README Effect workflow", () => {
  const Batch = Schema.Struct({ receiver: Schema.String, amounts: Schema.Array(Borsh.U16) })
  const codec = Borsh.toCodec(Batch)
  const program = Effect.gen(function* () {
    const bytes = yield* Schema.encodeEffect(codec)({ receiver: "alice.near", amounts: [7, 513] })
    return yield* Schema.decodeEffect(codec)(bytes)
  })
  expect(Effect.runSync(program)).toEqual({ receiver: "alice.near", amounts: [7, 513] })
})

it("uses schema field order for nested structs and tuples, including _tag", () => {
  const schema = Schema.Struct({
    z: Schema.Tuple([Borsh.U8, Borsh.U16]),
    a: Schema.Struct({ _tag: Schema.String, ok: Schema.Boolean }),
  })
  const codec = Borsh.toCodec(schema)
  const value = { a: { ok: true, _tag: "x" }, z: [1, 513] as const }
  const bytes = Uint8Array.of(1, 1, 2, 1, 0, 0, 0, 120, 1)
  expect(Schema.encodeSync(codec)(value)).toEqual(bytes)
  expect(Schema.decodeSync(codec)(bytes)).toEqual(value)
  for (let cut = 0; cut < bytes.length; cut++)
    expect(() => Schema.decodeSync(codec)(bytes.subarray(0, cut))).toThrow(Schema.SchemaError)
  expect(() => Schema.decodeSync(codec)(Uint8Array.of(...bytes, 0))).toThrow(/Trailing/)
})

it("checks vector lengths before visiting items and keeps binary paths", () => {
  const codec = Borsh.toCodec(
    Schema.Struct({ rows: Schema.Array(Schema.Tuple([Borsh.U8, Schema.String])) }),
  )
  expect(() => Schema.decodeSync(codec)(Uint8Array.of(255, 255, 255, 255))).toThrow(
    /\$\["rows"\].*Truncated vector/,
  )
  expect(() => Schema.decodeSync(codec)(Uint8Array.of(1, 0, 0, 0, 7, 1, 0, 0, 0, 255))).toThrow(
    /\$\["rows"\]\[0\]\[1\] at byte 9.*Invalid UTF-8/,
  )
  const bounded = Borsh.toCodec(Schema.Array(Borsh.U16), { maxBytes: 7 })
  expect(Schema.encodeSync(bounded)([513])).toEqual(Uint8Array.of(1, 0, 0, 0, 1, 2))
  expect(() => Schema.encodeSync(bounded)([1, 2])).toThrow(/maxBytes/)
  expect(() => Schema.decodeSync(bounded)(new Uint8Array(8))).toThrow(/maxBytes/)
  expect(() =>
    Schema.decodeSync(Borsh.toCodec(Schema.Array(Borsh.U16)))(Uint8Array.of(2, 0, 0, 0, 1, 0)),
  ).toThrow(/Truncated vector/)
})

it("rejects visited vectors of Rust zero-sized values", () => {
  for (const item of [
    Borsh.Unit,
    Schema.Struct({}),
    Borsh.fixedBytes(0),
    Schema.Tuple([Borsh.Unit]),
  ]) {
    const codec = Borsh.toCodec(Schema.Array(item))
    expect(() => Schema.encodeSync(codec)([])).toThrow(/zero-sized/)
    expect(() => Schema.decodeSync(codec)(Uint8Array.of(0, 0, 0, 0))).toThrow(/zero-sized/)
  }
  const nested = Borsh.toCodec(Schema.Array(Schema.Array(Borsh.Unit)))
  expect(Schema.encodeSync(nested)([])).toEqual(Uint8Array.of(0, 0, 0, 0))
  expect(Schema.decodeSync(nested)(Uint8Array.of(0, 0, 0, 0))).toEqual([])
  expect(() => Schema.encodeSync(nested)([[]])).toThrow(/\$\[0\].*zero-sized/)
  expect(() => Schema.decodeSync(nested)(Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0))).toThrow(
    /\$\[0\].*zero-sized/,
  )
  expect(Schema.encodeSync(Borsh.toCodec(Schema.Struct({})))({})).toEqual(new Uint8Array())
})

it("requires fixed encoded keys and positions and rejects mixed rests", () => {
  for (const schema of [
    Schema.Struct({ value: Schema.optionalKey(Borsh.U8) }),
    Schema.Tuple([Schema.optionalKey(Borsh.U8)]),
    Schema.Struct({ [Symbol("key")]: Borsh.U8 }),
    Schema.Record(Schema.String, Borsh.U8),
    Schema.TupleWithRest(Schema.Tuple([Borsh.U8]), [Borsh.U8]),
    Schema.TupleWithRest(Schema.Tuple([]), [Borsh.U8, Borsh.U8]),
  ])
    expect(() => Borsh.toCodec(schema)).toThrow()
})

it("retains native checks, brands and transformations inside containers", () => {
  const Id = Borsh.U16.check(Schema.isGreaterThan(0)).pipe(Schema.brand("Id"))
  const Text = Borsh.U8.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transform({ decode: String, encode: Number }),
    ),
  )
  const schema = Schema.Struct({ id: Id, values: Schema.Array(Text) })
  const codec = Borsh.toCodec(schema)
  expectTypeOf(codec.Type).toEqualTypeOf<typeof schema.Type>()
  const value = { id: Id.make(7), values: ["8"] }
  expect(Schema.decodeSync(codec)(Schema.encodeSync(codec)(value))).toEqual(value)
  expect(() => Schema.decodeSync(codec)(Uint8Array.of(0, 0, 0, 0, 0, 0))).toThrow(
    Schema.SchemaError,
  )
  const rich = Schema.Struct({ count: Borsh.U8 }).pipe(
    Schema.decodeTo(
      Schema.Struct({ label: Schema.optionalKey(Schema.String) }),
      SchemaTransformation.transform({
        decode: ({ count }) => (count ? { label: String(count) } : {}),
        encode: ({ label }) => ({ count: Number(label ?? 0) }),
      }),
    ),
  )
  expect(Schema.decodeSync(Borsh.toCodec(rich))(Uint8Array.of(0))).toEqual({})
  expect(Schema.encodeSync(Borsh.toCodec(rich))({ label: "7" })).toEqual(Uint8Array.of(7))
})

it("decodes __proto__ as an own data property without changing prototypes", () => {
  const codec = Borsh.toCodec(Schema.Struct({ ["__proto__"]: Borsh.U8, constructor: Borsh.U8 }))
  const value = Schema.decodeSync(codec)(Uint8Array.of(7, 8))
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
  expect(Object.hasOwn(value, "__proto__")).toBe(true)
  expect(value.__proto__).toBe(7)
  expect(Schema.encodeSync(codec)(value)).toEqual(Uint8Array.of(7, 8))
})

it("uses encoded AST order after native key remapping", () => {
  const schema = Schema.Struct({ first: Borsh.U8, second: Borsh.U16 }).pipe(
    Schema.encodeKeys({ first: "10", second: "2" }),
  )
  const codec = Borsh.toCodec(schema)
  const raw = Uint8Array.of(2, 1, 7)
  expect(Schema.encodeSync(codec)({ first: 7, second: 258 })).toEqual(raw)
  expect(Schema.decodeSync(codec)(raw)).toEqual({ first: 7, second: 258 })
})

it("retains native empty-struct acceptance of non-nullish application values", () => {
  const codec = Borsh.toCodec(Schema.Struct({}))
  for (const value of [1, false, "", [], {}])
    expect(Schema.encodeSync(codec)(value)).toEqual(new Uint8Array())
  for (const value of [null, undefined])
    expect(() => Schema.encodeUnknownSync(codec)(value)).toThrow(Schema.SchemaError)
})

it("treats empty strings and vectors as prefixed values rather than zero-sized Rust values", () => {
  for (const schema of [Schema.Array(Schema.String), Schema.Array(Schema.Array(Borsh.U8))]) {
    const codec = Borsh.toCodec(schema)
    expect(Schema.encodeSync(codec)([])).toEqual(Uint8Array.of(0, 0, 0, 0))
  }
  const codec = Borsh.toCodec(Schema.Array(Schema.String))
  expect(Schema.decodeSync(codec)(Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0))).toEqual([""])
})
