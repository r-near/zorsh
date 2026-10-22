import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { it } from "vite-plus/test"
import type * as Binary from "../src/binary-io.js"
import type * as Public from "../src/index.js"

const root = resolve(__dirname, "../../..")
it("packed public package preserves CJS, ESM, deep paths and types", async () => {
  const artifacts = join(root, ".artifacts")
  mkdirSync(artifacts, { recursive: true })
  const temp = mkdtempSync(join(artifacts, "consumer-"))
  try {
    const manifest: { version: string } = JSON.parse(
      readFileSync(join(root, "packages/zorsh/package.json"), "utf8"),
    )
    execFileSync("tar", [
      "-xzf",
      join(artifacts, `zorsh-zorsh-${manifest.version}.tgz`),
      "-C",
      temp,
    ])
    mkdirSync(join(temp, "node_modules/@zorsh"), { recursive: true })
    symlinkSync(join(temp, "package"), join(temp, "node_modules/@zorsh/zorsh"), "dir")
    writeFileSync(join(temp, "package.json"), JSON.stringify({ private: true, type: "module" }))
    const require = createRequire(join(temp, "package.json"))
    const { b, Schema }: typeof Public = require("@zorsh/zorsh")
    const esm: typeof Public = await import(
      pathToFileURL(join(temp, "package/dist/src/index.js")).href
    )
    assert.equal(esm.b, b)
    assert.equal(require("@zorsh/zorsh/dist/src/schema").Schema, Schema)
    for (const name of ["index", "schema", "registry", "binary-io", "types"]) {
      require(`@zorsh/zorsh/dist/src/${name}`)
      await import(pathToFileURL(join(temp, `package/dist/src/${name}.js`)).href)
    }
    const schema = b.struct({ id: b.u16(), flags: b.vec(b.bool()), payload: b.bytes(2) })
    const value = { id: 0x1234, flags: [true, false], payload: new Uint8Array([7, 8]) }
    const golden = new Uint8Array([52, 18, 2, 0, 0, 0, 1, 0, 7, 8])
    assert.ok(schema instanceof Schema)
    assert.deepEqual(schema.serialize(value), golden)
    assert.deepEqual(schema.deserialize(golden), value)
    const { BinaryReader }: typeof Binary = require("@zorsh/zorsh/dist/src/binary-io.js")
    assert.equal(new BinaryReader(Uint8Array.of(52, 18)).readUint16(), 0x1234)
    const fixture = readFileSync(join(__dirname, "fixtures/consumer.mts"), "utf8")
      .replaceAll('"../../src/index.js"', '"@zorsh/zorsh"')
      .replaceAll('"../../src/', '"@zorsh/zorsh/dist/src/')
    for (const extension of ["cts", "mts", "ts"]) {
      writeFileSync(join(temp, `consumer.${extension}`), fixture)
    }
    for (const [module, moduleResolution, files] of [
      ["NodeNext", "NodeNext", ["consumer.cts", "consumer.mts"]],
      ["ESNext", "Bundler", ["consumer.ts"]],
    ]) {
      writeFileSync(
        join(temp, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: "ES2022",
            module,
            moduleResolution,
            types: [],
          },
          files,
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
