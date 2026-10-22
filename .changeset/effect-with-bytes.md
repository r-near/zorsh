---
"@zorsh/effect": minor
---

Add `Borsh.withBytes(schema)`, which decodes to `{ value, bytes }`, where `bytes` is a copy of the exact bytes the value was read from, for signatures, hashes and forwarding as received. It adds nothing to the wire format. Encoding writes `value` and fails at `["bytes"]` if that doesn't reproduce `bytes`, so stale bytes are never sent; build new outgoing values with the plain schema. Arbitrary samples carry matching bytes, JSON codecs see a struct with base64 `bytes`, and equivalence compares both. The README gains a "Keeping the exact bytes" section.
