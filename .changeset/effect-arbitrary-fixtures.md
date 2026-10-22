---
"@zorsh/effect": patch
---

Make Effect's `Arbitrary.schema` produce encodable samples. `fixedBytes(n)` samples exactly `n` bytes, and `F32` samples exact binary32 integers within ±2^24. `fixedArray(item, n)` replaces the `fixedArray(n)` combinator: it builds `Schema.Array(item)` with a native exact-length check, so samples have `n` items, JSON Schema output gains `minItems` and `maxItems`, and annotations, brands and transformations apply to the result as to any array schema. `fixedBytes(n)` uses the same native check. Other lengths now fail Schema validation, including `Schema.is` and `make`, with "Expected a value with a length of n". The README documents fixture generation, including strings with lone surrogates and zero-sized vectors.
