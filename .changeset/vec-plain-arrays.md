---
"@zorsh/zorsh": major
---

`b.vec()` with numeric element types now returns `Array<number>` / `Array<bigint>` instead of typed arrays (`Uint8Array`, `Uint32Array`, etc.). `b.bytes()` is unchanged and still returns `Uint8Array` for raw binary data. Wire format is unchanged.
