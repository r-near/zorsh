import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import fc from "fast-check"
import { it } from "vite-plus/test"
import { parseOptions, runSuite } from "./run.mjs"
import { checkProperty } from "./support/check-property.mjs"
import { OracleClient, HarnessError } from "./support/oracle-client.mjs"
import { primitives, utf8Frame, attempt, hex } from "./support/primitives.mjs"

const fixture = fileURLToPath(new URL("./support/toy-child.mjs", import.meta.url))
const dead = (pid) => assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })

it("preserves the crashing input and replays it against a fresh child without false shrinking", async () => {
  const arbitrary = fc.constantFrom("1", "5", "777", "900")
  const check = async (parameters) => {
    const client = new OracleClient(process.execPath, [fixture, "crash-on-777"], {
      rssLimitBytes: null,
    })
    const seen = []
    try {
      const result = await checkProperty(
        arbitrary,
        async (value) => {
          seen.push(value)
          await client.request("u16", "encode", { value })
        },
        parameters,
      )
      return { result, seen, requests: client.requests }
    } finally {
      await client.close()
      dead(client.pid)
    }
  }
  const first = await check({ seed: 3, numRuns: 50 })
  assert.equal(first.result.classification, "infrastructure")
  assert.equal(first.result.numShrinks, 0)
  assert.deepEqual(first.result.counterexample, ["777"])
  assert.equal(first.result.infrastructureFailure.input, "777")
  assert.equal(first.result.errorInstance, first.result.infrastructureFailure.error)
  assert.ok(first.result.errorInstance instanceof HarnessError)
  assert.equal(first.seen.at(-1), "777")
  assert.equal(first.seen.filter((value) => value === "777").length, 1)
  assert.equal(first.requests, first.seen.length)
  const replay = await check({
    seed: first.result.seed,
    numRuns: 50,
    path: first.result.counterexamplePath,
  })
  assert.deepEqual(replay.seen, ["777"])
  assert.deepEqual(replay.result.counterexample, first.result.counterexample)
  assert.equal(replay.result.numShrinks, 0)
  assert.ok(["exit", "eof"].includes(replay.result.errorInstance.kind))
  assert.equal(replay.result.infrastructureFailure.path, first.result.counterexamplePath)
  const client = new OracleClient(process.execPath, [fixture, "crash-on-777"], {
    rssLimitBytes: null,
  })
  try {
    assert.equal((await client.request("u16", "encode", { value: "1" })).ok, true)
    assert.equal(client.failure, undefined)
  } finally {
    await client.close()
    dead(client.pid)
  }
})

it("records and replays a concrete exact-case mismatch with artifact identities", async () => {
  mkdirSync(parseOptions([]).output, { recursive: true })
  const output = mkdtempSync(resolve(parseOptions([]).output, "expected-exact-mismatch-"))
  try {
    const args = [
      "--exact-case",
      "u16-value-0",
      "--mutation",
      "encoded-bitflip",
      "--output",
      output,
    ]
    await assert.rejects(runSuite(parseOptions(args)), /Exact differential case failed/)
    const file = readdirSync(output).find((name) => name.startsWith("failure-"))
    const failure = JSON.parse(readFileSync(resolve(output, file)))
    assert.equal(failure.classification, "codec_mismatch")
    assert.equal(failure.exactCase.id, "u16-value-0")
    assert.equal(failure.exactCase.value, "0")
    assert.equal(failure.error.name, "AssertionError")
    assert.match(failure.oracle.sha256, /^[a-f0-9]{64}$/)
    assert.ok(failure.codecEntry.files.length > 0)
    assert.equal(failure.versions.effect, "4.0.5")
    assert.ok(failure.replayArgs.includes("--exact-case"))
    assert.ok(!failure.replayArgs.includes("--path"))
    await assert.rejects(
      runSuite(parseOptions([...args.slice(0, -2), "--output", resolve(output, "replay")])),
      /Exact differential case failed/,
    )
    const repaired = await runSuite(
      parseOptions(["--exact-case", failure.exactCase.id, "--output", resolve(output, "repaired")]),
    )
    assert.equal(repaired.status, "passed")
    assert.equal(repaired.deterministicCases, 1)
    assert.deepEqual(repaired.properties, [])
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
})

it("attributes prefix preparation failure to the named input and exact replay", async () => {
  const output = mkdtempSync(resolve(parseOptions([]).output, "expected-prefix-failure-"))
  try {
    // An existing, non-executable file causes a real spawn failure at the first
    // preparation request, before any prefix bytes can be produced.
    await assert.rejects(
      runSuite(
        parseOptions(["--exact-case", "u16-prefix-0", "--oracle", fixture, "--output", output]),
      ),
    )
    const file = readdirSync(output).find((name) => name.startsWith("failure-"))
    const failure = JSON.parse(readFileSync(resolve(output, file)))
    assert.equal(failure.classification, "infrastructure")
    assert.equal(failure.exactCase.id, "u16-prefix-0")
    assert.equal(failure.exactCase.value, "0")
    assert.equal(failure.exactCase.phase, "prepare-prefix")
    assert.equal(failure.error.kind, "spawn")
    assert.ok(failure.replayArgs.includes("u16-prefix-0"))
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
})

it("uses repository-relative defaults and retains caller-relative overrides", () => {
  const defaults = parseOptions([])
  const root = fileURLToPath(new URL("../../../../", import.meta.url))
  assert.equal(defaults.oracle, resolve(root, "rust/borsh-oracle/target/debug/zorsh-borsh-oracle"))
  assert.equal(defaults.output, resolve(root, ".artifacts/primitive-differential"))
  assert.equal(parseOptions(["--oracle", "local-bin"]).oracle, resolve("local-bin"))
})

it("reports an actionable missing-oracle prerequisite", async () => {
  await assert.rejects(
    runSuite(parseOptions(["--oracle", "missing-oracle-executable"])),
    /Missing Rust oracle:.*vp run test-effect-differential/,
  )
})

it("rejects negative zero from every number-valued integer decoder", () => {
  for (const id of ["u8", "u16", "u32", "i8", "i16", "i32"]) {
    const entry = primitives.find((item) => item.id === id)
    assert.throws(() => entry.normalize(-0), /negative zero/)
    assert.equal(entry.normalize(entry.decode(new Uint8Array(entry.width))), "0")
  }
})

it("compares valid UTF-8 and one-byte mutations through both real decoders", async () => {
  const entry = primitives.find((item) => item.id === "string")
  const oracle = new OracleClient(parseOptions([]).oracle)
  try {
    assert.equal(hex(utf8Frame("é", false)), "02000000c3a9")
    assert.equal(hex(utf8Frame("é", true)), "03000000c3a980")
    for (const value of ["", "\uFEFF", "é", "😀", "\u{10ffff}", "a\0e\u0301"]) {
      for (const invalid of [false, true]) {
        const raw = utf8Frame(value, invalid)
        const ts = attempt(() => entry.decode(raw))
        const rust = await oracle.request("string", "decode", { hex: hex(raw) })
        assert.equal(ts.ok, !invalid)
        assert.equal(rust.ok, !invalid)
        if (!invalid) {
          assert.equal(ts.value, value)
          assert.equal(rust.value, value)
        }
      }
    }
  } finally {
    await oracle.close()
    dead(oracle.pid)
  }
})
