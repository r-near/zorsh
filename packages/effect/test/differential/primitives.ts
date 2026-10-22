import assert from "node:assert/strict"
import { Schema } from "effect"
import fc from "fast-check"
const packageName = "@zorsh/effect"
const { Borsh }: typeof import("../../src/index.js") = await import(packageName)

export const hex = (value: Uint8Array) =>
  Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("hex")
export const bytes = (value: string) => Uint8Array.from(Buffer.from(value, "hex"))
export interface Primitive {
  id: string
  arbitrary: fc.Arbitrary<unknown>
  examples: unknown[]
  fromTransport: (value: unknown) => unknown
  normalize: (value: unknown) => unknown
  width?: number | undefined
  encode: (value: unknown) => Uint8Array
  decode: (value: Uint8Array) => unknown
}
function spec(
  id: string,
  schema: Schema.ConstraintCodec<unknown, unknown>,
  arbitrary: fc.Arbitrary<unknown>,
  examples: unknown[],
  fromTransport: Primitive["fromTransport"],
  normalize: Primitive["normalize"],
  width?: number,
): Primitive {
  const codec = Borsh.toCodec(schema, { maxBytes: 65536 })
  return {
    id,
    arbitrary,
    examples,
    fromTransport,
    normalize,
    width,
    encode: Schema.encodeUnknownSync(codec),
    decode: Schema.decodeSync(codec),
  }
}
const edgesAnd = <A>(edges: A[], arbitrary: fc.Arbitrary<A>) =>
  fc.oneof(fc.constantFrom(...edges), arbitrary)
const string = (v: unknown) => {
  assert.ok(typeof v === "string")
  return v
}
const boolean = (v: unknown) => {
  assert.ok(typeof v === "boolean")
  return v
}
export const primitives: Primitive[] = [
  spec("bool", Schema.Boolean, fc.boolean(), [false, true], boolean, boolean, 1),
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
] as const) {
  const min = signed ? -(1n << BigInt(bits - 1)) : 0n
  const max = (1n << BigInt(signed ? bits - 1 : bits)) - 1n
  const edges = new Set([min, min + 1n, max - 1n, max, 0n, 1n])
  for (let bit = 8; bit < bits; bit += 8) {
    const carry = 1n << BigInt(bit)
    for (const value of [carry - 1n, carry, carry + 1n, -carry - 1n, -carry, -carry + 1n]) {
      if (value >= min && value <= max) {
        edges.add(value)
      }
    }
  }
  if (signed) {
    edges.add(-1n)
  }
  primitives.push(
    spec(
      id,
      schema,
      edgesAnd([...edges], fc.bigInt({ min, max })).map(String),
      [...edges].map(String),
      (v) => (bits <= 32 ? Number(string(v)) : BigInt(string(v))),
      (v) => {
        if (bits <= 32) {
          assert.ok(typeof v === "number" && Number.isSafeInteger(v) && !Object.is(v, -0))
        } else {
          assert.ok(typeof v === "bigint")
        }
        return String(v)
      },
      bits / 8,
    ),
  )
}
export function floatFromBits(value: unknown, width: number) {
  assert.ok(value !== null && typeof value === "object" && "bits" in value)
  const bits = string(value.bits)
  assert.match(bits, width === 4 ? /^[0-9a-f]{8}$/ : /^[0-9a-f]{16}$/)
  const view = new DataView(new ArrayBuffer(width))
  if (width === 4) {
    view.setUint32(0, Number(BigInt(`0x${bits}`)))
    return view.getFloat32(0)
  }
  view.setBigUint64(0, BigInt(`0x${bits}`))
  return view.getFloat64(0)
}
function floatBits(value: unknown, width: number) {
  assert.ok(typeof value === "number")
  const view = new DataView(new ArrayBuffer(width))
  if (width === 4) {
    view.setFloat32(0, value)
    return { bits: view.getUint32(0).toString(16).padStart(8, "0") }
  }
  view.setFloat64(0, value)
  return { bits: view.getBigUint64(0).toString(16).padStart(16, "0") }
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
] as const) {
  const examples = patterns.map((bits) => ({ bits: String(bits) }))
  primitives.push(
    spec(
      id,
      schema,
      edgesAnd(
        examples,
        fc
          .bigInt({ min: 0n, max: (1n << BigInt(width * 8)) - 1n })
          .map((v) => ({ bits: v.toString(16).padStart(width * 2, "0") })),
      ),
      examples,
      (v) => floatFromBits(v, width),
      (v) => floatBits(v, width),
      width,
    ),
  )
}
const scalar = fc.oneof(
  fc.integer({ min: 0, max: 0xd7ff }),
  fc.integer({ min: 0xe000, max: 0x10ffff }),
)
const strings = ["", "\uFEFF", "\uFEFFa", "\0", "é😀", "e\u0301", "\r\n"]
export const stringArbitrary = edgesAnd(
  strings,
  fc.array(scalar, { maxLength: 64 }).map((v) => String.fromCodePoint(...v)),
)
primitives.push(spec("string", Schema.String, stringArbitrary, strings, string, string))
for (const [id, schema, fixed] of [
  ["bytes", Borsh.Bytes, undefined],
  ["bytes32", Borsh.fixedBytes(32), 32],
  ["bytes0", Borsh.fixedBytes(0), 0],
] as const) {
  primitives.push(
    spec(
      id,
      schema,
      fc.uint8Array({ minLength: fixed ?? 0, maxLength: fixed ?? 128 }).map(hex),
      fixed === undefined ? ["", "00", "ff", "000102ff"] : ["00".repeat(fixed), "ff".repeat(fixed)],
      (v) => bytes(string(v)),
      (v) => {
        assert.ok(v instanceof Uint8Array)
        return hex(v)
      },
      fixed,
    ),
  )
}
primitives.push(
  spec(
    "unit",
    Borsh.Unit,
    fc.constant(null),
    [null],
    () => [],
    (v) => {
      assert.deepEqual(v, [])
      return null
    },
    0,
  ),
)

