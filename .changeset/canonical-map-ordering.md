---
"@zorsh/zorsh": patch
---

Fix the ordering of `hashMap` keys and `hashSet` elements so it matches borsh-rs.

Borsh writes hash collections sorted by the key's Rust `Ord`. Zorsh sorted them with JavaScript's default `Array.prototype.sort()`, which compares stringified values: byte keys were ordered by their decimal digits (`[10]` before `[2]`, `"zeta"` before `"alpha"`), numeric keys by their digits, struct, tuple, and enum keys not at all, and strings by UTF-16 code unit. Any such map or set with more than one entry encoded differently from borsh-rs, which breaks hashes and signatures computed over the bytes (for example NEAR's NEP-616 deterministic account IDs).

Every schema type now has a comparator mirroring Rust `Ord`, and `hashMap`/`hashSet` sort with it: integers and floats numerically, strings by code point (UTF-8 order), bytes and vecs lexicographically with a shorter prefix first, `option` with `None` first, structs and tuples field by field, enums by variant index then payload, and nested maps and sets as sorted sequences of their entries. Insertion order no longer affects the output.

Serializing a `hashSet` or `hashMap` whose entries compare equal (for example two `Uint8Array` keys with the same bytes) now throws, since Borsh requires strictly ascending keys.
