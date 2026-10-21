---
"@zorsh/effect": minor
---

First public release. `Borsh.toCodec(schema)` derives a Borsh codec from the encoded side of a native Effect 4 schema, keeping its checks, brands, transformations and service requirements.

- Integers `U8` through `U128` and `I8` through `I128`, exact `F32` and `F64`, booleans, UTF-8 strings, `Bytes` and `fixedBytes(n)`.
- Structs, tuples, `Unit`, vectors and `fixedArray(n)` for Rust `[T; N]`.
- Rust enums from `Schema.TaggedUnion`, unions of tagged structs, string `Schema.Literals` and `Schema.Enum`, with declaration-index discriminants or explicit ones via `Borsh.discriminants`.
- `Schema.Option` and `Schema.Result`, plus `ReadonlyMap`, `ReadonlySet`, `HashMap` and `HashSet` in Rust key order.
- A `maxBytes` limit per operation (16 MiB by default), and binary failures reported as native Schema issues with a path and byte offset.
