import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import fc from "fast-check"
import { expect, it } from "vite-plus/test"
import { HarnessError, Oracle, assertProperty } from "./oracle.js"

it.each([
  ["timeout", /Oracle request timed out/],
  ["crash", /Oracle exited \(1\): oracle panic/],
  ["flood", /Oracle stdout exceeded 1 MiB/],
  ["stderr-flood", /Oracle stderr exceeded 64 KiB/],
  ["partial", /Partial oracle response at EOF/],
  ["transport", /Oracle infrastructure error:.*transport/],
  ["trailing", /Unsolicited oracle output/],
  ["nonzero", /Oracle exited \(2\)/],
  ["hang-close", /Oracle shutdown timed out/],
  ["bad-id", /Oracle response ID differs/],
  ["bad-hex", /Invalid oracle hex/],
  ["bad-shape", /Invalid oracle response fields/],
] as const)("fails closed and reaps the %s child", async (mode, expected) => {
  const client = new Oracle(
    process.execPath,
    [fileURLToPath(new URL("./child.ts", import.meta.url)), mode],
    500,
  )
  await assert.rejects(
    async () => {
      try {
        await client.request("u8", "encode", { value: "7" })
      } finally {
        await client.close()
      }
    },
    (error: unknown) => {
      assert.ok(error instanceof HarnessError)
      assert.match(`${error.message}\n${String(error.cause)}`, expected)
      return true
    },
  )
  expect(client.failure).toBeInstanceOf(HarnessError)
})
it("shrinks and replays an actual Rust byte mismatch", async () => {
  const oracle = new Oracle()
  const arbitrary = fc.integer({ min: 1, max: 65535 })
  const predicate = async (value: number, corrupt: boolean) => {
    const rust = await oracle.request("u16", "encode", { value: String(value) })
    assert.ok(rust.ok)
    const output = new Uint8Array(2)
    new DataView(output.buffer).setUint16(0, value, true)
    if (corrupt) output[0] = (output[0] ?? 0) ^ 1
    assert.equal(Buffer.from(output).toString("hex"), rust.hex)
  }
  try {
    const property = fc.asyncProperty(arbitrary, (value) => predicate(value, true))
    const result = await fc.check(property, { seed: 20261020, numRuns: 100 })
    assert.ok(result.failed)
    expect(result.numShrinks).toBeGreaterThan(0)
    expect(result.counterexample).toEqual([1])
    assert.ok(result.counterexamplePath !== null)
    const replay = await fc.check(property, {
      seed: result.seed,
      path: result.counterexamplePath,
      numRuns: 100,
    })
    expect(replay.counterexample).toEqual(result.counterexample)
    expect(replay.numShrinks).toBe(0)
    await assertProperty(arbitrary, (value) => predicate(value, false), {
      seed: result.seed,
      path: result.counterexamplePath,
      numRuns: 100,
    })
  } finally {
    await oracle.close()
  }
})
it("retains the real mismatch if the oracle fails during shrinking", async () => {
  const seen: number[] = []
  try {
    await assertProperty(
      fc.integer({ min: 0, max: 900 }).map((n) => (n === 0 ? 777 : 900)),
      async (input) => {
        seen.push(input)
        if (input === 777) throw new HarnessError("child crashed")
        assert.fail("real codec mismatch")
      },
      { seed: 42, numRuns: 1 },
    )
    assert.fail("expected a property failure")
  } catch (error) {
    assert.ok(error instanceof AggregateError)
    assert.match(String(error.errors[0]), /Counterexample: \[900\]/)
    assert.match(String(error.errors[1]), /777/)
    expect(seen).toEqual([900, 777])
  }
})
it("keeps the first infrastructure input without false shrinking", async () => {
  const seen: number[] = []
  await expect(
    assertProperty(
      fc.integer(),
      async (input) => {
        seen.push(input)
        throw new HarnessError("child crashed")
      },
      { seed: 42 },
    ),
  ).rejects.toBeInstanceOf(AggregateError)
  expect(seen).toHaveLength(1)
})
