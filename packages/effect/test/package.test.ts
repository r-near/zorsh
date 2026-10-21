import { readFileSync } from "node:fs"
import { Schema } from "effect"
import { expect, it } from "vite-plus/test"
const packageName = "@zorsh/effect"
const directName = "@zorsh/effect/Borsh"
const { Borsh }: typeof import("../src/index.js") = await import(packageName)
const Direct: typeof import("../src/Borsh.js") = await import(directName)

it("keeps the private package exports usable", () => {
  const manifest: { private: boolean; version: string } = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  )
  expect(manifest.private).toBe(true)
  expect(manifest.version).toBe("0.0.0")
  expect(Borsh.toCodec).toBe(Direct.toCodec)
  expect(Borsh.U16).toBe(Direct.U16)
  expect(Schema.encodeSync(Borsh.toCodec(Direct.U16))(0x1234)).toEqual(Uint8Array.of(52, 18))
})
