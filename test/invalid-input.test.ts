import { afterEach, describe, expect, test, vi } from "vitest"
import { b } from "../src/schema"

afterEach(() => vi.unstubAllGlobals())

function stringBytes(bytes: number[]): Uint8Array {
  return Uint8Array.of(bytes.length, 0, 0, 0, ...bytes)
}

describe("invalid Borsh inputs", () => {
  test("bool and option only accept tags 0 and 1", () => {
    for (let tag = 2; tag <= 255; tag++) {
      expect(() => b.bool().deserialize(Uint8Array.of(tag))).toThrow()
      expect(() => b.option(b.u8()).deserialize(Uint8Array.of(tag, 42))).toThrow()
    }
    expect(b.bool().deserialize(Uint8Array.of(0))).toBe(false)
    expect(b.bool().deserialize(Uint8Array.of(1))).toBe(true)
    expect(b.option(b.u8()).deserialize(Uint8Array.of(0))).toBeNull()
    expect(b.option(b.u8()).deserialize(Uint8Array.of(1, 42))).toBe(42)
    expect(() => b.bool().deserialize(new Uint8Array())).toThrow()
    expect(() => b.option(b.u8()).deserialize(new Uint8Array())).toThrow()
    expect(() => b.option(b.u8()).deserialize(Uint8Array.of(1))).toThrow()
  })

  test("nested tags are validated", () => {
    expect(() => b.vec(b.bool()).deserialize(Uint8Array.of(2, 0, 0, 0, 1, 2))).toThrow()
    expect(() => b.option(b.option(b.u8())).deserialize(Uint8Array.of(1, 2))).toThrow()
  })

  test.each([[], [1], [1, 0], [1, 0, 0], [1, 0, 0, 0], [5, 0, 0, 0, 65], [255, 255, 255, 255]])(
    "rejects truncated strings %j",
    (...bytes) => {
      expect(() => b.string().deserialize(Uint8Array.from(bytes))).toThrow()
    },
  )

  test.each([
    [0xff], // invalid leading byte
    [0x80], // isolated continuation
    [0xc0, 0xaf], // overlong encoding
    [0xe2, 0x82], // incomplete sequence inside the declared byte span
    [0xe2, 0x28, 0xa1], // invalid continuation
    [0xed, 0xa0, 0x80], // surrogate code point
    [0xf4, 0x90, 0x80, 0x80], // above U+10FFFF
  ])("rejects malformed UTF-8 %j", (...bytes) => {
    expect(() => b.string().deserialize(stringBytes(bytes))).toThrow()
  })

  test("UTF-8 validation respects the declared string boundary", () => {
    const schema = b.tuple(b.string(), b.u8())
    expect(() => schema.deserialize(Uint8Array.of(1, 0, 0, 0, 0xc2, 0xa2))).toThrow()
    expect(schema.deserialize(Uint8Array.of(2, 0, 0, 0, 0xc2, 0xa2, 42))).toEqual(["¢", 42])
  })

  test.each(["", "\uFEFF", "\uFEFFhello", "a\uFEFFb", "\uFFFD", "\0¢你好🦀\u{10FFFF}"])(
    "preserves valid UTF-8 content %j",
    (value) => {
      const schema = b.tuple(b.option(b.string()), b.string(), b.u8())
      const input = [value, value, 42] as [string, string, number]
      expect(schema.deserialize(schema.serialize(input))).toEqual(input)
    },
  )

  test("string and byte reads respect Uint8Array and Buffer view bounds", () => {
    for (const buffer of [
      Uint8Array.of(99, 2, 0, 0, 0, 65, 66, 99),
      Buffer.from([99, 2, 0, 0, 0, 65, 66, 99]),
    ]) {
      expect(b.string().deserialize(buffer.subarray(1, 7))).toBe("AB")
      expect(b.bytes().deserialize(buffer.subarray(1, 7))).toEqual(Uint8Array.of(65, 66))
      expect(() => b.string().deserialize(buffer.subarray(1, 6))).toThrow()
      expect(() => b.bytes().deserialize(buffer.subarray(1, 6))).toThrow()
      expect(() => b.bytes(2).deserialize(buffer.subarray(5, 6))).toThrow()
    }
  })

  test("decoded bytes own their storage, including when input is a Buffer", () => {
    for (const input of [Uint8Array.of(1, 2), Buffer.from([1, 2])]) {
      const output = b.bytes(2).deserialize(input)
      input[0] = 99
      expect(output[0]).toBe(1)
      output[1] = 88
      expect(input[1]).toBe(2)
      expect(output.constructor).toBe(Uint8Array)
    }
    expect(b.bytes(0).deserialize(new Uint8Array())).toEqual(new Uint8Array())
    expect(b.bytes().deserialize(Uint8Array.of(0, 0, 0, 0))).toEqual(new Uint8Array())
  })

  test("does not allocate byte payloads from untrusted lengths before checking input", () => {
    const input = Uint8Array.of(255, 255, 255, 255)
    const nativeUint8Array = Uint8Array
    vi.stubGlobal(
      "Uint8Array",
      new Proxy(nativeUint8Array, {
        construct(target, args, newTarget) {
          if (typeof args[0] === "number" && args[0] > 1024) {
            throw new Error("untrusted byte allocation attempted")
          }
          return Reflect.construct(target, args, newTarget)
        },
      }),
    )
    expect(() => b.bytes().deserialize(input)).toThrow(RangeError)
    expect(() => b.bytes(0xffffffff).deserialize(input)).toThrow(RangeError)
  })

  test("does not preallocate collections from untrusted lengths", () => {
    const input = Uint8Array.of(255, 255, 255, 255)
    vi.stubGlobal(
      "Array",
      new Proxy(Array, {
        construct(target, args, newTarget) {
          if (typeof args[0] === "number" && args[0] > 1024) {
            throw new Error("untrusted collection allocation attempted")
          }
          return Reflect.construct(target, args, newTarget)
        },
      }),
    )
    expect(() => b.vec(b.u8()).deserialize(input)).toThrow(RangeError)
    expect(() => b.hashSet(b.u8()).deserialize(input)).toThrow(RangeError)
    expect(() => b.hashMap(b.u8(), b.u8()).deserialize(input)).toThrow(RangeError)
  })

  test("retains zero-byte element support without assuming one byte per element", () => {
    expect(b.vec(b.unit()).deserialize(Uint8Array.of(3, 0, 0, 0))).toEqual([{}, {}, {}])
    expect(b.array(b.unit(), 3).deserialize(new Uint8Array())).toEqual([{}, {}, {}])
    expect(b.hashSet(b.unit()).deserialize(Uint8Array.of(1, 0, 0, 0))).toEqual(new Set([{}]))
    expect(b.hashMap(b.unit(), b.unit()).deserialize(Uint8Array.of(1, 0, 0, 0))).toEqual(
      new Map([[{}, {}]]),
    )
  })

  test("retains prefix decoding", () => {
    expect(b.u8().deserialize(Uint8Array.of(7, 99))).toBe(7)
    expect(b.string().deserialize(Uint8Array.of(1, 0, 0, 0, 65, 99))).toBe("A")
  })
})

