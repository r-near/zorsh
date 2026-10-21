# @zorsh/effect

Borsh serialization with native [Effect 4 schemas](https://effect.website/docs/v4/schema/introduction/) and inferred TypeScript types. It supports primitives, structs, required tuples, fixed and variable arrays, Rust enums, native `Option` and `Result` values, maps and sets.

## Install

```sh
npm install @zorsh/effect effect
```

`effect` is a peer dependency (`^4.0.5`).

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
const ThreeAmounts = Schema.Array(Borsh.U16).pipe(Borsh.fixedArray(3))
const threeAmounts = Schema.encodeSync(Borsh.toCodec(ThreeAmounts))([7, 513, 0])

const RecipientAmount = Schema.Tuple([Schema.String, Borsh.U128])
const recipientAmount = Schema.encodeSync(Borsh.toCodec(RecipientAmount))(["alice.near", 123n])
```

An array writes a u32 item count followed by its items, like Rust `Vec<T>`. For a nonempty vector, use `Schema.Array(item).check(Schema.isMinLength(1))`. `Borsh.fixedArray(3)` applies the Rust `[T; 3]` layout to a homogeneous native encoded array. The codec requires exactly three items and writes no count prefix. The helper rejects other schema shapes at construction. An exact-length native check alone still describes a vector. The helper preserves the schema, including array-to-application transformations; it does not add a check to the decoded application value. A tuple writes its elements in order without a prefix. `Borsh.Unit` is `Schema.Tuple([])`, representing Rust `()` with no bytes.

### Structs

Compose schemas directly. Each nested struct writes its fields in encoded schema order. Integer-index names sort numerically before ordinary string names, including names produced by `Schema.encodeKeys`:

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

### Enums

Rust enums map to native Effect unions without a Borsh-specific call. As in Rust, each variant's discriminant is its declaration index:

```rust
enum Shape {
    Empty,
    Square(u32),
    Rect { width: u16, height: u16 },
}
```

```ts
const Shape = Schema.TaggedUnion({
  Empty: {},
  Square: { value: Borsh.U32 },
  Rect: { width: Borsh.U16, height: Borsh.U16 },
})
const shape = Schema.encodeSync(Borsh.toCodec(Shape))({ _tag: "Square", value: 5 })
```

| Rust                                                  | Effect schema                                                   |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| Unit variant `Empty`                                  | `Empty: {}`                                                     |
| Tuple or newtype variant `Square(u32)`                | `Square: { value: Borsh.U32 }`; name the fields in order        |
| Struct variant `Rect { width: u16, height: u16 }`     | `Rect: { width: Borsh.U16, height: Borsh.U16 }`                 |
| C-like enum `enum Status { Pending, Done }`           | `Schema.Literals(["Pending", "Done"])` or `Schema.Enum(Status)` |
| `#[borsh(use_discriminant = true)]` with `= N` values | `.pipe(Borsh.discriminants({ ... }))`                           |

The wire format is a u8 discriminant followed by the selected variant's fields in encoded order, excluding `_tag`. Tuple and struct variants are identical on the wire, so the TypeScript field names are free. Values keep Effect's internally tagged shape, such as `{ _tag: "Square", value: 5 }`, so `.cases`, `.guards`, `.match` and `Match.tag` work unchanged. `Schema.Union` of `TaggedStruct` or `TaggedClass` members works the same way.

Reordering variants changes the bytes, as it does in Rust. Keep TypeScript declaration order identical to the Rust enum. `Schema.TaggedUnion`, like `Schema.Enum` of a plain object, follows JavaScript key order, which puts integer-like names first; Rust variant and TS enum member names never have that form.

C-like enums decode to the literal or TS enum value. `Schema.Literals` requires string literals. A string TS enum uses member order; a numeric TS enum must have values 0 through n - 1 in declaration order. Mixed string and numeric TS enums are unsupported.

When the Rust enum uses `#[borsh(use_discriminant = true)]`, list every variant's discriminant once, with unique integers from 0 to 255:

```ts
const Flag = Schema.TaggedUnion({ Off: {}, On: {} }).pipe(Borsh.discriminants({ Off: 1, On: 5 }))
```

Without that attribute, borsh-rs writes declaration indices even if variants declare `= N` values. Keys are the encoded `_tag` values, literal values as strings (`Schema.Literals([1, 5])` takes `{ 1: 4, 5: 9 }`), or TS enum member names. Missing and unknown keys are type errors, including through brands, refinements and transformations of the enum schema; the map needs literal keys, so cast a dynamically built `Record<string, number>`. The map annotates the union itself, so a union rebuilt from its members needs it again. Non-string literal unions, such as `Schema.Literals([1, 5])`, and sparse numeric TS enums require this map. For unions keyed by another literal field, pass `{ tag: "kind" }` as the second argument; apply `Schema.toTaggedUnion("kind")` afterwards to keep its helpers. Enums have 1 through 256 variants. A dataless single-variant enum is zero-sized in Rust unless it has a `#[repr]`, which only affects vectors of it: without a map it is treated as zero-sized, and with a map as `#[repr(u8)]`. For `#[repr(u8)] enum E { Only }`, use `Borsh.discriminants({ Only: 0 })`. A `use_discriminant` single-variant enum without `#[repr]` stays zero-sized in Rust, so borsh-rs rejects vectors of it that this codec accepts. Other unions, including `Schema.NullOr`, are rejected at codec construction; use `Schema.Option` for nullable values.

### Options

Use `Schema.Option` with Effect's `Option.none()` and `Option.some(value)`:

```ts
import { Option } from "effect"

const Deposit = Schema.Option(Borsh.U128)
const deposit = Schema.encodeSync(Borsh.toCodec(Deposit))(Option.some(1_000_000n))
```

`None` writes 0; `Some` writes 1 followed by its payload. Nested Options preserve every state: `None`, `Some(None)` and `Some(Some(7))` encode as `00`, `0100` and `010107` with an inner `U8`. Optional properties and `Schema.NullOr` do not define a Borsh Option layout.

### Results

Use `Schema.Result(success, failure)` with Effect's `Result.succeed(value)` and `Result.fail(error)`:

```ts
import { Result } from "effect"

const Outcome = Schema.Result(Borsh.U16, Schema.String)
const outcome = Schema.encodeSync(Borsh.toCodec(Outcome))(Result.succeed(513))
```

Rust `Err` (Effect `Failure`) writes 0 followed by the failure payload. Rust `Ok` (Effect `Success`) writes 1 followed by the success payload. Both channels retain their native schemas and transformations.

### Maps and sets

Use `Schema.ReadonlyMap(key, value)` with JavaScript `Map`, `Schema.ReadonlySet(item)` with JavaScript `Set`, or native `Schema.HashMap` and `Schema.HashSet` with Effect's collections:

```ts
const Balances = Schema.ReadonlyMap(Schema.String, Borsh.U128)
const balances = Schema.encodeSync(Borsh.toCodec(Balances))(new Map([["alice.near", 123n]]))
const Members = Schema.HashSet(Schema.String)
```

Collections write a u32 count followed by entries sorted by encoded key. Keys and set elements support `Schema.Boolean`, explicit Borsh integers and `Schema.String`; other key schemas are rejected at codec construction. Integer order is numeric; strings follow Rust's UTF-8 ordering. Duplicate or descending wire keys fail before collection construction. Encoding preserves the input collection. Map values can use any supported layout, including unit. Inner transformations retain native Effect behavior; non-injective key transformations can collapse entries.

## Complex example

A fictional contract accepts mixed actions in one batch. Reuse the asset, recipient and transfer structs inside a native enum:

```ts
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
```

The inferred `Batch` type includes every nested field and narrows each action by `_tag`. Field order, integer widths and enum variant order must match the actual Rust contract.

## Using with Effect

Use the same codec inside an Effect workflow:

```ts
import { Effect } from "effect"

const program = Effect.gen(function* () {
  const bytes = yield* Schema.encodeEffect(codec)(batch)
  return yield* Schema.decodeEffect(codec)(bytes)
})
```

Both operations expose `Schema.SchemaError` in the error channel. Synchronous helpers throw that error. Binary failures are native issues with a path and the byte offset, so they render like other Schema errors, for example `Truncated vector payload at byte 12` followed by `at ["actions"]`. Unsupported layouts and invalid options throw when `toCodec` is constructed. Codecs are memoized by schema identity and `maxBytes`, so repeated `toCodec` calls with the same schema object are cheap; a structurally equal but separately constructed schema compiles again. User transformations and validators retain their native Effect behavior, including defects.

## Binary format and limits

Integers and floats are little endian. Booleans use one byte, 0 or 1. Strings use a u32 UTF-8 byte length followed by UTF-8; lone UTF-16 surrogates and malformed UTF-8 are rejected, and a leading U+FEFF is preserved. Structs and tuples have no prefix; variable arrays and byte vectors use u32 lengths; fixed arrays have no prefix. Enums, Options and Results use one-byte tags.

Decoded input must be consumed completely: truncated data and trailing bytes fail. Encoded output and decoded byte arrays own their storage; the binary layer respects subarray offsets and does not mutate inputs.

`Borsh.toCodec(schema, { maxBytes })` limits input and output bytes per operation, defaulting to **16 MiB**. Overrides must be positive safe integers; `fixedBytes` and `fixedArray` accept lengths from 0 through 2^32 - 1. Vector and collection counts are checked against remaining bytes before items are allocated. The cap bounds binary buffers, not the work or heap needed for zero-byte fixed arrays; native schema parsing and application validators or transformations can do their own work independently.

Vectors of Rust zero-sized values, including empty tuples, empty structs, `fixedBytes(0)` and enums with one dataless variant and default discriminants, fail when visited, even for an empty array. An empty outer `Schema.Array(Schema.Array(Borsh.Unit))` succeeds because it visits no inner array. `Option.none()` also skips its inner value; `Option.some([])` visits and rejects an inner vector of unit. Fixed arrays may contain zero-sized items: `[(); 1]` uses no bytes, while `Vec<[(); 1]>` fails when visited. A zero-length fixed array skips its items, so `[Vec<()>; 0]` succeeds and `[Vec<()>; 1]` fails. Results also visit only their selected payload. Encoded struct keys and tuple positions must be required. Non-enum unions, recursion and optional properties are unsupported.

The package is ESM and uses standard browser APIs. CommonJS code can `require` it on Node versions that support `require(esm)`. Import `Borsh` from `@zorsh/effect`, or use `import * as Borsh from "@zorsh/effect/Borsh"`. Effect is a peer dependency (`^4.0.5`); ES2022 TypeScript projects may need `ESNext.Disposable` in `lib` for Effect declarations.

[Contributing](https://github.com/r-near/zorsh/blob/main/CONTRIBUTING.md) · [MIT license](https://github.com/r-near/zorsh/blob/main/packages/effect/LICENSE)
