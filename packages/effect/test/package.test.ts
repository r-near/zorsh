import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { expect, it } from "vite-plus/test"

const root = fileURLToPath(new URL("../../../", import.meta.url))
const artifacts = join(root, ".artifacts")

/** Extract the packed tarball into a consumer's node_modules, under the root for peer resolution. */
function install(): string {
  const manifest: { version: string } = JSON.parse(
    readFileSync(join(root, "packages/effect/package.json"), "utf8"),
  )
  const tarball = join(artifacts, `zorsh-effect-${manifest.version}.tgz`)
  const files = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n")
  expect(files.filter((file) => !/^package\/dist\/[\w-]+\.(js|d\.ts)$/.test(file)).sort()).toEqual([
    "package/LICENSE",
    "package/README.md",
    "package/package.json",
  ])
  for (const entry of ["index", "Borsh"])
    expect(files).toEqual(
      expect.arrayContaining([`package/dist/${entry}.js`, `package/dist/${entry}.d.ts`]),
    )
  mkdirSync(artifacts, { recursive: true })
  const temp = mkdtempSync(join(artifacts, "effect-consumer-"))
  const target = join(temp, "node_modules/@zorsh/effect")
  mkdirSync(target, { recursive: true })
  execFileSync("tar", ["-xzf", tarball, "-C", target, "--strip-components", "1"])
  writeFileSync(join(temp, "package.json"), JSON.stringify({ private: true, type: "module" }))
  return temp
}

it("packs publishable metadata and resolves both entry points from Node ESM and CJS", () => {
  const temp = install()
  try {
    const manifest = JSON.parse(
      readFileSync(join(temp, "node_modules/@zorsh/effect/package.json"), "utf8"),
    )
    expect(manifest.private).toBeUndefined()
    expect(manifest).toMatchObject({
      name: "@zorsh/effect",
      license: "MIT",
      type: "module",
      sideEffects: false,
      files: ["dist"],
      publishConfig: { access: "public" },
      peerDependencies: { effect: "^4.0.5" },
      repository: { url: "git+https://github.com/r-near/zorsh.git", directory: "packages/effect" },
    })
    expect(manifest.dependencies).toBeUndefined()
    expect(manifest.exports).toEqual({
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./Borsh": { types: "./dist/Borsh.d.ts", default: "./dist/Borsh.js" },
    })
    const script = `
      import { Borsh } from "@zorsh/effect"
      import * as Direct from "@zorsh/effect/Borsh"
      import { Schema } from "effect"
      if (Borsh.toCodec !== Direct.toCodec || Borsh.U16 !== Direct.U16) throw new Error("entry points differ")
      const bytes = [...Schema.encodeSync(Borsh.toCodec(Direct.U16))(0x1234)]
      const resolved = ["@zorsh/effect", "@zorsh/effect/Borsh"].map((id) => import.meta.resolve(id))
      process.stdout.write(JSON.stringify({ bytes, resolved }))
    `
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: temp,
      encoding: "utf8",
    })
    const required = `
      const { Borsh } = require("@zorsh/effect")
      if (Borsh.toCodec !== require("@zorsh/effect/Borsh").toCodec) throw new Error("entry points differ")
      process.stdout.write(require.resolve("@zorsh/effect"))
    `
    expect(execFileSync(process.execPath, ["-e", required], { cwd: temp, encoding: "utf8" })).toBe(
      join(temp, "node_modules/@zorsh/effect/dist/index.js"),
    )
    const dist = pathToFileURL(join(temp, "node_modules/@zorsh/effect/dist")).href
    expect(JSON.parse(output)).toEqual({
      bytes: [52, 18],
      resolved: [`${dist}/index.js`, `${dist}/Borsh.js`],
    })
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}, 60000)

it("preserves packed declaration inference in NodeNext and Bundler consumers", () => {
  const temp = install()
  try {
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
      const files = execFileSync(
        "vp",
        ["exec", "tsc", "--listFiles", "-p", join(temp, "tsconfig.json")],
        { cwd: root, encoding: "utf8", timeout: 30000 },
      )
      for (const entry of ["index", "Borsh"])
        expect(files).toContain(join(temp, `node_modules/@zorsh/effect/dist/${entry}.d.ts`))
    }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}, 60000)
