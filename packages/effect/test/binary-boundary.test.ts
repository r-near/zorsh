import { Schema } from "effect"
import { expect, it } from "vite-plus/test"
import { Borsh } from "../src/index.js"
import { compile } from "../src/internal/compiler.js"
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
  for (const [schema, value, message] of [
    [Schema.String, 7, /Expected string/],
    [Schema.Boolean, 1, /Expected boolean/],
    [Borsh.Bytes, [], /Expected Uint8Array/],
    [Borsh.Bytes, oversizedBytes, /Byte array exceeds u32 length/],
    [Borsh.fixedBytes(2), Uint8Array.of(1), /Expected 2 bytes/],
    [Schema.Struct({ value: Borsh.U8 }), null, /Expected object/],
    [Schema.Struct({ value: Borsh.U8 }), {}, /\$\["value"\] at byte 0: Missing required field/],
    [Schema.Tuple([Borsh.U8]), [], /Expected tuple of length 1/],
    [Schema.Tuple([Borsh.U8]), "x", /Expected tuple of length 1/],
    [Schema.Array(Borsh.U8), {}, /Expected array with u32 length/],
    [Schema.Array(Borsh.U8), oversizedArray, /Expected array with u32 length/],
    [Schema.Array(Borsh.U8), [undefined], /\$\[0\] at byte 4: Expected u8/],
  ] as const)
    expect(() => write(schema, value)).toThrow(message)
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
