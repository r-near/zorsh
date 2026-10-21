import assert from "node:assert/strict"
import fc from "fast-check"
import { afterAll, beforeAll, describe, it } from "vite-plus/test"
import { Oracle, assertProperty } from "./oracle.js"
import {
  attempt,
  bytes,
  floatFromBits,
  hex,
  normalizeOracle,
  primitives,
  rawArbitrary,
  utf8Frame,
  type Primitive,
} from "./primitives.js"

let oracle: Oracle
beforeAll(() => {
  oracle = new Oracle()
})
afterAll(async () => {
  await oracle.close()
})
const parameters = {
  numRuns: Number(process.env.ZORSH_DIFFERENTIAL_RUNS ?? 1000),
  seed: Number(process.env.ZORSH_DIFFERENTIAL_SEED ?? 20261020),
  ...(process.env.ZORSH_DIFFERENTIAL_PATH ? { path: process.env.ZORSH_DIFFERENTIAL_PATH } : {}),
}
assert.ok(
  Number.isSafeInteger(parameters.numRuns) &&
    parameters.numRuns >= 1 &&
    parameters.numRuns <= 100000,
)
assert.ok(
  Number.isInteger(parameters.seed) &&
    parameters.seed >= -2147483648 &&
    parameters.seed <= 2147483647,
)
function offsetView(input: Uint8Array) {
  const backing = new Uint8Array(input.length + 7).fill(0xa5)
  backing.set(input, 3)
  return { backing, view: backing.subarray(3, input.length + 3) }
}
async function decodeParity(entry: Primitive, raw: Uint8Array) {
  const { backing, view } = offsetView(raw)
  const before = backing.slice()
  const ts = attempt(() => entry.decode(view))
  assert.deepEqual(backing, before, "decode mutated input")
  const rust = await oracle.request(entry.id, "decode", { hex: hex(raw) })
  assert.equal(ts.ok, rust.ok, "raw acceptance differs")
  if (!ts.ok || !rust.ok) return false
  assert.deepEqual(
    entry.normalize(ts.value),
    normalizeOracle(entry, rust.value),
    "decoded values differ",
  )
  assert.equal(hex(entry.encode(ts.value)), hex(raw), "TS accepted noncanonical bytes")
  const canonical = await oracle.request(entry.id, "encode", { value: rust.value })
  assert.ok(canonical.ok)
  assert.equal(canonical.hex, hex(raw), "Rust accepted noncanonical bytes")
  if (ts.value instanceof Uint8Array) {
    const owned = ts.value.slice()
    backing.fill(0)
    assert.deepEqual(ts.value, owned, "decoded output aliases input")
  }
  return true
}
async function valueParity(
  entry: Primitive,
  transport: unknown,
  selector = 0,
  suffix = Uint8Array.of(0x97),
) {
  let value = entry.fromTransport(transport)
  const offset = value instanceof Uint8Array ? offsetView(value) : undefined
  if (offset) value = offset.view
  const before = offset?.backing.slice()
  const ts = attempt(() => entry.encode(value))
  if (offset) assert.deepEqual(offset.backing, before, "encode mutated input")
  const rust = await oracle.request(entry.id, "encode", { value: transport })
  assert.equal(ts.ok, rust.ok, "encode acceptance differs")
  if (!ts.ok || !rust.ok) {
    assert.ok(entry.id.startsWith("f") && typeof value === "number" && Number.isNaN(value))
    return
  }
  assert.equal(hex(ts.value), rust.hex, "independently encoded bytes differ")
  const expected = entry.normalize(value)
  assert.deepEqual(normalizeOracle(entry, rust.value), expected)
  const rustDecoded = await oracle.request(entry.id, "decode", { hex: hex(ts.value) })
  assert.ok(rustDecoded.ok)
  assert.deepEqual(
    normalizeOracle(entry, rustDecoded.value),
    expected,
    "Rust decode changed TS value",
  )
  const rustBytes = bytes(rust.hex)
  const decoded = entry.decode(rustBytes)
  assert.deepEqual(entry.normalize(decoded), expected, "TS decode changed Rust value")
  assert.equal(hex(entry.encode(decoded)), rust.hex)
  const suffixed = new Uint8Array([...rustBytes, ...suffix])
  assert.equal(attempt(() => entry.decode(suffixed)).ok, false, "accepted suffix")
  if (suffixed.length <= 65536)
    assert.deepEqual(await oracle.request(entry.id, "decode", { hex: hex(suffixed) }), {
      ok: false,
    })
  if (rustBytes.length) {
    const prefix = rustBytes.subarray(0, selector % rustBytes.length)
    assert.equal(attempt(() => entry.decode(prefix)).ok, false, "accepted proper prefix")
    assert.deepEqual(await oracle.request(entry.id, "decode", { hex: hex(prefix) }), { ok: false })
  }
  assert.equal(hex(entry.encode(value)), rust.hex, "failed operation corrupted encoder")
  assert.deepEqual(
    entry.normalize(entry.decode(rustBytes)),
    expected,
    "failed operation corrupted decoder",
  )
  if (offset) {
    const owned = ts.value.slice()
    offset.backing.fill(0)
    assert.deepEqual(ts.value, owned, "encoded output aliases input")
  }
  if (decoded instanceof Uint8Array) {
    const owned = decoded.slice()
    rustBytes.fill(0)
    assert.deepEqual(decoded, owned, "decoded output aliases input")
    decoded.fill(0)
    assert.deepEqual(entry.normalize(entry.decode(ts.value)), expected)
  }
}

