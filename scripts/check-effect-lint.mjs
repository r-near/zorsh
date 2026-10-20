import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const artifacts = join(root, ".artifacts")
mkdirSync(artifacts, { recursive: true })
const temp = mkdtempSync(join(artifacts, "effect-lint-"))

const check = (name, source, diagnostic) => {
  writeFileSync(join(temp, "fixture.ts"), source)
  const result = spawnSync("vp", ["lint", "--no-ignore", "fixture.ts"], {
    cwd: temp,
    encoding: "utf8",
    timeout: 30_000,
    detached: process.platform !== "win32",
  })
  // A timeout must also stop the native linter descendants on our macOS/Linux runners.
  if (result.error?.code === "ETIMEDOUT" && process.platform !== "win32") {
    try {
      process.kill(-result.pid, "SIGKILL")
    } catch (error) {
      if (error.code !== "ESRCH") throw error
    }
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
  assert(!result.error, `${name}: ${result.error}\n${output}`)
  assert.equal(result.signal, null, `${name}: terminated by ${result.signal}\n${output}`)
  if (diagnostic) {
    assert.notEqual(result.status, 0, `${name}: invalid code unexpectedly passed\n${output}`)
    assert(output.includes(diagnostic), `${name}: missing ${diagnostic}\n${output}`)
    console.log(`${name}: rejected with ${diagnostic}`)
  } else {
    assert.equal(result.status, 0, `${name}: valid code failed\n${output}`)
    console.log(`${name}: passed`)
  }
}

try {
  // Reuse the real rules and options; only allow this explicit, normally ignored fixture.
  writeFileSync(
    join(temp, "vite.config.ts"),
    `import config from "../../vite.config.ts"
export default { ...config, lint: { ...config.lint, ignorePatterns: [] } }
`,
  )
  writeFileSync(
    join(temp, "tsconfig.json"),
    JSON.stringify({
      extends: "../../tsconfig.base.json",
      compilerOptions: { noEmit: true },
      files: ["fixture.ts"],
    }),
  )
  check(
    "Valid Effect",
    'import { Effect } from "effect"\n\nexport const program = Effect.log("lint smoke")\n',
  )
  check(
    "Floating Effect",
    'import { Effect } from "effect"\n\nEffect.log("lint smoke")\n',
    "effecttsgo(floating-effect)",
  )
  check("TypeScript error", "export const value: string = 1\n", "typescript(TS2322)")
  console.log(`Effect lint smoke passed: ${process.version} (${process.execPath})`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
