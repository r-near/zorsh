import { Schema } from "effect"
import { expect, it } from "vite-plus/test"
import { Borsh } from "../src/index.js"
import { compile } from "../src/internal/compile.js"
import { Writer } from "../src/internal/io.js"

function write(schema: Schema.Constraint, value: unknown) {
  const writer = new Writer(1024)
  compile(Schema.toEncoded(schema).ast).write(writer, value)
  return writer.finish()
}

it("rejects malformed values at the binary writer boundary", () => {
  const oversizedBytes = new Uint8Array()
  Object.defineProperty(oversizedBytes, "byteLength", { value: 0x1_0000_0000 })
  const oversizedArray = new Proxy([], {
    get: (target, key, receiver) =>
      key === "length" ? 0x1_0000_0000 : Reflect.get(target, key, receiver),
  })
  for (const [schema, value, message, path = []] of [
    [Schema.String, 7, "Expected string at byte 0"],
    [Schema.Boolean, 1, "Expected boolean at byte 0"],
    [Borsh.Bytes, [], "Expected Uint8Array at byte 0"],
    [Borsh.Bytes, oversizedBytes, "Byte array exceeds u32 length at byte 0"],
    [Borsh.fixedBytes(2), [1, 2], "Expected Uint8Array at byte 0"],
    [Borsh.fixedBytes(2), Uint8Array.of(1), "Expected 2 bytes at byte 0"],
    [Schema.Struct({ value: Borsh.U8 }), null, "Expected object at byte 0"],
    [Schema.Struct({ value: Borsh.U8 }), {}, "Missing required field at byte 0", ["value"]],
    [Schema.Tuple([Borsh.U8]), [], "Expected tuple of length 1 at byte 0"],
    [Schema.Tuple([Borsh.U8]), "x", "Expected tuple of length 1 at byte 0"],
    [Schema.Tuple([Borsh.U8, Borsh.U8]), [1, 256], "Integer outside u8 range at byte 1", [1]],
    [Schema.Array(Borsh.U8), {}, "Expected array with u32 length at byte 0"],
    [Schema.Array(Borsh.U8), oversizedArray, "Expected array with u32 length at byte 0"],
    [Schema.Array(Borsh.U8), [undefined], "Expected u8 at byte 4", [0]],
    [Borsh.U64, 1, "Expected u64 at byte 0"],
    [Borsh.U8, 1n, "Expected u8 at byte 0"],
    [Borsh.I128, 1n << 127n, "Integer outside i128 range at byte 0"],
    [Borsh.U128, -1n, "Integer outside u128 range at byte 0"],
    [Borsh.I8, -129, "Integer outside i8 range at byte 0"],
  ] as const) {
    expect(() => write(schema, value)).toThrow(expect.objectContaining({ message, path }))
  }
})

it("requires own struct fields and preserves nested getter defects", () => {
  const schema = Schema.Struct({ value: Borsh.U8 })
  expect(() => write(schema, Object.create({ value: 7 }))).toThrow(/Missing required field/)
  expect(write(schema, { value: 7 })).toEqual(Uint8Array.of(7))
  const defect = new Error("binary getter defect")
  expect(() =>
    write(Schema.Struct({ row: schema }), {
      row: {
        get value() {
          throw defect
        },
      },
    }),
  ).toThrow(defect)
})

it("keeps native views and string writes correct across writer growth", () => {
  const Row = Schema.Tuple([
    Borsh.U8,
    Borsh.I16,
    Borsh.U32,
    Borsh.I64,
    Borsh.I128,
    Borsh.U128,
    Borsh.F32,
    Borsh.F64,
    Schema.String,
  ])
  const row = (i: number) =>
    [
      i,
      -i - 1,
      0xffff_ffff - i,
      -(1n << 63n) + BigInt(i),
      -(1n << 127n) + BigInt(i),
      (1n << 128n) - 1n - BigInt(i),
      Math.fround(i / 3),
      -0,
      i % 2 === 0 ? `ascii-${i}` : `é😀-${i}`,
    ] as const
  const rows = Array.from({ length: 40 }, (_, i) => row(i))
  const one = Borsh.toCodec(Row)
  const many = Borsh.toCodec(Schema.Array(Row))
  const parts = rows.map((value) => Schema.encodeSync(one)(value))
  const expected = new Uint8Array(4 + parts.reduce((sum, part) => sum + part.byteLength, 0))
  new DataView(expected.buffer).setUint32(0, rows.length, true)
  let offset = 4
  for (const part of parts) {
    expected.set(part, offset)
    offset += part.byteLength
  }
  const bytes = Schema.encodeSync(many)(rows)
  expect(bytes).toEqual(expected)
  const decoded = Schema.decodeSync(many)(bytes)
  expect(decoded).toEqual(rows)
  expect(Object.is(decoded[0]?.[7], -0)).toBe(true)
  const buffer = Buffer.from(
    Uint8Array.of(9, ...Schema.encodeSync(Borsh.toCodec(Borsh.Bytes))(Uint8Array.of(7, 8))),
  )
  const decodedBytes = Schema.decodeSync(Borsh.toCodec(Borsh.Bytes))(buffer.subarray(1))
  buffer.fill(0)
  expect(decodedBytes).toEqual(Uint8Array.of(7, 8))
  expect(Buffer.isBuffer(decodedBytes)).toBe(false)
})
