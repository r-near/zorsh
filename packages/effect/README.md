# @zorsh/effect

Private development package at **0.0.0**, with native [Effect 4](https://effect.website/docs/v4/) schemas and Rust/NEAR Borsh-compatible primitive layouts. It is not published. This first slice supports primitives; container layouts follow separately.

Use `import { Borsh } from "@zorsh/effect"` or `import * as Borsh from "@zorsh/effect/Borsh"`. The package is ESM and its runtime uses standard browser APIs. Effect is a peer dependency (`^4.0.5`); development and tests pin 4.0.5. TypeScript projects targeting ES2022 may need `ESNext.Disposable` in `lib` for Effect's declarations.

```ts
import { Borsh } from "@zorsh/effect"
import { Schema, SchemaTransformation } from "effect"

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
const bytes = Schema.encodeSync(codec)({ amount: "7" })
// Uint8Array [7, 0, 0, 0, 0, 0, 0, 0]
const value = Schema.decodeSync(codec)(bytes)
// { amount: "7" }
```

`toCodec(schema, options?)` returns `Schema.Codec<S["Type"], Uint8Array, S["DecodingServices"], S["EncodingServices"]>`. It compiles `Schema.toEncoded(schema).ast`, then composes the binary conversion with the **original** schema through native `Schema.decodeTo`. The example's wire format is a u64 even though its application type is an object. Finite class/declaration application types also work when their encoded side is supported.

Refinements, brands, transformations and separate decoding/encoding services retain their native Effect behavior and types. The numeric constants remain ordinary schemas with `.check`, `.annotate`, `.make` and `.pipe`; for example, `Borsh.U16.check(Schema.isGreaterThan(0)).pipe(Schema.brand("Amount"))`. Numeric widths are explicit metadata and are never inferred from validation bounds. Layout annotations use native [`Schema.annotateEncoded`](https://effect.website/docs/v4/schema/annotations/); private metadata keys/descriptors are implementation details and must not be modified. Detectable conflicting descriptors across check layers are rejected. Effect's ordinary annotation overwrite behavior does not retain an arbitrary caller's earlier metadata history.

| Schema                                 | Borsh representation                                |
| -------------------------------------- | --------------------------------------------------- |
| `U8`, `U16`, `U32`, `I8`, `I16`, `I32` | Integer `number`, explicit width, little endian     |
| `U64`, `U128`, `I64`, `I128`           | Integer `bigint`, explicit width, little endian     |
| `F32`, `F64`                           | IEEE-754 little endian, no NaN                      |
| `Schema.Boolean`                       | Exactly one byte: 0 or 1                            |
| `Schema.String`                        | u32 UTF-8 byte length, then UTF-8 bytes             |
| `Schema.Uint8Array`, `Bytes`           | u32 byte length, then bytes (`Vec<u8>`)             |
| `fixedBytes(length)`                   | Exactly `length` bytes without a prefix (`[u8; N]`) |
| `Unit`, `Schema.Tuple([])`             | Empty bytes (Rust `()`)                             |

All integer schemas validate their actual range. The writer independently checks ranges and integer types even if native parse options disable refinements, preventing truncation or wrapping. Strings reject lone UTF-16 surrogates instead of silently replacing them; UTF-8 decoding is fatal and preserves a leading U+FEFF. Decoders reject malformed booleans, every NaN payload, truncated input and trailing bytes. Encoded output and decoded byte arrays own their storage; subarray offsets are respected and input is never mutated by the binary layer.

`F32` accepts only exactly representable binary32 values: `!Number.isNaN(n) && Object.is(Math.fround(n), n)`. Callers explicitly choose rounding with `Math.fround(0.1)`; passing `0.1` directly fails. Both floats accept positive/negative infinity and preserve signed zero. Their native `Schema.Number` base is deliberate; the Effect linter's suggestion to use `Finite` would exclude valid infinities. No lint diagnostics are suppressed.

Binary failures enter Effect's native schema failure channel as `SchemaIssue.InvalidValue`, with the schema path (`$`) and byte offset in the message. Standard `Schema.decodeEffect`/`encodeEffect` expose `Schema.SchemaError`; synchronous schema helpers throw on schema mismatch. Original user getters, refinements and transformations retain native defect behavior and are not converted into binary failures. Unsupported schema layouts and invalid codec options throw deliberately during `toCodec` construction.

`Borsh.toCodec(schema, { maxBytes })` bounds input and output byte length **per operation**, defaulting to **16 MiB**. The override must be a positive safe integer; `fixedBytes` lengths must be integers from 0 through 2^32 - 1. Readers check available input before taking payloads. Writers grow a bounded `Uint8Array`; strings are validated and their UTF-8 length/budget checked before encoding allocates payload bytes. Every call has its own reader/writer state.

The byte cap bounds binary buffers, not all memory or CPU used by an application schema. The original schema encoder executes before the binary writer; arbitrary user transformations, getters, validators and native parsing may allocate or do work first. That user code is trusted. Visible `Suspend` nodes, including those hidden in type parameters or encoding links, are rejected without invoking their thunks, even when the encoded side is finite. This avoids accepting recursive native parsing as though a binary byte cap bounded it.

Structs, nonempty tuples, vectors, options, unions/tagged variants, maps, sets, recursive wire schemas and arbitrary encoded declarations are **unsupported in this slice**. Plain `Schema.Number`/`BigInt` are ambiguous and rejected. There are no custom declaration wire hooks, registry wrappers, Rust schema exports or contract introspection.

The workspace tests cover boundaries, malformed data, native composition/service inference, Borsh specification goldens and bounded fast-check properties. The [primitive differential suite](test/differential/README.md) also compares built public exports against the independent borsh-rs oracle with shrinking and replay. It tests 18 primitive schema IDs; these checks do not establish full Borsh parity for future containers. Coverage-guided fuzzing remains separate work.
