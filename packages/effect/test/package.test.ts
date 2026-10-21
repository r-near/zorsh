import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
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

it("preserves built declaration inference in NodeNext and Bundler consumers", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url))
  const artifacts = join(root, ".artifacts")
  mkdirSync(artifacts, { recursive: true })
  const temp = mkdtempSync(join(artifacts, "effect-types-"))
  try {
    mkdirSync(join(temp, "node_modules/@zorsh"), { recursive: true })
    symlinkSync(join(root, "packages/effect"), join(temp, "node_modules/@zorsh/effect"), "dir")
    const fixture = readFileSync(new URL("./consumer.mts", import.meta.url), "utf8")
      .replaceAll('"../src/index.js"', '"@zorsh/effect"')
      .replaceAll('"../src/Borsh.js"', '"@zorsh/effect/Borsh"')
    writeFileSync(join(temp, "consumer.mts"), fixture)
    for (const [module, moduleResolution] of [
      ["NodeNext", "NodeNext"],
      ["ESNext", "Bundler"],
    ]) {
      writeFileSync(
        join(temp, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: "ES2022",
            lib: ["ES2022", "DOM", "ESNext.Disposable"],
            module,
            moduleResolution,
            types: [],
          },
          files: ["consumer.mts"],
        }),
      )
      execFileSync("vp", ["exec", "tsc", "-p", join(temp, "tsconfig.json")], {
        cwd: root,
        encoding: "utf8",
        timeout: 30000,
      })
    }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}, 60000)
