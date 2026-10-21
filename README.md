# Zorsh

Zorsh turns ordinary typed TypeScript values into [Borsh](https://borsh.io) bytes for Rust contracts, and decodes their responses back into values. Its Zod-like schema API describes the field order and numeric widths the contract expects, while TypeScript infers the shape of your objects.

Install the published library:

```sh
npm install @zorsh/zorsh
```

For a contract call that takes a receiver and a 128-bit token amount:

```ts
import { b } from "@zorsh/zorsh"

const Transfer = b.struct({
  receiver: b.string(),
  amount: b.u128(),
})
type Transfer = b.infer<typeof Transfer>

const transfer: Transfer = { receiver: "alice.near", amount: 123n }
const bytes = Transfer.serialize(transfer)
const value = Transfer.deserialize(bytes)
```

`Transfer` is inferred as `{ receiver: string; amount: bigint }`; `bytes` is a `Uint8Array` you can pass to a call that accepts Borsh arguments. Choose fields, their order and their widths to match your Rust contract. The library also supports nested structs, enums, options, vectors, byte arrays, maps and sets.

See the [`@zorsh/zorsh` guide](packages/zorsh/README.md) for the full API and examples.

[`@zorsh/effect`](packages/effect/README.md) is a separate native Effect implementation under development. It is private and unpublished.

[Contributing](CONTRIBUTING.md) · [MIT license](LICENSE)
