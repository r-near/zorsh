# @zorsh/effect

[Borsh](https://borsh.io) serialization for native [Effect 4 schemas](https://effect.website/docs/v4/schema/introduction/), with inferred TypeScript types. You describe the data with Effect's `Schema` module, add an explicit width where Rust needs one, and derive a binary codec.

## Install

```sh
npm install @zorsh/effect effect
```

## Quick start

```ts
import { Borsh } from "@zorsh/effect"
import { Effect, Schema } from "effect"

const Transfer = Schema.Struct({
  receiver: Schema.String,
  amount: Borsh.U128,
})
type Transfer = typeof Transfer.Type

const transfer: Transfer = { receiver: "alice.near", amount: 123n }
const codec = Borsh.toCodec(Transfer)
const bytes = Schema.encodeSync(codec)(transfer)
const decoded = Schema.decodeSync(codec)(bytes)

const program = Effect.gen(function* () {
  const bytes = yield* Schema.encodeEffect(codec)(transfer)
  return yield* Schema.decodeEffect(codec)(bytes)
})
```

`Transfer` is an ordinary `{ readonly receiver: string; readonly amount: bigint }` object, and the codec's encoded type is `Uint8Array`. Structs nest and write their fields in encoded schema order. That order and the integer widths must match the Rust type. Like any JavaScript object, a struct puts integer-like names such as `"0"` first.

The layout follows the schema's encoded side, and the schema's checks, brands, transformations and services still apply. Failures are `Schema.SchemaError`s; binary ones name the byte offset and path, such as `Truncated input: need 16 bytes at byte 14` then `at ["amount"]`. Unsupported layouts throw when `toCodec` is called. Codecs are cached per schema object and options.

## Type system

### Numbers, bytes and arrays

```ts
const Nonce = Borsh.U64
const Payload = Borsh.Bytes
const RequestId = Borsh.fixedBytes(32)
const Amounts = Schema.Array(Borsh.U16)
const ThreeAmounts = Borsh.fixedArray(Borsh.U16, 3)
const RecipientAmount = Schema.Tuple([Schema.String, Borsh.U128])

const threeAmounts = Schema.encodeSync(Borsh.toCodec(ThreeAmounts))([7, 513, 0])
// Uint8Array [7, 0, 1, 2, 0, 0]
```

`Borsh.U8` through `U128` and `I8` through `I128` give integers a width. Up to 32 bits they are `number`; 64 and 128 bits are `bigint`. All check their range, and take checks and brands as usual, such as `Borsh.U16.check(Schema.isGreaterThan(0))`. `F32` and `F64` keep signed zero, allow infinities and reject NaN. `F32` only accepts exact binary32 values, so round with `Math.fround(0.1)`.

`Bytes` is `Schema.Uint8Array`, Rust `Vec<u8>`, and `fixedBytes(32)` is `[u8; 32]`. `Schema.Array(item)` is `Vec<T>`. `fixedArray(item, 3)` is `[T; 3]`: an array schema with an exact-length check, written without a count prefix. A length check on a plain `Schema.Array` is still a `Vec`. Tuples write their elements in order, and `Borsh.Unit` is Rust `()`, which writes nothing.

### Enums

Rust enums map to native unions. Each variant's discriminant is its declaration index, as in Rust, so keep the TypeScript order identical to the Rust enum.

```ts
// enum Shape { Empty, Square(u32), Rect { width: u16, height: u16 } }
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

The wire format is a u8 discriminant followed by the variant's fields, without `_tag`. Values keep Effect's tagged shape, so `.cases`, `.match` and `Match.tag` work as usual. A `Schema.Union` of tagged structs works the same way.

Without `Borsh.discriminants`, `Schema.Literals` needs string literals, and a numeric TS enum needs the values 0 through n - 1 in order. Without `#[borsh(use_discriminant = true)]`, borsh-rs ignores `= N` values and uses declaration indices. With it, give every variant a unique discriminant from 0 to 255:

```ts
const Flag = Schema.TaggedUnion({ Off: {}, On: {} }).pipe(Borsh.discriminants({ Off: 1, On: 5 }))
```

Keys are `_tag` values, literal values as strings (`Schema.Literals([1, 5])` takes `{ 1: 4, 5: 9 }`), or TS enum member names. A missing or unknown key, or a repeated or out-of-range discriminant, throws when the schema is built. For a union tagged by another field, pass `{ tag: "kind" }` as the second argument. Other unions, including `Schema.NullOr`, throw in `toCodec`; use `Schema.Option` for nullable values.

### Options and Results

```ts
import { Option, Result } from "effect"
const Deposit = Schema.Option(Borsh.U128)
const deposit = Schema.encodeSync(Borsh.toCodec(Deposit))(Option.some(1_000_000n))
const Outcome = Schema.Result(Borsh.U16, Schema.String)
const outcome = Schema.encodeSync(Borsh.toCodec(Outcome))(Result.succeed(513))
```

`Option.none()` writes 0, and `Option.some(x)` writes 1 then `x`. Nested Options keep every state. `Result.fail(e)`, Rust `Err`, writes 0 then `e`; `Result.succeed(x)`, Rust `Ok`, writes 1 then `x`. Optional properties have no Borsh layout.

### Maps and sets

```ts
const Balances = Schema.ReadonlyMap(Schema.String, Borsh.U128)
const balances = Schema.encodeSync(Borsh.toCodec(Balances))(new Map([["alice.near", 123n]]))
```

`ReadonlyMap`, `ReadonlySet`, `HashMap` and `HashSet` write a u32 count, then entries sorted by key as Rust does. Keys must be `Schema.Boolean`, a Borsh integer or `Schema.String`. Decoding rejects duplicate or out-of-order keys.

## Generating fixtures

Effect's `Arbitrary.schema` samples values from these schemas for property tests or fixtures:

```ts
import { Arbitrary } from "effect"
const Request = Schema.Struct({
  receiver: Schema.String.check(Schema.isPattern(/^[a-z0-9]+\.near$/)),
  method: Schema.Literal("sign").pipe(Schema.encodeTo(Schema.String)),
  memo: Schema.String.check(
    Schema.makeFilter((s) => s.isWellFormed(), { expected: "well-formed Unicode" }),
  ),
  amount: Borsh.U128,
})
const requestCodec = Borsh.toCodec(Request)
const fixtures = Effect.runSync(
  Arbitrary.sampleEffect(Arbitrary.schema(Request), { count: 100, seed: 42 }),
).map((request) => Schema.encodeSync(requestCodec)(request))
```

Raw `Schema.String` samples can contain lone UTF-16 surrogates, which Borsh rejects, so narrow strings or check `isWellFormed` (ES2024 `lib`) as above. A bare `Schema.Literal` has no layout; encode it to `Schema.String`. Vectors of zero-sized values, such as `Schema.Array(Borsh.Unit)`, can be sampled but not encoded.

## Untrusted input

Each count is checked against the bytes that remain, but an item such as `Option.none()` costs one byte, so a 16 MiB message can hold 16 million values. Set limits yourself:

- `maxBytes` caps the bytes of each operation, 16 MiB by default.
- `maxItems` caps the total number of vector and fixed-array items, map entries and set members in one message, however nested. It has no default, so set it when decoding untrusted input. `Bytes` and strings count toward `maxBytes` only.
- `Borsh.maxLength(n)` bounds one length prefix: vector items, String UTF-8 bytes, Bytes length, map entries or set members.

```ts
const Receipt = Schema.Struct({
  logs: Schema.Array(Schema.String.check(Borsh.maxLength(1024))).check(Borsh.maxLength(100)),
  payload: Borsh.Bytes.check(Borsh.maxLength(64 * 1024)),
})
const codec = Borsh.toCodec(Receipt, { maxBytes: 256 * 1024, maxItems: 10_000 })
```

`maxItems` and `maxLength` fail as soon as a length is read, and before one is written: `Length 4294967295 exceeds maxLength (100) at byte 0`, with the path. They are codec limits, not schema checks, so they also apply under the `disableChecks` parse option. Middleware inside the schema, such as a field's `Schema.catchDecoding`, can't recover from them; middleware on the whole schema or around the codec can, except with the prefix decoders.

Put `maxLength` on the encoded side, before any transformation; after one it is an ordinary check. `Schema.isMaxLength` and friends are never wire limits.

With `maxItems` set, the binary decoding of a given schema does work and allocates memory in proportion to `maxBytes` plus `maxItems`. That bound stops there: your transformations and filters run in the schema pass afterwards and can do any amount of work.

## Decoding from a larger buffer

`Borsh.decodePrefixSync(schema, options)` and `decodePrefixEffect` decode one value at an offset and return `{ value, offset }`, where `offset` is where the next value starts. They share `toCodec`'s layout, limits, schema pass and errors, but allow bytes after the value:

```ts
const Frame = Schema.Struct({ id: Borsh.U32, body: Schema.String })
const decodeFrame = Borsh.decodePrefixSync(Frame, { maxBytes: 1 << 20, maxItems: 10_000 })
let offset = 0
while (offset < buffer.byteLength) {
  const next = decodeFrame(buffer, offset)
  handle(next.value)
  offset = next.offset
}
```

Offsets in errors are absolute positions in the buffer. `maxBytes` caps the value, not the buffer: once a length shows the value can't fit, it fails with `Value exceeds maxBytes`, however short the buffer is, so a streaming caller can stop waiting; `Truncated …` means the buffer ended first. `maxItems` applies per call, and `decodePrefixSync` accepts only schemas without decoding services. An offset outside the buffer is a `RangeError`. Schemas that always encode to zero bytes, such as `Borsh.Unit`, throw when the decoder is built, because the loop would never advance.

## Keeping the exact bytes

Signatures and hashes cover the bytes a message arrived as. `Borsh.withBytes(schema)` decodes to `{ value, bytes }`, where `bytes` is a copy of the exact span `value` was read from:

```ts
const Transaction = Schema.Struct({ receiverId: Schema.String, nonce: Borsh.U64 })
const SignedTransaction = Schema.Struct({
  transaction: Borsh.withBytes(Transaction),
  signature: Borsh.fixedBytes(64),
})
const signed = Schema.decodeSync(Borsh.toCodec(SignedTransaction))(input)

verify(signed.signature, sha256(signed.transaction.bytes))
```

It adds nothing to the wire and works in any position except a map key or set member. `Schema.Option(Borsh.withBytes(S))` leaves out the Option tag; `Borsh.withBytes(Schema.Option(S))` includes it. Encoding writes `value`, never `bytes`, and fails at `["bytes"]` unless the output matches `bytes` exactly, so a changed `value` can't go out with stale bytes. To send a new value, encode it with `schema` itself.

## Binary format and limits

Integers and floats are little endian, and booleans are one byte, 0 or 1. Strings are a u32 UTF-8 byte length then the bytes; malformed UTF-8 and lone surrogates are rejected. Vectors, `Bytes`, maps and sets start with a u32 count; structs, tuples and fixed arrays have no prefix. Enums, Options and Results start with a one-byte tag.

Decoding must consume the whole input; use the prefix decoders to allow trailing bytes. `maxBytes` must be a positive safe integer and `maxItems` a non-negative one; both apply to encoding too, so a codec can decode what it encodes. Inputs are never mutated, and decoded bytes never share the input's buffer. Borsh forbids vectors of zero-sized values, such as `Vec<()>` or a dataless single-variant enum (unless `Borsh.discriminants` makes it `#[repr(u8)]`), so encoding or decoding one fails. Recursion on the encoded side and non-enum unions are unsupported.

## Packaging

The package is ESM and uses standard browser APIs. CommonJS code can `require` it on Node 20.19+ and 22.12+; TypeScript CommonJS projects then need `module` set to `node20` or `nodenext`. Import `Borsh` from `@zorsh/effect`, or `import * as Borsh from "@zorsh/effect/Borsh"`. Effect is a peer dependency (`^4.0.5`); ES2022 TypeScript projects may need `ESNext.Disposable` in `lib` for Effect's declarations.

[Contributing](https://github.com/r-near/zorsh/blob/main/CONTRIBUTING.md) · [MIT license](https://github.com/r-near/zorsh/blob/main/packages/effect/LICENSE)
