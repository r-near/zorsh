# zorsh

## 0.5.1

### Patch Changes

- fcd894a: Fix the ordering of `hashMap` keys and `hashSet` elements so it matches borsh-rs.
  
  Borsh writes hash collections sorted by the key's Rust `Ord`. Zorsh sorted them with JavaScript's default `Array.prototype.sort()`, which compares stringified values: byte keys were ordered by their decimal digits (`[10]` before `[2]`, `"zeta"` before `"alpha"`), numeric keys by their digits, struct, tuple, and enum keys not at all, and strings by UTF-16 code unit. Any such map or set with more than one entry encoded differently from borsh-rs, which breaks hashes and signatures computed over the bytes (for example NEAR's NEP-616 deterministic account IDs).
  
  Every schema type now has a comparator mirroring Rust `Ord`, and `hashMap`/`hashSet` sort with it: integers and floats numerically, strings by code point (UTF-8 order), bytes and vecs lexicographically with a shorter prefix first, `option` with `None` first, structs and tuples field by field, enums by variant index then payload, and nested maps and sets as sorted sequences of their entries. Insertion order no longer affects the output.
  
  Serializing a `hashSet` or `hashMap` whose entries compare equal (for example two `Uint8Array` keys with the same bytes) now throws, since Borsh requires strictly ascending keys.

## 0.5.0

### Minor Changes

- 0354cd5: `b.vec()` with numeric element types now returns `Array<number>` / `Array<bigint>` instead of typed arrays (`Uint8Array`, `Uint32Array`, etc.). `b.bytes()` is unchanged and still returns `Uint8Array` for raw binary data. Wire format is unchanged.

## 0.4.0

### Minor Changes

- 677bcdd: Add a first-class bytes() helper for dynamic and fixed byte sequences (Vec<u8> / [u8; N]) and document its usage.

### Patch Changes

- 41425bd: Bump the dev-dependencies group across 1 directory with 5 updates

## 0.3.3

### Patch Changes

- 907140d: Bump the dev-dependencies group across 1 directory with 2 updates
- c7963e6: feat: add support for boolean values

## 0.3.2

### Patch Changes

- 806c6a9: Bump the dev-dependencies group across 1 directory with 3 updates
- cf60a33: Bump the dev-dependencies group with 2 updates

## 0.3.1

### Patch Changes

- d8a78d9: fix(enum): use direct enum types instead of value unions

## 0.3.0

### Minor Changes

- 32b75ea: Add support for TypeScript native enums via the new `b.nativeEnum()` function

### Patch Changes

- e479f0f: Bump lefthook from 1.11.1 to 1.11.2 in the dev-dependencies group

## 0.2.3

### Patch Changes

- 5aee991: Bump the dev-dependencies group across 1 directory with 5 updates

## 0.2.2

### Patch Changes

- 5e296d6: Bump @types/node from 22.13.2 to 22.13.4 in the dev-dependencies group

## 0.2.1

### Patch Changes

- 3238e1f: Linting

## 0.2.0

### Minor Changes

- 0ec6f2e: feat: add tuple type support

### Patch Changes

- 496e9e5: Release package

## 0.1.1

### Patch Changes

- 26e3db4: Initial release
