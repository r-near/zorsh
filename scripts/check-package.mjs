import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, isAbsolute, join, posix, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const expected = JSON.parse(readFileSync(join(root, "packages/zorsh/package.json"), "utf8"))
const archiveName = `${expected.name.replace("@", "").replace("/", "-")}-${expected.version}.tgz`
const archive = resolve(root, process.argv[2] ?? join(".artifacts", archiveName))
const baseline = process.argv.includes("--baseline")
const run = (args, cwd) => execFileSync("vp", args, { cwd, stdio: "inherit" })
const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n")
for (const entry of entries) {
  assert(!isAbsolute(entry) && !entry.split("/").includes(".."), `Unsafe archive path: ${entry}`)
  assert(
    /^package\/(?:package\.json|LICENSE|README\.md|dist\/src\/[^/]+\.(?:js|d\.ts|js\.map))$/.test(
      entry,
    ),
    `Unexpected shipped file: ${entry}`,
  )
}
for (const module of ["index", "schema", "registry", "binary-io", "types"]) {
  for (const extension of ["js", "d.ts"]) {
    assert(
      entries.includes(`package/dist/src/${module}.${extension}`),
      `Missing ${module}.${extension}`,
    )
  }
}
for (const file of ["package.json", "LICENSE", "README.md"]) {
  assert(entries.includes(`package/${file}`), `Missing ${file}`)
}
// Check references in the actual shipped files, including declaration output.
for (const entry of entries.filter((file) => /\.(?:js|d\.ts)$/.test(file))) {
  const content = execFileSync("tar", ["-xOzf", archive, entry], { encoding: "utf8" })
  for (const [, sourceMap] of content.matchAll(/^\/\/# sourceMappingURL=(.+)$/gm)) {
    const target = posix.join(posix.dirname(entry), sourceMap.trim())
    assert(entries.includes(target), `Dangling source map in ${entry}: ${sourceMap}`)
  }
}
const manifest = JSON.parse(execFileSync("tar", ["-xOzf", archive, "package/package.json"]))
assert.equal(manifest.name, expected.name)
assert.equal(manifest.version, expected.version)
assert.equal(manifest.main, "dist/src/index.js")
assert.equal(manifest.types, "dist/src/index.d.ts")
assert.deepEqual(manifest.files, ["dist/src"])
assert.equal(manifest.exports, undefined)
assert.equal(manifest.private, undefined)
if (!baseline) {
  assert.equal(manifest.type, "commonjs")
  assert.equal(manifest.license, "MIT")
  assert.equal(manifest.repository.directory, "packages/zorsh")
}

// A nested, independent workspace prevents pnpm from linking the repository package.
const artifacts = join(root, ".artifacts")
mkdirSync(artifacts, { recursive: true })
const temp = mkdtempSync(join(artifacts, "consumer-"))
try {
  writeFileSync(
    join(temp, "package.json"),
    JSON.stringify({
      name: "zorsh-tarball-consumer",
      private: true,
      packageManager: "pnpm@10.33.0",
      dependencies: { "@zorsh/zorsh": `file:${archive}`, typescript: "7.0.2" },
    }),
  )
  writeFileSync(join(temp, "pnpm-workspace.yaml"), "packages: []\n")
  writeFileSync(join(temp, ".node-version"), "24.22.0\n")
  run(["install", "--ignore-scripts"], temp)
  const installed = realpathSync(join(temp, "node_modules/@zorsh/zorsh"))
  const modules = realpathSync(join(temp, "node_modules"))
  assert(installed.startsWith(`${modules}${sep}`), "Consumer resolved a workspace package")
  assert(statSync(join(installed, "dist/src/index.js")).isFile())
  const runtime = `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { b as named, Schema } from "@zorsh/zorsh";
import { BinaryReader } from "@zorsh/zorsh/dist/src/binary-io.js";
const require = createRequire(import.meta.url);
const { b } = require("@zorsh/zorsh");
assert.equal(named, b);
assert.equal(require("@zorsh/zorsh/dist/src/schema").Schema, Schema);
for (const name of ["index", "schema", "registry", "binary-io", "types"]) {
  require("@zorsh/zorsh/dist/src/" + name);
  await import("@zorsh/zorsh/dist/src/" + name + ".js");
}
assert(b.u16() instanceof Schema);
assert.deepEqual([...b.u16().serialize(0x1234)], [0x34, 0x12]);
assert.deepEqual([...b.string().serialize("A")], [1, 0, 0, 0, 65]);
assert.deepEqual([...b.bytes().serialize(new Uint8Array([7, 8]))], [2, 0, 0, 0, 7, 8]);
assert.deepEqual([...b.bytes(2).serialize(new Uint8Array([7, 8]))], [7, 8]);
const schema = b.struct({ id: b.u16(), flags: b.vec(b.bool()), payload: b.bytes(2) });
const value = { id: 0x1234, flags: [true, false], payload: new Uint8Array([7, 8]) };
const golden = new Uint8Array([52, 18, 2, 0, 0, 0, 1, 0, 7, 8]);
assert.deepEqual(schema.serialize(value), golden);
assert.deepEqual(schema.deserialize(golden), value);
assert.equal(new BinaryReader(new Uint8Array([52, 18])).readUint16(), 0x1234);
console.log("Installed runtime: " + process.version + " (" + process.execPath + ")");
console.log("Installed tarball: CommonJS, ESM named/deep imports and golden bytes passed");
`
  writeFileSync(join(temp, "runtime.mjs"), runtime)
  run(["exec", "node", "runtime.mjs"], temp)
  const types = `
import { b, Schema, type EnumLike } from "@zorsh/zorsh";
import { BinaryReader } from "@zorsh/zorsh/dist/src/binary-io.js";
import type { TypeOf, VecType } from "@zorsh/zorsh/dist/src/types.js";
const schema = b.struct({
  id: b.u64(), payload: b.bytes(), fixed: b.bytes(2),
  items: b.vec(b.struct({ name: b.string(), score: b.option(b.i32()) })),
  labels: b.hashMap(b.string(), b.u16()),
  event: b.enum({ Empty: b.unit(), Data: b.string() }),
});
type Value = b.infer<typeof schema>;
const value: Value = {
  id: 1n, payload: new Uint8Array(), fixed: new Uint8Array([1, 2]),
  items: [{ name: "x", score: null }], labels: new Map([["x", 2]]), event: { Data: "ok" },
};
const publicSchema: Schema<Value> = schema;
const bytes: Uint8Array = publicSchema.serialize(value);
const decoded: Value = publicSchema.deserialize(bytes);
const same: TypeOf<typeof schema> = decoded;
const vector: VecType<typeof schema> = [same];
const enumLike: EnumLike = { A: "a" };
const variant: "a" = b.nativeEnum({ A: "a" } as const).deserialize(new Uint8Array([0]));
const reader: BinaryReader = new BinaryReader(bytes);
// @ts-expect-error b.infer must reject incorrect field types
const wrong: Value = { ...value, id: "1" };
// @ts-expect-error bytes inference must remain Uint8Array
const wrongBytes: b.infer<ReturnType<typeof b.bytes>> = [1, 2];
void [vector, enumLike, variant, reader, wrong, wrongBytes];
`
  for (const extension of ["cts", "mts", "ts"]) {
    writeFileSync(join(temp, `consumer.${extension}`), types)
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
    run(["exec", "tsc", "-p", "tsconfig.json"], temp)
  }
  console.log(`Checker runtime: ${process.version} (${process.execPath})`)
  console.log(`Tarball consumer checks passed: ${archive}`)
  console.log(`SHA256 ${createHash("sha256").update(readFileSync(archive)).digest("hex")}`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
