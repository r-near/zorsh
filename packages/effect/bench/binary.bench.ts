import { createRequire } from "node:module"
import { Option, Schema } from "effect"
import { expect, test } from "vite-plus/test"

// Measure the built packages through Node's own loader, bypassing Vite's module runner.
// `vp run bench` rebuilds them first; running this file directly measures the existing dist.
const require = createRequire(import.meta.url)
const { Borsh }: typeof import("../src/index.js") = require("../dist/index.js")
const { b }: typeof import("../../zorsh/src/index.js") = require("../../zorsh/dist/src/index.js")
// The dist must share this file's Effect instance.
expect(require("effect").Schema).toBe(Schema)

// The README complex example, with 100 actions cycling through every variant.
const Asset = Schema.Struct({ contractId: Schema.String })
const Recipient = Schema.Struct({ accountId: Schema.String, memo: Schema.Option(Schema.String) })
const Transfer = Schema.Struct({ asset: Asset, recipient: Recipient, amount: Borsh.U128 })
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
const Batch = Schema.Struct({ nonce: Borsh.U64, actions: Schema.Array(Action) })
const batch: typeof Batch.Type = {
  nonce: 7n,
  actions: Array.from({ length: 100 }, (_, i): typeof Action.Type =>
    i % 3 === 0
      ? {
          _tag: "Transfer",
          transfer: {
            asset: { contractId: "token.near" },
            recipient: { accountId: "alice.near", memo: Option.some("invoice 42") },
            amount: 1_000_000n + BigInt(i),
          },
        }
      : i % 3 === 1
        ? {
            _tag: "Call",
            contractId: "exchange.near",
            method: "refresh",
            args: new TextEncoder().encode("{}"),
            deposit: 0n,
            gas: 30_000_000_000_000n,
          }
        : { _tag: "Cancel", nonce: BigInt(i) },
  ),
}

const ZAction = b.enum({
  Transfer: b.struct({
    transfer: b.struct({
      asset: b.struct({ contractId: b.string() }),
      recipient: b.struct({ accountId: b.string(), memo: b.option(b.string()) }),
      amount: b.u128(),
    }),
  }),
  Call: b.struct({
    contractId: b.string(),
    method: b.string(),
    args: b.bytes(),
    deposit: b.u128(),
    gas: b.u64(),
  }),
  Cancel: b.struct({ nonce: b.u64() }),
})
const ZBatch = b.struct({ nonce: b.u64(), actions: b.vec(ZAction) })
const zbatch = {
  nonce: batch.nonce,
  actions: batch.actions.map((action) =>
    action._tag === "Transfer"
      ? {
          Transfer: {
            transfer: {
              ...action.transfer,
              recipient: {
                accountId: action.transfer.recipient.accountId,
                memo: Option.getOrNull(action.transfer.recipient.memo),
              },
            },
          },
        }
      : action._tag === "Call"
        ? {
            Call: {
              contractId: action.contractId,
              method: action.method,
              args: action.args,
              deposit: action.deposit,
              gas: action.gas,
            },
          }
        : { Cancel: { nonce: action.nonce } },
  ),
}

interface Case<A> {
  readonly name: string
  readonly schema: Schema.Codec<A, unknown>
  readonly value: A
  readonly zorsh: { serialize(value: never): Uint8Array; deserialize(bytes: Uint8Array): unknown }
  readonly zorshValue: unknown
}

function defineCase<A>(c: Case<A>) {
  return c
}

for (const c of [
  defineCase({
    name: "README Batch, 100 actions",
    schema: Batch,
    value: batch,
    zorsh: ZBatch,
    zorshValue: zbatch,
  }),
  defineCase({
    name: "Array(U32), 1000 items",
    schema: Schema.Array(Borsh.U32),
    value: Array.from({ length: 1000 }, (_, i) => i * 7919),
    zorsh: b.vec(b.u32()),
    zorshValue: undefined,
  }),
  defineCase({
    name: "Array(String), 1000 items",
    schema: Schema.Array(Schema.String),
    value: Array.from({ length: 1000 }, (_, i) => `account-${i}.near`),
    zorsh: b.vec(b.string()),
    zorshValue: undefined,
  }),
]) {
  const codec = Borsh.toCodec(c.schema)
  const encode = Schema.encodeSync(codec)
  const decode = Schema.decodeSync(codec)
  const bytes = encode(c.value)
  const zorshValue = (c.zorshValue ?? c.value) as never
  const encodeSchema = Schema.encodeSync(c.schema)
  const decodeSchema = Schema.decodeSync(c.schema)
  const encoded = encodeSchema(c.value)

  test(`${c.name}: encode`, async ({ bench }) => {
    expect(c.zorsh.serialize(zorshValue)).toEqual(bytes)
    await bench.compare(
      bench("@zorsh/effect", () => encode(c.value)),
      bench("@zorsh/effect, inline toCodec", () =>
        Schema.encodeSync(Borsh.toCodec(c.schema))(c.value)),
      bench("@zorsh/zorsh", () => c.zorsh.serialize(zorshValue)),
      bench("Effect schema pass only", () => encodeSchema(c.value)),
    )
  })

  test(`${c.name}: decode`, async ({ bench }) => {
    expect(decode(bytes)).toEqual(c.value)
    expect(c.zorsh.deserialize(bytes)).toEqual(zorshValue)
    await bench.compare(
      bench("@zorsh/effect", () => decode(bytes)),
      bench("@zorsh/zorsh", () => c.zorsh.deserialize(bytes)),
      bench("Effect schema pass only", () => decodeSchema(encoded)),
    )
  })
}