export function normalizeOracle(entry: Primitive, value: unknown) {
  if (entry.id.startsWith("f")) {
    assert.ok(!Number.isNaN(floatFromBits(value, entry.width ?? 0)))
    return value
  }
  if (/^[ui][0-9]+$/.test(entry.id)) {
    const result = string(value)
    assert.match(result, /^(?:0|-?[1-9][0-9]*)$/)
    assert.equal(BigInt(result).toString(), result)
    return result
  }
  if (entry.id === "bool") {
    return boolean(value)
  }
  if (entry.id === "unit") {
    assert.equal(value, null)
    return null
  }
  const result = string(value)
  if (entry.id === "string") {
    assert.equal(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        Buffer.from(result, "utf8"),
      ),
      result,
    )
  } else {
    assert.match(result, /^(?:[0-9a-f]{2})*$/)
    if (entry.width !== undefined) {
      assert.equal(result.length, entry.width * 2)
    }
  }
  return result
}
export function attempt<A>(operation: () => A): { ok: true; value: A } | { ok: false } {
  try {
    return { ok: true, value: operation() }
  } catch (error) {
    if (!(error instanceof Schema.SchemaError)) {
      throw error
    }
    return { ok: false }
  }
}
export function utf8Frame(value: string, invalid: boolean) {
  const payload = Buffer.from(value, "utf8")
  const output = new Uint8Array(4 + payload.length + Number(invalid))
  new DataView(output.buffer).setUint32(0, output.length - 4, true)
  output.set(payload, 4)
  if (invalid) {
    output[output.length - 1] = 0x80
  }
  return output
}
export function rawArbitrary(entry: Primitive) {
  const generic = fc.uint8Array({ maxLength: 96 })
  if (entry.width !== undefined) {
    return fc.oneof(generic, fc.uint8Array({ minLength: entry.width, maxLength: entry.width }))
  }
  const headers = fc
    .tuple(fc.uint8Array({ maxLength: 128 }), fc.integer({ min: 0, max: 3 }))
    .map(([payload, mode]) => {
      const output = new Uint8Array(payload.length + 4)
      new DataView(output.buffer).setUint32(
        0,
        [payload.length, payload.length + 1, 0, 0xffffffff][mode] ?? 0,
        true,
      )
      output.set(payload, 4)
      return output
    })
  return entry.id === "string"
    ? fc.oneof(
        generic,
        headers,
        fc.tuple(stringArbitrary, fc.boolean()).map(([v, invalid]) => utf8Frame(v, invalid)),
      )
    : fc.oneof(generic, headers)
}
