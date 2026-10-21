# @zorsh/effect

Borsh codecs from native [Effect 4 schemas](https://effect.website/docs/v4/schema/introduction/). This package is private at 0.0.0 and is not published.

```ts
import { Borsh } from "@zorsh/effect"
import { Effect, Schema } from "effect"

const Batch = Schema.Struct({
  receiver: Schema.String,
  amounts: Schema.Array(Borsh.U16),
})
const codec = Borsh.toCodec(Batch)

const program = Effect.gen(function* () {
  const bytes = yield* Schema.encodeEffect(codec)({
    receiver: "alice.near",
    amounts: [7, 513],
  })
  return yield* Schema.decodeEffect(codec)(bytes)
})
```

`toCodec(schema, options?)` derives the wire layout from the schema's encoded side. It retains the native `Type`, checks, brands, transformations and separate decoding/encoding services. Use `Schema.encodeSync` and `Schema.decodeSync` for synchronous schemas, or compose the Effect helpers as above. Numeric constants are ordinary schemas with `.check`, `.annotate`, `.make` and `.pipe`.

| Schema                                 | Borsh layout                                    |
| -------------------------------------- | ----------------------------------------------- |
| `U8`, `U16`, `U32`, `I8`, `I16`, `I32` | Integer `number`, explicit width, little endian |
| `U64`, `U128`, `I64`, `I128`           | Integer `bigint`, explicit width, little endian |
| `F32`, `F64`                           | IEEE-754 little endian, excluding NaN           |
| `Schema.Boolean`                       | One byte: 0 or 1                                |
| `Schema.String`                        | u32 UTF-8 byte length, then UTF-8               |
| `Schema.Uint8Array`, `Bytes`           | u32 byte length, then bytes (`Vec<u8>`)         |
| `fixedBytes(length)`                   | Exactly `length` bytes, no prefix (`[u8; N]`)   |
| `Unit`, `Schema.Tuple([])`             | Empty bytes (Rust `()`)                         |
| `Schema.Struct({ ... })`               | Fields in encoded schema order, no prefix       |
| `Schema.Tuple([ ... ])`                | Required elements in order, no prefix           |
| `Schema.Array(item)`                   | u32 item count, then items (`Vec<T>`)           |

Widths are never inferred from numeric validation bounds. All integer schemas enforce their range; 64-bit and 128-bit values use native `bigint`. The writer also checks integer ranges when native checks are disabled.

`F32` requires exact binary32 values: round explicitly with `Math.fround(0.1)`. Both floats preserve signed zero and allow infinities; every NaN payload is rejected. Strings reject lone UTF-16 surrogates, decode UTF-8 strictly and preserve a leading U+FEFF.

Structs require encoded keys with string or number names. `_tag` is an ordinary field. Optional encoded keys/tuple positions, mixed tuple rests, index signatures, options, unions/enums, maps, sets, fixed arrays, arbitrary declarations and recursive schemas are unsupported. Plain `Schema.Number` and `Schema.BigInt` require an explicit Borsh width. Application types may use other shapes through native transformations when their encoded layout is supported. Visible `Suspend` nodes are rejected without evaluating their thunks, including on the application side.

Arrays of Rust zero-sized values, such as empty tuples, empty structs and `fixedBytes(0)`, are rejected when visited, even for an empty array. An empty outer `Schema.Array(Schema.Array(Unit))` succeeds because it visits no inner array.

Encoding and decoding failures use `Schema.SchemaError`; synchronous helpers throw that error. Binary messages include the field/index path and byte offset. User getters, validators and transformations retain native defect behavior. Unsupported layouts and invalid options throw during `toCodec` construction.

`Borsh.toCodec(schema, { maxBytes })` limits input and output bytes per operation; the default is **16 MiB**. Overrides must be positive safe integers. `fixedBytes` accepts lengths from 0 through 2^32 - 1. Vector decoders check their count against remaining bytes before allocating items. This byte cap bounds binary buffers; application transformations, validators and native schema parsing may allocate or do work independently.

Decoding consumes the whole input and rejects truncation or trailing bytes. Encoded output and decoded byte arrays own their storage. The binary layer respects subarray offsets and does not mutate inputs.

Import from `@zorsh/effect` as above, or use `import * as Borsh from "@zorsh/effect/Borsh"`. The package is ESM and uses standard browser APIs. Effect is a peer dependency (`^4.0.5`); development pins 4.0.5. ES2022 TypeScript projects may need `ESNext.Disposable` in `lib` for Effect declarations.

[Contributing](../../CONTRIBUTING.md) · [MIT license](LICENSE)
