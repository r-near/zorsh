# Zorsh

Borsh binary serialization for TypeScript. Define native [Effect 4 schemas](https://effect.website/docs/v4/schema/introduction/), choose integer widths, and encode ordinary objects:

```ts
import { Borsh } from "@zorsh/effect"
import { Schema } from "effect"

const Transfer = Schema.Struct({
  receiver: Schema.String,
  amount: Borsh.U128,
})
type Transfer = typeof Transfer.Type

const codec = Borsh.toCodec(Transfer)
const bytes = Schema.encodeSync(codec)({
  receiver: "alice.near",
  amount: 123n,
})
const value = Schema.decodeSync(codec)(bytes)
```

`Transfer` is inferred as `{ readonly receiver: string; readonly amount: bigint }`. The codec carries that type and uses `Uint8Array` for its encoded bytes. Structs, tuples and arrays compose with native Effect validation, brands and transformations; `Schema.encodeEffect` and `Schema.decodeEffect` fit into Effect workflows.

[`@zorsh/effect`](packages/effect/README.md) is private and unpublished while its API develops. See its README for supported layouts and limits.

The published [`@zorsh/zorsh`](packages/zorsh/README.md) package provides the existing Zod-like API at version 0.5.2.

[Contributing](CONTRIBUTING.md) · [MIT license](LICENSE)
