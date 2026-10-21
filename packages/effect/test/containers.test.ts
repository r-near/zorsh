import { Effect, Exit, Option, Result, Schema, SchemaTransformation } from "effect"
import { expect, expectTypeOf, it } from "vite-plus/test"
import { Borsh } from "../src/index.js"

it("encodes the package README Transfer example with inferred ordinary objects", () => {
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

it("runs the package README mixed actions and Effect workflow", () => {
  const Asset = Schema.Struct({ contractId: Schema.String })
  const Recipient = Schema.Struct({
    accountId: Schema.String,
    memo: Schema.Option(Schema.String),
  })
  const Transfer = Schema.Struct({
    asset: Asset,
    recipient: Recipient,
    amount: Borsh.U128,
  })
  const Action = Schema.TaggedUnion({
    Transfer: { transfer: Transfer },
    Call: {
      contractId: Schema.String,
      method: Schema.String,
      args: Borsh.Bytes,
      deposit: Borsh.U128,
      gas: Borsh.U64,
    },
    Cancel: { nonce: Borsh.U64 },
  })
  const Batch = Schema.Struct({
    nonce: Borsh.U64,
    actions: Schema.Array(Action),
  })
  type Batch = typeof Batch.Type

  const batch: Batch = {
    nonce: 7n,
    actions: [
      {
        _tag: "Transfer",
        transfer: {
          asset: { contractId: "token.near" },
          recipient: { accountId: "alice.near", memo: Option.some("invoice 42") },
          amount: 1_000_000n,
        },
      },
      {
        _tag: "Call",
        contractId: "exchange.near",
        method: "refresh",
        args: new TextEncoder().encode("{}"),
        deposit: 0n,
        gas: 30_000_000_000_000n,
      },
      { _tag: "Cancel", nonce: 6n },
    ],
  }
  const codec = Borsh.toCodec(Batch)
  const bytes = Schema.encodeSync(codec)(batch)
  const decoded = Schema.decodeSync(codec)(bytes)
  expectTypeOf(decoded).toEqualTypeOf<Batch>()
  expect(decoded).toEqual(batch)
  const program = Effect.gen(function* () {
    const bytes = yield* Schema.encodeEffect(codec)(batch)
    return yield* Schema.decodeEffect(codec)(bytes)
  })
  expectTypeOf(program).toEqualTypeOf<Effect.Effect<Batch, Schema.SchemaError>>()
  expect(Effect.runSync(program)).toEqual(batch)
})

it("runs the package README number, byte, array and tuple examples", () => {
  const Amount = Borsh.U128
  const amount = Schema.encodeSync(Borsh.toCodec(Amount))(1_000_000n)
  const Nonce = Borsh.U64
  const nonce = Schema.encodeSync(Borsh.toCodec(Nonce))(7n)
  expect(amount).toHaveLength(16)
  expect(nonce).toEqual(Uint8Array.of(7, 0, 0, 0, 0, 0, 0, 0))
  const Payload = Borsh.Bytes
  const RequestId = Borsh.fixedBytes(32)
  const payload = Schema.encodeSync(Borsh.toCodec(Payload))(Uint8Array.of(1, 2, 3))
  const requestId = Schema.encodeSync(Borsh.toCodec(RequestId))(new Uint8Array(32))
  expect(payload).toEqual(Uint8Array.of(3, 0, 0, 0, 1, 2, 3))
  expect(requestId).toEqual(new Uint8Array(32))
  const Amounts = Schema.Array(Borsh.U16)
  const amounts = Schema.encodeSync(Borsh.toCodec(Amounts))([7, 513])
  const RecipientAmount = Schema.Tuple([Schema.String, Borsh.U128])
  const recipientAmount = Schema.encodeSync(Borsh.toCodec(RecipientAmount))(["alice.near", 123n])
  expect(amounts).toEqual(Uint8Array.of(2, 0, 0, 0, 7, 0, 1, 2))
  expect(Schema.decodeSync(Borsh.toCodec(RecipientAmount))(recipientAmount)).toEqual([
    "alice.near",
    123n,
  ])
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
    /Truncated vector payload at byte 4\n {2}at \["rows"\]$/,
  )
  expect(() => Schema.decodeSync(codec)(Uint8Array.of(1, 0, 0, 0, 7, 1, 0, 0, 0, 255))).toThrow(
    /Invalid UTF-8 at byte 9\n {2}at \["rows"\]\[0\]\[1\]$/,
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
    Schema.Struct({ a: Borsh.Unit }),
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
  expect(() => Schema.encodeSync(nested)([[]])).toThrow(
    /Borsh forbids vectors of zero-sized values at byte 4\n {2}at \[0\]$/,
  )
  expect(() => Schema.decodeSync(nested)(Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0))).toThrow(
    /Borsh forbids vectors of zero-sized values at byte 4\n {2}at \[0\]$/,
  )
  expect(Schema.encodeSync(Borsh.toCodec(Schema.Struct({})))({})).toEqual(new Uint8Array())
})

it("requires fixed encoded keys and positions and rejects mixed rests", () => {
  for (const [schema, message] of [
    [Schema.Struct({ value: Schema.optionalKey(Borsh.U8) }), /\$\["value"\]: Optional schemas/],
    [Schema.Tuple([Schema.optionalKey(Borsh.U8)]), /\$\[0\]: Optional schemas/],
    [Schema.Struct({ [Symbol("key")]: Borsh.U8 }), /Symbol keys have no Borsh struct layout/],
    [Schema.Record(Schema.String, Borsh.U8), /Index signatures have no Borsh struct layout/],
    [
      Schema.TupleWithRest(Schema.Tuple([Borsh.U8]), [Borsh.U8]),
      /Mixed tuple rests have no Borsh layout/,
    ],
    [
      Schema.TupleWithRest(Schema.Tuple([]), [Borsh.U8, Borsh.U8]),
      /Mixed tuple rests have no Borsh layout/,
    ],
    [Schema.NonEmptyArray(Borsh.U8), /Mixed tuple rests have no Borsh layout/],
  ] as const)
    expect(() => Borsh.toCodec(schema)).toThrow(message)
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

it("checks composite vector minimums including nested length prefixes", () => {
  const codec = Borsh.toCodec(Schema.Array(Schema.Tuple([Borsh.Unit, Borsh.U16, Schema.String])))
  const raw = Uint8Array.of(2, 0, 0, 0, 7, 0, 0, 0, 0, 0, 8, 0, 0, 0, 0, 0)
  expect(Schema.decodeSync(codec)(raw)).toEqual([
    [[], 7, ""],
    [[], 8, ""],
  ])
  expect(() => Schema.decodeSync(codec)(raw.subarray(0, 15))).toThrow(/Truncated vector payload/)
})

it("keeps a nested throwing getter in the native defect channel", () => {
  const defect = new Error("nested getter defect")
  const codec = Borsh.toCodec(
    Schema.Struct({ rows: Schema.Array(Schema.Struct({ value: Borsh.U8 })) }),
  )
  const exit = Effect.runSyncExit(
    Effect.suspend(() =>
      Schema.encodeEffect(codec)({
        rows: [
          {
            get value(): number {
              throw defect
            },
          },
        ],
      }),
    ),
  )
  expect(Exit.findDefect(exit)).toEqual(Result.succeed(defect))
})

it("bounds compilation work for shared schema DAGs", () => {
  for (const depth of [6, 12]) {
    const Leaf = Schema.Struct({ value: Borsh.U8 })
    let shared: Schema.Constraint = Leaf
    for (let i = 0; i < depth; i++) shared = Schema.Struct({ x: shared, y: shared })
    Schema.toEncoded(shared)
    const ast = Schema.toEncoded(Leaf).ast
    if (ast._tag !== "Objects") throw new Error("Expected struct AST")
    const fields = ast.propertySignatures
    let visits = 0
    Object.defineProperty(ast, "propertySignatures", {
      get: () => {
        visits++
        return fields
      },
    })
    const codec = Borsh.toCodec(shared)
    const first = visits
    expect(first).toBeLessThanOrEqual(depth + 1)
    expect(Borsh.toCodec(shared)).toBe(codec)
    expect(visits).toBe(first)
    expect(Borsh.toCodec(shared, { maxBytes: 1024 })).not.toBe(codec)
    expect(visits).toBe(first)
  }
})

it("keeps contextual binary paths when layouts are shared", () => {
  const Item = Schema.Struct({ active: Schema.Boolean })
  const codec = Borsh.toCodec(Schema.Struct({ first: Item, second: Item }))
  expect(() => Schema.decodeSync(codec)(Uint8Array.of(1, 2))).toThrow(
    /Invalid bool tag 2 at byte 1\n {2}at \["second"\]\["active"\]$/,
  )
})

it("enumerates numeric struct keys before ordinary keys", () => {
  const codec = Borsh.toCodec(Schema.Struct({ last: Borsh.U8, 10: Borsh.U8, 2: Borsh.U16 }))
  const value = { last: 9, 10: 7, 2: 258 }
  expect(Schema.encodeSync(codec)(value)).toEqual(Uint8Array.of(2, 1, 7, 9))
  expect(Schema.decodeSync(codec)(Uint8Array.of(2, 1, 7, 9))).toEqual(value)
})

it("uses a native check for nonempty Borsh vectors", () => {
  const Transfers = Schema.Array(Borsh.U16).check(Schema.isMinLength(1))
  const codec = Borsh.toCodec(Transfers)
  expect(Schema.encodeSync(codec)([7])).toEqual(Uint8Array.of(1, 0, 0, 0, 7, 0))
  expect(() => Schema.encodeSync(codec)([])).toThrow(Schema.SchemaError)
  expect(() => Schema.decodeSync(codec)(Uint8Array.of(0, 0, 0, 0))).toThrow(Schema.SchemaError)
})
