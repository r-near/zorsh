---
"@zorsh/effect": minor
---

Add `Borsh.decodePrefixEffect` and `Borsh.decodePrefixSync`, which decode one value at an offset in a larger buffer and return a `Borsh.Prefix`, `{ value, offset }`, where `offset` is where the next value starts. They share the codec's compiled layout, limits, schema pass and errors, but allow bytes after the value. `maxBytes` caps the bytes the value uses rather than the buffer, and a read whose length or count shows the value cannot fit fails with "Value exceeds maxBytes" however short the buffer is. Error offsets are positions in the buffer, and an offset outside the buffer is a defect. Decoding middleware can recover from schema-pass failures but not from binary ones, which leave no offset to return. Schemas that always encode to zero bytes, such as `Borsh.Unit`, are rejected when the decoder is built, so a decoding loop always advances. The README gains a "Decoding from a larger buffer" section.