describe.each(primitives)("borsh-rs $id", (entry) => {
  it("values", async () => {
    await assertProperty(
      fc.tuple(entry.arbitrary, fc.nat(65535), fc.uint8Array({ minLength: 1, maxLength: 8 })),
      ([value, selector, suffix]) => valueParity(entry, value, selector, suffix),
      parameters,
    )
  }, 120000)
  it("raw bytes", async () => {
    await assertProperty(rawArbitrary(entry), (raw) => decodeParity(entry, raw), parameters)
  }, 120000)
  it("edges and every proper prefix", async () => {
    for (const value of entry.examples) await valueParity(entry, value)
    const value =
      entry.id === "string" ? "é😀" : entry.id === "bytes" ? "000102ff" : entry.examples[0]
    const encoded = await oracle.request(entry.id, "encode", { value })
    assert.ok(encoded.ok)
    const raw = bytes(encoded.hex)
    for (let cut = 0; cut < raw.length; cut++)
      assert.equal(await decodeParity(entry, raw.subarray(0, cut)), false)
  })
})

it("rejects malformed tags, NaNs, UTF-8 and length headers", async () => {
  for (const entry of primitives) {
    const invalid =
      entry.id === "bool" ? [Uint8Array.of(2), Uint8Array.of(128), Uint8Array.of(255)] : []
    if (entry.id.startsWith("f"))
      for (const value of entry.examples) {
        assert.ok(
          value !== null &&
            typeof value === "object" &&
            "bits" in value &&
            typeof value.bits === "string",
        )
        assert.equal(
          await decodeParity(entry, bytes(value.bits).reverse()),
          !Number.isNaN(floatFromBits(value, entry.width ?? 0)),
        )
      }
    if (entry.id === "string") {
      for (const payload of [
        [0xc0, 0xaf],
        [0xed, 0xa0, 0x80],
        [0xf4, 0x90, 0x80, 0x80],
        [0x80],
        [0xe2, 0x82],
      ])
        invalid.push(Uint8Array.of(payload.length, 0, 0, 0, ...payload))
      for (const value of ["", "\uFEFF", "é", "😀", "\u{10ffff}", "a\0e\u0301"])
        for (const malformed of [false, true])
          assert.equal(await decodeParity(entry, utf8Frame(value, malformed)), !malformed)
      for (const value of ["\uD800", "a\uDC00", "\uD800x", "\uD800\uD800"])
        assert.equal(attempt(() => entry.encode(value)).ok, false)
    }
    if (entry.id === "string" || entry.id === "bytes")
      invalid.push(Uint8Array.of(255, 255, 255, 255))
    for (const raw of invalid) assert.equal(await decodeParity(entry, raw), false)
  }
})
it("compares the 64 KiB envelope", async () => {
  for (const entry of primitives.filter((p) => p.id === "string" || p.id === "bytes")) {
    const value = entry.id === "string" ? "x".repeat(65532) : "7f".repeat(65532)
    await valueParity(entry, value)
    const encoded = await oracle.request(entry.id, "encode", { value })
    assert.ok(encoded.ok)
    assert.equal(await decodeParity(entry, bytes(encoded.hex)), true)
  }
})