describe("Borsh floats", () => {
  test.each([
    [0x00, 0x00, 0xc0, 0x7f], // quiet NaN
    [0x01, 0x00, 0x80, 0x7f], // signaling NaN
    [0x00, 0x00, 0xc0, 0xff], // negative NaN
  ])("rejects f32 NaN payloads %j", (...bytes) => {
    expect(() => b.f32().deserialize(Uint8Array.from(bytes))).toThrow()
    expect(() => b.vec(b.f32()).deserialize(Uint8Array.of(1, 0, 0, 0, ...bytes))).toThrow()
  })

  test.each([
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf8, 0x7f],
    [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x7f],
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf8, 0xff],
  ])("rejects f64 NaN payloads %j", (...bytes) => {
    expect(() => b.f64().deserialize(Uint8Array.from(bytes))).toThrow()
    expect(() => b.array(b.f64(), 1).deserialize(Uint8Array.from(bytes))).toThrow()
  })

  test("rejects serializing NaN for both float widths", () => {
    for (const schema of [b.f32(), b.f64()]) {
      expect(() => schema.serialize(Number.NaN)).toThrow()
      expect(() => b.vec(schema).serialize([Number.NaN])).toThrow()
    }
  })

  test("preserves finite values, infinities and signed zero", () => {
    for (const schema of [b.f32(), b.f64()]) {
      for (const value of [0, -0, 1, -1, Infinity, -Infinity]) {
        expect(schema.deserialize(schema.serialize(value))).toBe(value)
      }
    }
    expect(b.f32().deserialize(Uint8Array.of(1, 0, 0, 0))).toBe(2 ** -149)
    expect(b.f64().deserialize(Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0))).toBe(Number.MIN_VALUE)
  })
})
