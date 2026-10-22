---
"@zorsh/effect": patch
---

`Borsh.discriminants` takes a plain `Record<string, number>`. Missing and unknown labels are no longer type errors, but they still throw when the map is applied to a schema, and duplicate or out-of-range discriminants still throw when it is called. Borsh's layout annotation is now private, so hand-written layout annotations are neither typed nor supported. Recursion on the type side of a transformation is accepted, because the binary layer never sees it; `Schema.suspend` on the encoded side still throws at `toCodec`, with its path. Prefix decoders no longer check argument types; an offset outside the input is still a `RangeError`. `withBytes` drops its code-generation hook.
