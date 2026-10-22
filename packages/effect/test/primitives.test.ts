import { Schema } from "effect"
import fc from "fast-check"
import { describe, expect, it } from "vite-plus/test"
import { Borsh } from "../src/index.js"

describe("Borsh primitives", () => {
  it.each([
    {
      name: "F32",
      schema: Borsh.F32,
      value: 0.1,
      expected: "Expected an exactly representable binary32 number",
    },
    { name: "F64", schema: Borsh.F64, value: NaN, expected: "Expected a non-NaN number" },
    {
      name: "fixedBytes(2)",
      schema: Borsh.fixedBytes(2),
      value: Uint8Array.of(1),
      expected: "Expected a value with a length of 2",
    },
  ])("describes primitive validation failures for $name", ({ schema, value, expected }) => {
    expect(() => Schema.decodeSync(schema)(value)).toThrow(expected)
    expect(() => Schema.encodeSync(Borsh.toCodec(schema))(value)).toThrow(expected)
  })

  it("encodes Rust little-endian u128 carry boundaries", () => {
    const codec = Borsh.toCodec(Borsh.U128)
    expect(Schema.encodeSync(codec)(1n << 64n)).toEqual(
      Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0),
    )
    expect(Schema.decodeSync(codec)(new Uint8Array(16).fill(255))).toBe((1n << 128n) - 1n)
  })

  const numbers = [
    { name: "U8", schema: Borsh.U8, min: 0, max: 255, width: 1 },
    { name: "U16", schema: Borsh.U16, min: 0, max: 65535, width: 2 },
    { name: "U32", schema: Borsh.U32, min: 0, max: 4294967295, width: 4 },
    { name: "I8", schema: Borsh.I8, min: -128, max: 127, width: 1 },
    { name: "I16", schema: Borsh.I16, min: -32768, max: 32767, width: 2 },
    { name: "I32", schema: Borsh.I32, min: -2147483648, max: 2147483647, width: 4 },
  ]
  it.each(numbers)(
    "$name validates and encodes both boundaries without wrapping",
    ({ schema, min, max, width }) => {
      const codec = Borsh.toCodec(schema)
      const encode = Schema.encodeSync(codec)
      const decode = Schema.decodeSync(codec)
      const high = new Uint8Array(width).fill(255)
      const low = new Uint8Array(width)
      if (min < 0) {
        high[width - 1] = 127
        low[width - 1] = 128
      }
      expect(encode(max)).toEqual(high)
      expect(encode(min)).toEqual(low)
      expect(decode(high)).toBe(max)
      expect(decode(low)).toBe(min)
      for (const invalid of [min - 1, max + 1, 1.5, NaN, Infinity, -Infinity, "1", 1n, null]) {
        expect(Schema.is(schema)(invalid)).toBe(false)
        expect(() => Schema.encodeUnknownSync(codec)(invalid)).toThrow(Schema.SchemaError)
        expect(() => Schema.encodeUnknownSync(codec, { disableChecks: true })(invalid)).toThrow(
          Schema.SchemaError,
        )
      }
      fc.assert(
        fc.property(fc.integer({ min, max }), (value) => {
          const bytes = encode(value)
          expect(bytes.byteLength).toBe(width)
          expect(decode(bytes)).toBe(value)
        }),
        { numRuns: 200 },
      )
    },
  )

  const bigints = [
    { name: "U64", schema: Borsh.U64, min: 0n, max: 18446744073709551615n, width: 8 },
    {
      name: "I64",
      schema: Borsh.I64,
      min: -9223372036854775808n,
      max: 9223372036854775807n,
      width: 8,
    },
    {
      name: "U128",
      schema: Borsh.U128,
      min: 0n,
      max: 340282366920938463463374607431768211455n,
      width: 16,
    },
    {
      name: "I128",
      schema: Borsh.I128,
      min: -170141183460469231731687303715884105728n,
      max: 170141183460469231731687303715884105727n,
      width: 16,
    },
  ]
  it.each(bigints)(
    "$name validates both boundaries and carries across bytes",
    ({ schema, min, max, width }) => {
      const codec = Borsh.toCodec(schema)
      const encode = Schema.encodeSync(codec)
      const decode = Schema.decodeSync(codec)
      const high = new Uint8Array(width).fill(255)
      const low = new Uint8Array(width)
      if (min < 0n) {
        high[width - 1] = 127
        low[width - 1] = 128
      }
      expect(encode(max)).toEqual(high)
      expect(encode(min)).toEqual(low)
      expect(decode(high)).toBe(max)
      expect(decode(low)).toBe(min)
      for (const invalid of [min - 1n, max + 1n, 1, "1", null]) {
        expect(Schema.is(schema)(invalid)).toBe(false)
        expect(() => Schema.encodeUnknownSync(codec)(invalid)).toThrow(Schema.SchemaError)
        expect(() => Schema.encodeUnknownSync(codec, { disableChecks: true })(invalid)).toThrow(
          Schema.SchemaError,
        )
      }
      const carry = new Uint8Array(width)
      carry[4] = 1
      expect(encode(4294967296n)).toEqual(carry)
      if (min < 0n) {
        expect(encode(-1n)).toEqual(new Uint8Array(width).fill(255))
      }
      fc.assert(
        fc.property(fc.bigInt({ min, max }), (value) => {
          const bytes = encode(value)
          expect(bytes.byteLength).toBe(width)
          expect(decode(bytes)).toBe(value)
        }),
        { numRuns: 200 },
      )
    },
  )

  it("uses strict Borsh booleans and Rust unit", () => {
    const bool = Borsh.toCodec(Schema.Boolean)
    expect(Schema.encodeSync(bool)(false)).toEqual(Uint8Array.of(0))
    expect(Schema.encodeSync(bool)(true)).toEqual(Uint8Array.of(1))
    expect(Schema.decodeSync(bool)(Uint8Array.of(0))).toBe(false)
    expect(Schema.decodeSync(bool)(Uint8Array.of(1))).toBe(true)
    for (const tag of [2, 128, 255]) {
      expect(() => Schema.decodeSync(bool)(Uint8Array.of(tag))).toThrow(/bool tag.* at byte 0$/)
    }
    expect(() => Schema.encodeUnknownSync(bool)(1)).toThrow(Schema.SchemaError)
    const unit = Borsh.toCodec(Borsh.Unit)
    expect(Schema.encodeSync(unit)([])).toEqual(new Uint8Array())
    expect(Schema.decodeSync(unit)(new Uint8Array())).toEqual([])
    expect(() => Schema.encodeUnknownSync(unit)([1])).toThrow(Schema.SchemaError)
    expect(() => Schema.decodeSync(unit)(Uint8Array.of(0))).toThrow(/Trailing.* at byte 0$/)
  })

  it.each([Borsh.F32, Borsh.F64])(
    "preserves signed zero and infinities while rejecting NaN",
    (schema) => {
      const codec = Borsh.toCodec(schema)
      for (const value of [0, -0, Infinity, -Infinity, 1.5, -2]) {
        expect(Object.is(Schema.decodeSync(codec)(Schema.encodeSync(codec)(value)), value)).toBe(
          true,
        )
        expect(Schema.is(schema)(value)).toBe(true)
      }
      expect(Schema.is(schema)(NaN)).toBe(false)
      expect(() => Schema.encodeUnknownSync(codec, { disableChecks: true })(NaN)).toThrow(/non-NaN/)
      expect(() => Schema.encodeUnknownSync(codec)("1")).toThrow(Schema.SchemaError)
    },
  )

  it("requires exact f32 values and includes subnormals", () => {
    const codec = Borsh.toCodec(Borsh.F32)
    expect(Schema.encodeSync(codec)(2 ** -149)).toEqual(Uint8Array.of(1, 0, 0, 0))
    expect(Schema.encodeSync(codec)(-0)).toEqual(Uint8Array.of(0, 0, 0, 128))
    expect(Schema.encodeSync(codec)(Infinity)).toEqual(Uint8Array.of(0, 0, 128, 127))
    expect(Schema.decodeSync(codec)(Uint8Array.of(255, 255, 127, 0))).toBe(
      Math.fround(2 ** -126 - 2 ** -149),
    )
    for (const value of [0.1, 2 ** -150, 3.4028236e38]) {
      expect(Schema.is(Borsh.F32)(value)).toBe(false)
      expect(() => Schema.encodeSync(codec, { disableChecks: true })(value)).toThrow(/exact/)
    }
    expect(Schema.decodeSync(codec)(Schema.encodeSync(codec)(Math.fround(0.1)))).toBe(
      Math.fround(0.1),
    )
  })

  it("rejects positive/negative, quiet/signaling, noncanonical NaN payloads", () => {
    for (const bits of [0x7f800001, 0x7fc00000, 0x7fffffff, 0xff800001, 0xffffffff]) {
      const bytes = new Uint8Array(4)
      new DataView(bytes.buffer).setUint32(0, bits, true)
      expect(() => Schema.decodeSync(Borsh.toCodec(Borsh.F32))(bytes)).toThrow(/NaN.* at byte 0$/)
    }
    for (const bits of [
      0x7ff0000000000001n,
      0x7ff8000000000000n,
      0x7fffffffffffffffn,
      0xfff0000000000001n,
      0xffffffffffffffffn,
    ]) {
      const bytes = new Uint8Array(8)
      new DataView(bytes.buffer).setBigUint64(0, bits, true)
      expect(() => Schema.decodeSync(Borsh.toCodec(Borsh.F64))(bytes)).toThrow(/NaN.* at byte 0$/)
    }
  })

  it("roundtrips arbitrary non-NaN float wire patterns without changing their bytes", () => {
    for (const [schema, width] of [
      [Borsh.F32, 4],
      [Borsh.F64, 8],
    ] as const) {
      const codec = Borsh.toCodec(schema)
      fc.assert(
        fc.property(fc.uint8Array({ minLength: width, maxLength: width }), (bytes) => {
          const view = new DataView(bytes.buffer, bytes.byteOffset, width)
          const value = width === 4 ? view.getFloat32(0, true) : view.getFloat64(0, true)
          if (Number.isNaN(value)) {
            expect(() => Schema.decodeSync(codec)(bytes)).toThrow(Schema.SchemaError)
          } else {
            expect(Schema.encodeSync(codec)(Schema.decodeSync(codec)(bytes))).toEqual(bytes)
          }
        }),
        { numRuns: 500 },
      )
    }
  })

  it("uses UTF-8 byte lengths, preserves a leading BOM and rejects lone UTF-16 surrogates", () => {
    const codec = Borsh.toCodec(Schema.String)
    expect(Schema.encodeSync(codec)("é😀")).toEqual(
      Uint8Array.of(6, 0, 0, 0, 195, 169, 240, 159, 152, 128),
    )
    expect(Schema.decodeSync(codec)(Uint8Array.of(4, 0, 0, 0, 239, 187, 191, 97))).toBe("\uFEFFa")
    expect(Schema.encodeSync(codec)("\uFEFFa")).toEqual(
      Uint8Array.of(4, 0, 0, 0, 239, 187, 191, 97),
    )
    for (const value of ["\uD800", "a\uDC00", "\uD800x", "\uD800\uD800"]) {
      expect(() => Schema.encodeSync(codec)(value)).toThrow(/Lone UTF-16/)
    }
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 100 }), (value) => {
        expect(Schema.decodeSync(codec)(Schema.encodeSync(codec)(value))).toBe(value)
      }),
    )
  })

  it("matches TextEncoder and TextDecoder across the short ASCII string paths", () => {
    const codec = Borsh.toCodec(Schema.String)
    const prefixed = (bytes: Uint8Array) => {
      const out = new Uint8Array(4 + bytes.byteLength)
      new DataView(out.buffer).setUint32(0, bytes.byteLength, true)
      out.set(bytes, 4)
      return out
    }
    for (let length = 0; length <= 40; length++) {
      const ascii = Array.from({ length }, (_, i) => String.fromCharCode(i % 128)).join("")
      const values = [
        ascii,
        ...Array.from(ascii, (_, i) => ascii.slice(0, i) + "é" + ascii.slice(i + 1)),
      ]
      for (const value of values) {
        const bytes = prefixed(new TextEncoder().encode(value))
        expect(Schema.encodeSync(codec)(value)).toEqual(bytes)
        expect(Schema.decodeSync(codec)(bytes)).toBe(value)
      }
      if (length > 0) {
        const malformed = new TextEncoder().encode(ascii)
        malformed[length - 1] = 0xff
        expect(() => Schema.decodeSync(codec)(prefixed(malformed))).toThrow(
          /^Invalid UTF-8 at byte 4$/,
        )
      }
    }
  })

  it.each([[0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0x80], [0xe2, 0x82]])(
    "rejects malformed UTF-8 %j",
    (...payload) => {
      expect(() =>
        Schema.decodeSync(Borsh.toCodec(Schema.String))(
          Uint8Array.of(payload.length, 0, 0, 0, ...payload),
        ),
      ).toThrow(/UTF-8.* at byte 4$/)
    },
  )

  it("uses length-prefixed bytes and fixed bytes with owned input/output storage", () => {
    const codec = Borsh.toCodec(Borsh.Bytes)
    const source = Uint8Array.of(9, 1, 2, 3, 9)
    const value = source.subarray(1, 4)
    const encoded = Schema.encodeSync(codec)(value)
    expect(encoded).toEqual(Uint8Array.of(3, 0, 0, 0, 1, 2, 3))
    expect(source).toEqual(Uint8Array.of(9, 1, 2, 3, 9))
    const decoded = Schema.decodeSync(codec)(encoded)
    source.fill(0)
    expect(encoded).toEqual(Uint8Array.of(3, 0, 0, 0, 1, 2, 3))
    encoded.fill(0)
    expect(decoded).toEqual(Uint8Array.of(1, 2, 3))
    decoded[0] = 9
    expect(Schema.decodeSync(codec)(Uint8Array.of(1, 0, 0, 0, 7))).toEqual(Uint8Array.of(7))
    const fixed = Borsh.toCodec(Borsh.fixedBytes(3))
    expect(Schema.encodeSync(fixed)(Uint8Array.of(1, 2, 3))).toEqual(Uint8Array.of(1, 2, 3))
    expect(Schema.decodeSync(fixed)(Uint8Array.of(1, 2, 3))).toEqual(Uint8Array.of(1, 2, 3))
    expect(() => Schema.encodeSync(fixed, { disableChecks: true })(Uint8Array.of(1, 2))).toThrow(
      /Expected 3 bytes/,
    )
    expect(Schema.decodeSync(Borsh.toCodec(Borsh.fixedBytes(0)))(new Uint8Array())).toEqual(
      new Uint8Array(),
    )
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (input) => {
        expect(Schema.decodeSync(codec)(Schema.encodeSync(codec)(input))).toEqual(input)
      }),
    )
    const grown = Schema.encodeSync(codec)(new Uint8Array(257).fill(90))
    expect(grown).toEqual(Uint8Array.of(1, 1, 0, 0, ...new Uint8Array(257).fill(90)))
    expect(Schema.decodeSync(codec)(grown)).toEqual(new Uint8Array(257).fill(90))
  })

  it("owns decoded storage even when an input subclass overrides slice and subarray", () => {
    class Aliased extends Uint8Array {
      override slice(): Uint8Array<ArrayBuffer> {
        return this
      }
      override subarray(): Uint8Array<ArrayBuffer> {
        return this
      }
    }
    const input = new Aliased([2, 0, 0, 0, 7, 8])
    const decoded = Schema.decodeSync(Borsh.toCodec(Borsh.Bytes))(input)
    expect(decoded).toEqual(Uint8Array.of(7, 8))
    input.fill(0)
    expect(decoded).toEqual(Uint8Array.of(7, 8))
  })

  it("respects nonzero offsets, rejects truncation/trailing data and consumes exactly one value", () => {
    expect(
      Schema.decodeSync(Borsh.toCodec(Borsh.U16))(Uint8Array.of(9, 0x34, 0x12, 9).subarray(1, 3)),
    ).toBe(0x1234)
    expect(
      Schema.decodeSync(Borsh.toCodec(Borsh.Bytes))(
        Uint8Array.of(9, 2, 0, 0, 0, 7, 8, 9).subarray(1, 7),
      ),
    ).toEqual(Uint8Array.of(7, 8))
    for (const schema of [
      Borsh.U8,
      Borsh.U16,
      Borsh.U32,
      Borsh.U64,
      Borsh.U128,
      Borsh.F32,
      Borsh.F64,
      Schema.Boolean,
      Schema.String,
      Borsh.Bytes,
      Borsh.fixedBytes(4),
    ]) {
      const codec = Borsh.toCodec(schema)
      expect(() => Schema.decodeSync(codec)(new Uint8Array())).toThrow(/Truncated.* at byte 0$/)
    }
    const codec = Borsh.toCodec(Borsh.U16)
    expect(() => Schema.decodeSync(codec)(Uint8Array.of(1))).toThrow(/Truncated.* at byte 0$/)
    expect(() => Schema.decodeSync(codec)(Uint8Array.of(1, 0, 9))).toThrow(/Trailing.* at byte 2$/)
    for (const schema of [Schema.String, Borsh.Bytes]) {
      expect(() =>
        Schema.decodeSync(Borsh.toCodec(schema))(Uint8Array.of(255, 255, 255, 255)),
      ).toThrow(/Truncated.* at byte 4$/)
    }
  })

  it("enforces custom and default byte caps before allocating payloads", () => {
    const codec = Borsh.toCodec(Schema.String, { maxBytes: 8 })
    expect(Schema.encodeSync(codec)("éé").byteLength).toBe(8)
    expect(() => Schema.encodeSync(codec)("ééa")).toThrow(/byte budget/)
    expect(() => Schema.decodeSync(codec)(Uint8Array.of(5, 0, 0, 0, 1, 2, 3, 4, 5))).toThrow(
      /Input exceeds maxBytes/,
    )
    expect(() =>
      Schema.encodeSync(Borsh.toCodec(Borsh.Bytes, { maxBytes: 5 }))(Uint8Array.of(1, 2)),
    ).toThrow(/Output exceeds maxBytes/)
    expect(() => Schema.encodeSync(Borsh.toCodec(Borsh.U64, { maxBytes: 7 }))(0n)).toThrow(
      /Output exceeds maxBytes/,
    )
    const overDefault = new Uint8Array(16 * 1024 * 1024 + 1)
    expect(() => Schema.decodeSync(Borsh.toCodec(Borsh.Bytes))(overDefault)).toThrow(
      /Input exceeds maxBytes/,
    )
    expect(() => Schema.encodeSync(Borsh.toCodec(Borsh.Bytes))(overDefault)).toThrow(
      /Output exceeds maxBytes/,
    )
    expect(() =>
      Schema.encodeSync(Borsh.toCodec(Schema.String))("a".repeat(16 * 1024 * 1024)),
    ).toThrow(/byte budget/)
    for (const maxBytes of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => Borsh.toCodec(Borsh.U8, { maxBytes })).toThrow(/positive safe integer/)
    }
    for (const length of [-1, 1.5, Infinity, NaN, 0x100000000]) {
      expect(() => Borsh.fixedBytes(length)).toThrow(/fixedBytes length/)
    }
  })
})
