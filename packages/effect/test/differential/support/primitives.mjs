import assert from "node:assert/strict"
import { Schema } from "effect"
import fc from "fast-check"
import { Borsh } from "@zorsh/effect"

export const hex = (bytes) =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex")
export const bytes = (value) => Uint8Array.from(Buffer.from(value, "hex"))
export const same = (actual, expected, context) => assert.deepStrictEqual(actual, expected, context)
const constantsAnd = (values, arbitrary) => fc.oneof(fc.constantFrom(...values), arbitrary)

function floatFromBits(value, width) {
  const buffer = new ArrayBuffer(width)
  const view = new DataView(buffer)
  if (width === 4) {
    view.setUint32(0, Number(BigInt(`0x${value.bits}`)))
    return view.getFloat32(0)
  }
  view.setBigUint64(0, BigInt(`0x${value.bits}`))
  return view.getFloat64(0)
}
function floatBits(value, width) {
  const buffer = new ArrayBuffer(width)
  const view = new DataView(buffer)
  if (width === 4) {
    view.setFloat32(0, value)
    return { bits: view.getUint32(0).toString(16).padStart(8, "0") }
  }
  view.setFloat64(0, value)
  return { bits: view.getBigUint64(0).toString(16).padStart(16, "0") }
}
function spec(id, schema, arbitrary, fromTransport, normalize, width) {
  const codec = Borsh.toCodec(schema, { maxBytes: 65536 })
  return {
    id,
    arbitrary,
    fromTransport,
    normalize,
    width,
    encode: Schema.encodeSync(codec),
    decode: Schema.decodeSync(codec),
  }
}
export const primitives = [
  spec(
    "bool",
    Schema.Boolean,
    fc.boolean(),
    (v) => v,
    (v) => {
      assert.equal(typeof v, "boolean")
      return v
    },
    1,
  ),
]
for (const [id, bits, signed, schema] of [
  ["u8", 8, false, Borsh.U8],
  ["u16", 16, false, Borsh.U16],
  ["u32", 32, false, Borsh.U32],
  ["i8", 8, true, Borsh.I8],
  ["i16", 16, true, Borsh.I16],
  ["i32", 32, true, Borsh.I32],
  ["u64", 64, false, Borsh.U64],
  ["u128", 128, false, Borsh.U128],
  ["i64", 64, true, Borsh.I64],
  ["i128", 128, true, Borsh.I128],
]) {
  const min = signed ? -(1n << BigInt(bits - 1)) : 0n
  const max = (1n << BigInt(signed ? bits - 1 : bits)) - 1n
  const edges = new Set([min, min + 1n, max - 1n, max, 0n, 1n])
  for (let bit = 8; bit < bits; bit += 8) {
    const carry = 1n << BigInt(bit)
    for (const value of [carry - 1n, carry, carry + 1n, -carry - 1n, -carry, -carry + 1n])
      if (value >= min && value <= max) edges.add(value)
  }
  if (signed) edges.add(-1n)
  const convert = bits <= 32 ? (v) => Number(v) : (v) => BigInt(v)
  const normalize =
    bits <= 32
      ? (v) => {
          assert.equal(typeof v, "number")
          assert.ok(Number.isSafeInteger(v))
          assert.ok(!Object.is(v, -0), "integer decoder returned negative zero")
          return String(v)
        }
      : (v) => {
          assert.equal(typeof v, "bigint")
          return v.toString()
        }
  const arbitrary = constantsAnd([...edges], fc.bigInt({ min, max })).map(String)
  const entry = spec(id, schema, arbitrary, convert, normalize, bits / 8)
  entry.examples = [...edges].map(String)
  primitives.push(entry)
}
for (const [id, width, schema, patterns] of [
  [
    "f32",
    4,
    Borsh.F32,
    [
      "00000000",
      "80000000",
      "00000001",
      "007fffff",
      "00800000",
      "7f7fffff",
      "7f800000",
      "ff800000",
      "7f800001",
      "7fc00000",
      "ffffffff",
    ],
  ],
  [
    "f64",
    8,
    Borsh.F64,
    [
      "0000000000000000",
      "8000000000000000",
      "0000000000000001",
      "000fffffffffffff",
      "0010000000000000",
      "7fefffffffffffff",
      "7ff0000000000000",
      "fff0000000000000",
      "7ff0000000000001",
      "7ff8000000000000",
      "ffffffffffffffff",
    ],
  ],
]) {
  const arbitrary = constantsAnd(
    patterns.map((bits) => ({ bits })),
    fc
      .bigInt({ min: 0n, max: (1n << BigInt(width * 8)) - 1n })
      .map((v) => ({ bits: v.toString(16).padStart(width * 2, "0") })),
  )
  const entry = spec(
    id,
    schema,
    arbitrary,
    (v) => {
      const number = floatFromBits(v, width)
      if (width === 4 && !Number.isNaN(number)) assert.ok(Object.is(Math.fround(number), number))
      return number
    },
    (v) => {
      assert.equal(typeof v, "number")
      return floatBits(v, width)
    },
    width,
  )
  entry.examples = patterns.map((bits) => ({ bits }))
  primitives.push(entry)
}
// Unicode scalar generation is independent of TextEncoder and the codec. This
// includes BOM, NUL and supplementary planes without manufacturing surrogates.
const scalar = fc.oneof(
  fc.integer({ min: 0, max: 0xd7ff }),
  fc.integer({ min: 0xe000, max: 0x10ffff }),
)
const stringArbitrary = constantsAnd(
  ["", "\uFEFF", "\uFEFFa", "\0", "é😀", "e\u0301", "\r\n"],
  fc.array(scalar, { maxLength: 64 }).map((values) => String.fromCodePoint(...values)),
)
const stringSpec = spec(
  "string",
  Schema.String,
  stringArbitrary,
  (v) => v,
  (v) => {
    assert.equal(typeof v, "string")
    return v
  },
)
stringSpec.examples = ["", "\uFEFF", "\uFEFFa", "\0", "é😀", "e\u0301", "\r\n"]
primitives.push(stringSpec)
for (const [id, schema, fixed] of [
  ["bytes", Borsh.Bytes, undefined],
  ["bytes32", Borsh.fixedBytes(32), 32],
  ["bytes0", Borsh.fixedBytes(0), 0],
]) {
  const arbitrary = fc.uint8Array({ minLength: fixed ?? 0, maxLength: fixed ?? 128 }).map(hex)
  const entry = spec(
    id,
    schema,
    arbitrary,
    bytes,
    (v) => {
      assert.ok(v instanceof Uint8Array)
      return hex(v)
    },
    fixed,
  )
  entry.examples =
    fixed === undefined ? ["", "00", "ff", "000102ff"] : ["00".repeat(fixed), "ff".repeat(fixed)]
  primitives.push(entry)
}
primitives.push(
  spec(
    "unit",
    Borsh.Unit,
    fc.constant(null),
    () => [],
    (v) => {
      same(v, [])
      return null
    },
    0,
  ),
)

