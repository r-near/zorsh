---
"@zorsh/effect": patch
---

Make Effect's `Arbitrary.schema` produce encodable samples. `fixedBytes(n)` samples exactly `n` bytes, and `F32` samples exact binary32 integers within ±2^24. `fixedArray(n)` on a schema without a transformation now also adds a native exact-length check, so samples have `n` items and JSON Schema output gains `minItems` and `maxItems`. Other lengths now fail Schema validation, including `Schema.is` and `make`, with "Expected a value with a length of n" instead of the binary layer's "Expected fixed array of length n". The README documents fixture generation, including strings with lone surrogates, zero-sized vectors and applying `fixedArray` before a transformation.
