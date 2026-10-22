---
"@zorsh/effect": patch
---

Make Effect's `Arbitrary.schema` produce encodable samples. `F32` samples exact binary32 integers within ±2^24. `fixedBytes(n)` and `fixedArray(item, n)` use a native exact-length check, so samples have exactly `n` bytes or items. `fixedArray(item, n)` builds `Schema.Array(item)`, so JSON Schema output gains `minItems` and `maxItems`, and annotations, brands and transformations apply to the result as to any array schema. Other lengths now fail Schema validation, including `Schema.is` and `make`, with "Expected a value with a length of n". The README documents fixture generation, including strings with lone surrogates and zero-sized vectors.
