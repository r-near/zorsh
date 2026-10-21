# @zorsh/effect

Borsh serialization with native [Effect 4 schemas](https://effect.website/docs/v4/schema/introduction/) and inferred TypeScript types. This package is under development, private and unpublished. It currently supports primitives, structs, required tuples and arrays.

## Quick start

Describe the arguments your Rust contract expects, then derive a binary codec:

```ts
import { Borsh } from "@zorsh/effect"
import { Schema } from "effect"

const Transfer = Schema.Struct({
  receiver: Schema.String,
  amount: Borsh.U128,
})
type Transfer = typeof Transfer.Type

const transfer: Transfer = { receiver: "alice.near", amount: 123n }
const codec = Borsh.toCodec(Transfer)
const bytes = Schema.encodeSync(codec)(transfer)
const decoded = Schema.decodeSync(codec)(bytes)
```

`Transfer` is an ordinary `{ readonly receiver: string; readonly amount: bigint }` object. The codec's encoded type is `Uint8Array`. Field order and numeric widths must match the Rust contract.

## Type system

### Numbers

TypeScript's `number` and `bigint` do not specify a Borsh width. Use `Borsh.U8` through `U128`, or `I8` through `I128`, to supply that information:

```ts
const Amount = Borsh.U128
const amount = Schema.encodeSync(Borsh.toCodec(Amount))(1_000_000n)
const Nonce = Borsh.U64
const nonce = Schema.encodeSync(Borsh.toCodec(Nonce))(7n)
```

8-, 16- and 32-bit integers use `number`; 64- and 128-bit integers use `bigint`. All enforce their range. The constants are native schemas: add checks and brands with Effect's usual APIs, such as `Borsh.U16.check(Schema.isGreaterThan(0))`.

`F32` and `F64` provide floating-point layouts. `F32` requires exact binary32 values, so round deliberately with `Math.fround(0.1)`. Both preserve signed zero and allow infinities; NaN is rejected.

### Bytes

Use a byte vector for a variable payload, or fixed bytes when the contract expects an exact-size identifier:

```ts
const Payload = Borsh.Bytes
const RequestId = Borsh.fixedBytes(32)

const payload = Schema.encodeSync(Borsh.toCodec(Payload))(Uint8Array.of(1, 2, 3))
const requestId = Schema.encodeSync(Borsh.toCodec(RequestId))(new Uint8Array(32))
```

`Bytes` (also `Schema.Uint8Array`) writes a u32 byte length before the bytes. `fixedBytes(32)` writes exactly 32 bytes without a prefix, like Rust `[u8; 32]`.

### Arrays and tuples

Use native `Schema.Array` for a variable-length sequence and `Schema.Tuple` for required positional fields:

```ts
const Amounts = Schema.Array(Borsh.U16)
const amounts = Schema.encodeSync(Borsh.toCodec(Amounts))([7, 513])

const RecipientAmount = Schema.Tuple([Schema.String, Borsh.U128])
const recipientAmount = Schema.encodeSync(Borsh.toCodec(RecipientAmount))(["alice.near", 123n])
```

An array writes a u32 item count followed by its items, like Rust `Vec<T>`. A tuple writes its elements in order without a prefix. `Borsh.Unit` is `Schema.Tuple([])`, representing Rust `()` with no bytes.

### Structs

Compose schemas directly. Each nested struct writes its fields in schema order:

```ts
const Recipient = Schema.Struct({
  accountId: Schema.String,
  memo: Schema.String,
})
const Transfer = Schema.Struct({
  recipient: Recipient,
  amount: Borsh.U128,
})
```

Native checks, brands, transformations and decoding/encoding service requirements carry through `Borsh.toCodec`. The binary layout follows the schema's encoded side.

## Complex example

A contract that accepts a batch of transfers can reuse the same asset and recipient schemas for every item:

```ts
const Asset = Schema.Struct({ contractId: Schema.String })
const Recipient = Schema.Struct({
  accountId: Schema.String,
  memo: Schema.String,
})
const Transfer = Schema.Struct({
  asset: Asset,
  recipient: Recipient,
  amount: Borsh.U128,
})
const Batch = Schema.Struct({
  nonce: Borsh.U64,
  transfers: Schema.Array(Transfer),
})
type Batch = typeof Batch.Type

const batch: Batch = {
  nonce: 7n,
  transfers: [
    {
      asset: { contractId: "token.near" },
      recipient: { accountId: "alice.near", memo: "invoice 42" },
      amount: 1_000_000n,
    },
    {
      asset: { contractId: "token.near" },
      recipient: { accountId: "bob.near", memo: "invoice 43" },
      amount: 250_000n,
    },
  ],
}
const codec = Borsh.toCodec(Batch)
const bytes = Schema.encodeSync(codec)(batch)
const decoded = Schema.decodeSync(codec)(bytes)
```

The inferred `Batch` type includes every nested field. These fields describe an example contract interface; use the exact layout your contract defines.

## Using with Effect

Use the same codec inside an Effect workflow:

```ts
import { Effect } from "effect"

const program = Effect.gen(function* () {
  const bytes = yield* Schema.encodeEffect(codec)(batch)
  return yield* Schema.decodeEffect(codec)(bytes)
})
```

Both operations expose `Schema.SchemaError` in the error channel. Synchronous helpers throw that error. Unsupported layouts and invalid options throw when `toCodec` is constructed. User transformations and validators retain their native Effect behavior, including defects.

## Binary format and limits

Integers and floats are little endian. Booleans use one byte, 0 or 1. Strings use a u32 UTF-8 byte length followed by UTF-8; lone UTF-16 surrogates and malformed UTF-8 are rejected, and a leading U+FEFF is preserved. Structs and tuples have no prefix; arrays and byte vectors use u32 lengths.

Decoded input must be consumed completely: truncated data and trailing bytes fail. Encoded output and decoded byte arrays own their storage; the binary layer respects subarray offsets and does not mutate inputs.

`Borsh.toCodec(schema, { maxBytes })` limits input and output bytes per operation, defaulting to **16 MiB**. Overrides must be positive safe integers; `fixedBytes` accepts lengths from 0 through 2^32 - 1. Vector counts are checked against remaining bytes before items are allocated. The cap bounds binary buffers; native schema parsing and application validators or transformations can do their own work independently.

Arrays of Rust zero-sized values, including empty tuples, empty structs and `fixedBytes(0)`, fail when visited, even for an empty array. An empty outer `Schema.Array(Schema.Array(Borsh.Unit))` succeeds because it visits no inner array. Encoded struct keys and tuple positions must be required.

The package is ESM and uses standard browser APIs. Import `Borsh` from `@zorsh/effect`, or use `import * as Borsh from "@zorsh/effect/Borsh"`. Effect is a peer dependency (`^4.0.5`); ES2022 TypeScript projects may need `ESNext.Disposable` in `lib` for Effect declarations.

[Contributing](../../CONTRIBUTING.md) · [MIT license](LICENSE)
