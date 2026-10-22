import assert from "node:assert/strict"
import { Option, Result, Schema } from "effect"
import fc from "fast-check"
import { afterAll, beforeAll, describe, it } from "vite-plus/test"
import { Oracle, assertProperty } from "./oracle.js"
import { bytes, hex, stringArbitrary } from "./primitives.js"
const packageName = "@zorsh/effect"
const { Borsh }: typeof import("../../src/index.js") = await import(packageName)

let oracle: Oracle
beforeAll(() => {
  oracle = new Oracle()
})
afterAll(async () => {
  await oracle.close()
})

/**
 * Rust encodes each value on its own, so its bytes are the exact span `withBytes` must keep, at
 * the root, between other fields and as consecutive vector items.
 */
function spec<A>(
  id: string,
  schema: Schema.Codec<A>,
  arbitrary: fc.Arbitrary<A>,
  transport: (value: A) => unknown,
) {
  const Framed = Schema.Struct({
    head: Borsh.U8,
    first: Borsh.withBytes(schema),
    second: Borsh.withBytes(schema),
    tail: Borsh.U8,
  })
  return {
    id,
    arbitrary: fc.tuple(arbitrary, arbitrary).map(([first, second]) => ({
      first: transport(first),
      second: transport(second),
    })),
    root: Borsh.toCodec(Borsh.withBytes(schema)),
    framed: Borsh.toCodec(Framed),
    items: Borsh.toCodec(Schema.Array(Borsh.withBytes(schema))),
    plain: Borsh.toCodec(schema),
  }
}

/** The oracle serves one request at a time. */
async function rustBytes(id: string, value: unknown): Promise<Uint8Array> {
  const encoded = await oracle.request(id, "encode", { value })
  assert.ok(encoded.ok)
  return bytes(encoded.hex)
}

const option = <A>(arbitrary: fc.Arbitrary<A>) =>
  fc.option(arbitrary, { nil: undefined }).map(Option.fromUndefinedOr)
function optionTransport<A>(value: Option.Option<A>, inner: (value: A) => unknown): unknown {
  return Option.isNone(value) ? { tag: "None" } : { tag: "Some", value: inner(value.value) }
}
const u16 = fc.integer({ min: 0, max: 65535 })
const u128 = fc.bigInt({ min: 0n, max: (1n << 128n) - 1n })

const entries = [
  spec(
    "transfer",
    Schema.Struct({ receiver: Schema.String, amount: Borsh.U128 }),
    fc.record({ receiver: stringArbitrary, amount: u128 }),
    ({ receiver, amount }) => ({ receiver, amount: String(amount) }),
  ),
  spec(
    "storage_deposit",
    Schema.Struct({
      token_id: Schema.String,
      account_id: Schema.String,
      storage_deposit_amount: Schema.Option(Borsh.U128),
    }),
    fc.record({
      token_id: stringArbitrary,
      account_id: stringArbitrary,
      storage_deposit_amount: option(u128),
    }),
    (value) => ({
      ...value,
      storage_deposit_amount: optionTransport(value.storage_deposit_amount, String),
    }),
  ),
  spec(
    "shape",
    Schema.TaggedUnion({
      Empty: {},
      Square: { value: Borsh.U32 },
      Rect: { width: Borsh.U16, height: Borsh.U16 },
    }),
    fc.oneof(
      fc.constant({ _tag: "Empty" } as const),
      fc.record({ _tag: fc.constant("Square" as const), value: fc.nat({ max: 0xffff_ffff }) }),
      fc.record({ _tag: fc.constant("Rect" as const), width: u16, height: u16 }),
    ),
    (value) => {
      switch (value._tag) {
        case "Empty":
          return { variant: value._tag, value: null }
        case "Square":
          return { variant: value._tag, value: String(value.value) }
        case "Rect":
          return {
            variant: value._tag,
            value: { width: String(value.width), height: String(value.height) },
          }
      }
    },
  ),
  spec(
    "option_option_u8",
    Schema.Option(Schema.Option(Borsh.U8)),
    option(option(fc.integer({ min: 0, max: 255 }))),
    (value) => optionTransport(value, (value) => optionTransport(value, String)),
  ),
  spec(
    "result_u16_string",
    Schema.Result(Borsh.U16, Schema.String),
    fc.oneof(u16.map(Result.succeed), stringArbitrary.map(Result.fail)),
    (value) =>
      Result.isSuccess(value)
        ? { tag: "Ok", value: String(value.success) }
        : { tag: "Err", value: value.failure },
  ),
  spec(
    "array_u16_3",
    Borsh.fixedArray(Borsh.U16, 3),
    fc.array(u16, { minLength: 3, maxLength: 3 }),
    (values) => values.map(String),
  ),
  spec("vec_u16", Schema.Array(Borsh.U16), fc.array(u16, { maxLength: 48 }), (values) =>
    values.map(String),
  ),
  spec(
    "map_u16_string",
    Schema.ReadonlyMap(Borsh.U16, Schema.String),
    fc
      .uniqueArray(fc.tuple(u16, stringArbitrary), { selector: ([key]) => key, maxLength: 12 })
      .map((entries) => new Map(entries)),
    (map) =>
      Array.from(map)
        .sort(([a], [b]) => a - b)
        .map(([key, value]) => [String(key), value]),
  ),
]

for (const entry of entries) {
  describe(`borsh-rs ${entry.id} through withBytes`, () => {
    it("keeps the bytes Rust writes for each value, wherever it sits", async () => {
      await assertProperty(
        entry.arbitrary,
        async ({ first, second }) => {
          const left = await rustBytes(entry.id, first)
          const right = await rustBytes(entry.id, second)

          const root = Schema.decodeSync(entry.root)(left)
          assert.equal(hex(root.bytes), hex(left))
          assert.equal(hex(Schema.encodeSync(entry.plain)(root.value)), hex(left))
          assert.equal(hex(Schema.encodeSync(entry.root)(root)), hex(left))

          const frame = Uint8Array.of(0xa5, ...left, ...right, 0x5a)
          const framed = Schema.decodeSync(entry.framed)(frame)
          assert.equal(hex(framed.first.bytes), hex(left))
          assert.equal(hex(framed.second.bytes), hex(right))
          assert.equal(hex(Schema.encodeSync(entry.framed)(framed)), hex(frame))

          const items = Uint8Array.of(2, 0, 0, 0, ...left, ...right)
          const decoded = Schema.decodeSync(entry.items)(items)
          assert.deepEqual(
            decoded.map((item) => hex(item.bytes)),
            [hex(left), hex(right)],
          )
          assert.equal(hex(Schema.encodeSync(entry.items)(decoded)), hex(items))
        },
        { numRuns: 200, seed: 20261020 },
      )
    })
  })
}
