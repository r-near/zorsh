import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, posix, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const archive = resolve(root, process.argv[2] ?? ".artifacts/zorsh-effect-0.0.0.tgz")
const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n")
const readEntry = (entry) => execFileSync("tar", ["-xOzf", archive, entry], { encoding: "utf8" })
for (const entry of entries) {
  assert(!isAbsolute(entry) && !entry.split("/").includes(".."), `Unsafe archive path: ${entry}`)
  assert(
    /^package\/(?:package\.json|README\.md|LICENSE|dist\/[^/]+\.(?:js|d\.ts|js\.map|d\.ts\.map))$/.test(
      entry,
    ),
    `Unexpected shipped file: ${entry}`,
  )
  if (/\.(?:js|d\.ts)$/.test(entry)) {
    const source = readEntry(entry)
    assert(
      !source.includes('from "node:') && !source.includes('require("node:'),
      `Node builtin in ${entry}`,
    )
    for (const [, map] of source.matchAll(/^\/\/# sourceMappingURL=(.+)$/gm)) {
      assert(
        entries.includes(posix.join(posix.dirname(entry), map.trim())),
        `Dangling source map in ${entry}`,
      )
    }
  }
}
const manifest = JSON.parse(readEntry("package/package.json"))
assert.equal(manifest.name, "@zorsh/effect")
assert.equal(manifest.version, "0.0.0")
assert.equal(manifest.private, true)
assert.equal(manifest.type, "module")
assert.equal(manifest.peerDependencies.effect, "^4.0.5")
for (const name of ["index", "Borsh"]) {
  assert(entries.includes(`package/dist/${name}.js`))
  assert(entries.includes(`package/dist/${name}.d.ts`))
}

const artifacts = join(root, ".artifacts")
mkdirSync(artifacts, { recursive: true })
const temp = mkdtempSync(join(artifacts, "effect-consumer-"))
const run = (args) => execFileSync("vp", args, { cwd: temp, stdio: "inherit" })
try {
  writeFileSync(
    join(temp, "package.json"),
    JSON.stringify({
      name: "effect-tarball-consumer",
      private: true,
      type: "module",
      packageManager: "pnpm@10.33.0",
      dependencies: { "@zorsh/effect": `file:${archive}`, effect: "4.0.5", typescript: "7.0.2" },
    }),
  )
  writeFileSync(join(temp, "pnpm-workspace.yaml"), "packages: []\n")
  run(["install", "--ignore-scripts"])
  const installed = realpathSync(join(temp, "node_modules/@zorsh/effect"))
  assert(
    installed.startsWith(`${realpathSync(join(temp, "node_modules"))}${sep}`),
    "Resolved workspace source",
  )
  const runtime = `
import assert from "node:assert/strict";
import { Borsh } from "@zorsh/effect";
import * as Direct from "@zorsh/effect/Borsh";
import { Schema, SchemaTransformation } from "effect";
assert.equal(Borsh.toCodec, Direct.toCodec);
assert.equal(Borsh.U8, Direct.U8);
const schema = Borsh.U128.pipe(Schema.decodeTo(Schema.Struct({amount: Schema.String}),
  SchemaTransformation.transform({decode: n => ({amount: String(n)}), encode: v => BigInt(v.amount)})));
const codec = Borsh.toCodec(schema);
const bytes = new Uint8Array([0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0]);
assert.deepEqual(Schema.encodeSync(codec)({amount: "18446744073709551616"}), bytes);
assert.deepEqual(Schema.decodeSync(codec)(bytes), {amount: "18446744073709551616"});
assert.deepEqual(Schema.encodeSync(Borsh.toCodec(Schema.String))("A"), new Uint8Array([1,0,0,0,65]));
console.log("Installed Effect tarball: exports, native transformation and Borsh goldens passed");
`
  writeFileSync(join(temp, "runtime.mjs"), runtime)
  run(["exec", "node", "runtime.mjs"])
  const types = `
import { Borsh } from "@zorsh/effect";
import { U16 } from "@zorsh/effect/Borsh";
import { Context, Effect, Schema, SchemaTransformation } from "effect";
class Decode extends Context.Service<Decode, {readonly prefix: string}>()("Decode") {}
class Encode extends Context.Service<Encode, {readonly prefix: string}>()("Encode") {}
const schema = U16.pipe(Schema.decodeTo(Schema.String, SchemaTransformation.transformEffect({
  decode: n => Effect.map(Decode, s => s.prefix + n),
  encode: value => Effect.map(Encode, s => Number(value.slice(s.prefix.length)))
})));
const codec = Borsh.toCodec(schema);
const inferred: Schema.Codec<string, Uint8Array, Decode, Encode> = codec;
const original: typeof codec = inferred;
const decoded: Effect.Effect<string, Schema.SchemaError, Decode> = Schema.decodeEffect(codec)(new Uint8Array([1,0]));
const encoded: Effect.Effect<Uint8Array, Schema.SchemaError, Encode> = Schema.encodeEffect(codec)("v1");
const branded = Borsh.U8.pipe(Schema.brand("Id")).annotate({title: "Id"}).check(Schema.isGreaterThan(0));
const id: typeof branded.Type = Schema.decodeSync(Borsh.toCodec(branded))(new Uint8Array([1]));
// @ts-expect-error the native decoded type remains string
const wrong: typeof codec.Type = 1;
// @ts-expect-error bytes remain Uint8Array
const wrongBytes: typeof codec.Encoded = [1];
// @ts-expect-error the original decoding service is still required
const missingService: Effect.Effect<string, Schema.SchemaError> = decoded;
void [original, encoded, id, wrong, wrongBytes, missingService];
`
  writeFileSync(join(temp, "consumer.ts"), types)
  const examples = [...readEntry("package/README.md").matchAll(/```ts\n([\s\S]*?)```/g)]
  assert.equal(examples.length, 1, "Expected the documented native codec example")
  writeFileSync(join(temp, "docs-example.ts"), examples.map((match) => match[1]).join("\n"))
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
        files: ["consumer.ts", "docs-example.ts"],
      }),
    )
    run(["exec", "tsc", "-p", "tsconfig.json"])
  }
  writeFileSync(
    join(temp, "browser.ts"),
    `
import { Borsh } from "@zorsh/effect";
import { Schema } from "effect";
export const encoded = Schema.encodeSync(Borsh.toCodec(Borsh.U16))(4660);
export const decoded = Schema.decodeSync(Borsh.toCodec(Schema.String))(new Uint8Array([1,0,0,0,65]));
`,
  )
  writeFileSync(
    join(temp, "vite.config.ts"),
    `
import { defineConfig } from "vite-plus";
export default defineConfig({pack: {
  entry: ["browser.ts"], outDir: "browser-dist", platform: "browser", format: ["esm"],
  deps: {alwaysBundle: ["@zorsh/effect", /^effect(?:\\/|$)/]}, exports: false,
}});
`,
  )
  run(["pack"])
  const bundle = readFileSync(join(temp, "browser-dist/browser.js"), "utf8")
  assert(!/^import\b/m.test(bundle), "Browser bundle retained external runtime dependencies")
  writeFileSync(
    join(temp, "browser-check.mjs"),
    `
import assert from "node:assert/strict";
import {encoded, decoded} from "./browser-dist/browser.js";
assert.deepEqual(encoded, new Uint8Array([52,18]));
assert.equal(decoded, "A");
`,
  )
  run(["exec", "node", "browser-check.mjs"])
  console.log(
    "Installed Effect tarball: NodeNext/Bundler inference and browser bundle smoke passed",
  )
  console.log(`Checker runtime: ${process.version} (${process.execPath})`)
  console.log(`SHA256 ${createHash("sha256").update(readFileSync(archive)).digest("hex")}`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
