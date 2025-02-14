import { describe, expect, it } from "vitest"
import { b } from "../src/schema"

describe("tuple serialization", () => {
  it("serializes and deserializes basic tuples", () => {
    const schema = b.tuple(b.u8(), b.string())
    const value: b.infer<typeof schema> = [42, "hello"]
    const bytes = schema.serialize(value)
    const decoded = schema.deserialize(bytes)
    expect(decoded).toEqual(value)
  })

  it("handles nested tuples", () => {
    const schema = b.tuple(b.tuple(b.i32(), b.i32()), b.string())
    const value: b.infer<typeof schema> = [[123, 456], "nested"]
    const bytes = schema.serialize(value)
    const decoded = schema.deserialize(bytes)
    expect(decoded).toEqual(value)
  })

  it("handles tuples with complex types", () => {
    const schema = b.tuple(b.vec(b.u8()), b.option(b.string()), b.tuple(b.f32(), b.f32()))
    const value: b.infer<typeof schema> = [new Uint8Array([1, 2, 3]), "optional", [1.5, 2.5]]
    const bytes = schema.serialize(value)
    const decoded = schema.deserialize(bytes)

    // Need to check Uint8Array separately since toEqual doesn't handle them well
    expect(new Uint8Array(decoded[0] as ArrayBuffer)).toEqual(value[0])
    expect(decoded[1]).toEqual(value[1])
    expect(decoded[2]).toEqual(value[2])
  })

  it("handles empty tuples", () => {
    const schema = b.tuple()
    const value: b.infer<typeof schema> = []
    const bytes = schema.serialize(value)
    const decoded = schema.deserialize(bytes)
    expect(decoded).toEqual(value)
  })

  it("throws error on length mismatch", () => {
    const schema = b.tuple(b.u8(), b.u8())
    // @ts-expect-error - length mismatch
    const value: b.infer<typeof schema> = [1] // Missing second value
    expect(() => schema.serialize(value)).toThrow(/length mismatch/)
  })

  it("preserves numeric precision", () => {
    const schema = b.tuple(b.u64(), b.i128())
    const value: b.infer<typeof schema> = [
      BigInt("18446744073709551615"),
      BigInt("-170141183460469231731687303715884105728"),
    ]
    const bytes = schema.serialize(value)
    const decoded = schema.deserialize(bytes)
    expect(decoded).toEqual(value)
  })

  it("handles tuples with all primitive types", () => {
    const schema = b.tuple(
      b.u8(),
      b.u16(),
      b.u32(),
      b.u64(),
      b.i8(),
      b.i16(),
      b.i32(),
      b.i64(),
      b.f32(),
      b.f64(),
      b.string(),
    )
    const value: b.infer<typeof schema> = [
      255, // u8
      65535, // u16
      4294967295, // u32
      BigInt("18446744073709551615"), // u64
      -128, // i8
      -32768, // i16
      -2147483648, // i32
      BigInt("-9223372036854775808"), // i64
      1.25, // f32
      123.456789, // f64
      "string value", // string
    ]
    const bytes = schema.serialize(value)
    const decoded = schema.deserialize(bytes)
    expect(decoded).toEqual(value)
  })

  it("handles tuples with collections", () => {
    const schema = b.tuple(b.vec(b.u8()), b.hashSet(b.string()), b.hashMap(b.string(), b.u32()))
    const value: b.infer<typeof schema> = [
      new Uint8Array([1, 2, 3]),
      new Set(["a", "b", "c"]),
      new Map([
        ["key1", 1],
        ["key2", 2],
      ]),
    ]
    const bytes = schema.serialize(value)
    const decoded = schema.deserialize(bytes)

    // Check each component separately due to complex types
    expect(new Uint8Array(decoded[0] as ArrayBuffer)).toEqual(value[0])
    expect(decoded[1]).toEqual(value[1])
    expect(decoded[2]).toEqual(value[2])
  })

  it("handles tuples with enums", () => {
    const colorEnum = b.enum({
      Red: b.unit(),
      Green: b.unit(),
      Blue: b.unit(),
      Custom: b.tuple(b.u8(), b.u8(), b.u8()),
    })
    const schema = b.tuple(colorEnum, b.string())

    const value1: b.infer<typeof schema> = [{ Red: {} }, "red color"]
    const bytes1 = schema.serialize(value1)
    const decoded1 = schema.deserialize(bytes1)
    expect(decoded1).toEqual(value1)

    const value2: b.infer<typeof schema> = [{ Custom: [255, 128, 0] }, "orange color"]
    const bytes2 = schema.serialize(value2)
    const decoded2 = schema.deserialize(bytes2)
    expect(decoded2).toEqual(value2)
  })
})
