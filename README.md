# Zorsh

Zorsh turns ordinary typed TypeScript values into [Borsh](https://borsh.io) bytes for Rust contracts, and decodes their responses back into values. A schema describes the field order and numeric widths the contract expects, while TypeScript infers the shape of your objects.

For a contract call that takes a receiver and a 128-bit token amount:

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

`Transfer` is inferred as `{ readonly receiver: string; readonly amount: bigint }`; `bytes` is a `Uint8Array` you can pass to a call that accepts Borsh arguments. Choose fields, their order and their widths to match your Rust contract.

The repository contains two packages:

- [`@zorsh/zorsh`](packages/zorsh/README.md) is the published library, with a Zod-like schema API.
- [`@zorsh/effect`](packages/effect/README.md) builds on native Effect schemas and integrates with Effect workflows. It is under development, private and unpublished.

See the package guides for examples, or [CONTRIBUTING.md](CONTRIBUTING.md) to work on Zorsh.

[MIT license](LICENSE)
