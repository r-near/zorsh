---
"@zorsh/effect": patch
---

Make Effect's `Arbitrary.schema` produce encodable samples. `fixedBytes(n)` samples exactly `n` bytes, and `F32` samples exact binary32 integers within ±2^24. `fixedArray(n)` on a schema without a transformation now also adds a native exact-length check, so samples have `n` items, other lengths fail Schema validation before the binary layer, even without `toCodec`, and JSON Schema output gains `minItems` and `maxItems`. The README documents fixture generation, including strings with lone surrogates, zero-sized vectors and applying `fixedArray` before a transformation.
