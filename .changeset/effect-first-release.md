---
"@zorsh/effect": minor
---

First public release. `Borsh.toCodec(schema)` derives a Borsh codec from the encoded side of a native Effect 4 schema, keeping its checks, brands, transformations and service requirements. It supports integers `U8` through `U128` and `I8` through `I128`, exact `F32` and `F64`, booleans, UTF-8 strings, `Bytes` and `fixedBytes(n)`; structs, tuples, `Unit`, vectors and `fixedArray(n)` for Rust `[T; N]`; Rust enums from `Schema.TaggedUnion`, unions of tagged structs, string `Schema.Literals` and `Schema.Enum`, with declaration-index discriminants or explicit ones via `Borsh.discriminants`; `Schema.Option` and `Schema.Result`; and `ReadonlyMap`, `ReadonlySet`, `HashMap` and `HashSet` in Rust key order. Each operation has a `maxBytes` limit (16 MiB by default), and binary failures are native Schema issues with a path and byte offset.
