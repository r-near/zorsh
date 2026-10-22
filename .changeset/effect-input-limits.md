---
"@zorsh/effect": minor
---

Bound work on untrusted input before it happens. The binary layer now enforces the schema's own encoded-side `Schema.isMinLength`, `isMaxLength`, `isBetweenLength` and `isNonEmpty` checks on vectors and `Borsh.Bytes`, and `Schema.isMinSize`, `isMaxSize` and `isBetweenSize` on maps and sets, right after reading the length prefix and before reading any item. The failure is a native `Filter` issue for the failing check, with the count and byte offset, for example `Expected a value with a length of at most 100, got 4294967295 items at byte 0`. Acceptance is unchanged; oversized inputs that are also malformed further on now report the length first. A new `maxItems` option caps the total number of vector, fixed-array, map and set items per operation, nested ones included, checked when each length is known. It has no default limit and applies to encoding too. The README gains an "Untrusted input" section.