export function normalizeOracle(entry, value) {
  switch (entry.id) {
    case "bool":
      assert.equal(typeof value, "boolean")
      return value
    case "unit":
      assert.equal(value, null)
      return value
    case "string":
      assert.equal(typeof value, "string")
      assert.ok(value.isWellFormed())
      return value
    case "bytes":
    case "bytes32":
    case "bytes0":
      assert.equal(typeof value, "string")
      assert.match(value, /^(?:[0-9a-f]{2})*$/)
      if (entry.id === "bytes32") assert.equal(value.length, 64)
      if (entry.id === "bytes0") assert.equal(value.length, 0)
      return value
    case "f32":
    case "f64":
      same(Object.keys(value), ["bits"])
      assert.match(value.bits, entry.id === "f32" ? /^[0-9a-f]{8}$/ : /^[0-9a-f]{16}$/)
      assert.ok(!Number.isNaN(floatFromBits(value, entry.width)))
      return value
    default:
      assert.equal(typeof value, "string")
      assert.match(value, /^(?:0|-?[1-9][0-9]*)$/)
      // Parse into a separate exact domain before comparing the canonical string.
      assert.equal(BigInt(value).toString(), value)
      return value
  }
}
export function attempt(operation) {
  try {
    return { ok: true, value: operation() }
  } catch (error) {
    if (!(error instanceof Schema.SchemaError)) throw error
    return { ok: false, error }
  }
}

// Independent Node UTF-8 encoding supplies valid payloads; appending a lone
// continuation byte mutates a valid encoding while keeping its u32 length true.
export function utf8Frame(value, invalid) {
  const payload = Buffer.from(value, "utf8")
  const output = new Uint8Array(4 + payload.length + (invalid ? 1 : 0))
  new DataView(output.buffer).setUint32(0, output.length - 4, true)
  output.set(payload, 4)
  if (invalid) output[output.length - 1] = 0x80
  return output
}

export function rawArbitrary(entry) {
  const generic = fc.uint8Array({ maxLength: 96 })
  if (entry.width !== undefined)
    return fc.oneof(generic, fc.uint8Array({ minLength: entry.width, maxLength: entry.width }))
  // Independent headers intentionally include truthful, off-by-one and huge
  // declared lengths; payload sizes stay bounded regardless of the header.
  const headers = fc
    .tuple(fc.uint8Array({ maxLength: 128 }), fc.integer({ min: 0, max: 3 }))
    .map(([payload, mode]) => {
      const output = new Uint8Array(payload.length + 4)
      new DataView(output.buffer).setUint32(
        0,
        [payload.length, payload.length + 1, 0, 0xffffffff][mode],
        true,
      )
      output.set(payload, 4)
      return output
    })
  return entry.id === "string"
    ? fc.oneof(
        generic,
        headers,
        fc
          .tuple(stringArbitrary, fc.boolean())
          .map(([value, invalid]) => utf8Frame(value, invalid)),
      )
    : fc.oneof(generic, headers)
}
