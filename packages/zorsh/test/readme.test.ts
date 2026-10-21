import { expect, expectTypeOf, it } from "vite-plus/test"
import { b } from "../src/index.js"

it("runs the root README quick start with inferred objects", () => {
  const Transfer = b.struct({ receiver: b.string(), amount: b.u128() })
  type Transfer = b.infer<typeof Transfer>
  const transfer: Transfer = { receiver: "alice.near", amount: 123n }
  const bytes = Transfer.serialize(transfer)
  const value = Transfer.deserialize(bytes)
  expectTypeOf(value).toEqualTypeOf<{ receiver: string; amount: bigint }>()
  expect(bytes).toEqual(
    Uint8Array.of(
      10,
      0,
      0,
      0,
      ...new TextEncoder().encode("alice.near"),
      123,
      ...new Uint8Array(15),
    ),
  )
  expect(value).toEqual(transfer)
})
