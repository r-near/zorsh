---
"@zorsh/effect": patch
---

Make Effect's `Arbitrary.schema` produce encodable samples. `fixedBytes(n)` samples exactly `n` bytes, and `F32` samples exact binary32 integers within ±2^24. `fixedArray(n)` on a schema without a transformation now also adds a native exact-length check, so samples have `n` items and other lengths fail Schema validation before the binary layer. The README documents fixture generation, including strings with lone surrogates, zero-sized vectors and the length check for transformed fixed arrays.
