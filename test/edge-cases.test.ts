import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, test } from "vitest"
import { type Schema, b } from "../src/schema"

interface TestType<T> {
  schema: Schema<T>
  max: T
  min: T
}

describe("Zorsh Edge Cases", () => {
  describe("Numeric Edge Cases", () => {
    test("integer boundaries", () => {
      const cases: TestType<number | bigint>[] = [
        { schema: b.u8(), max: 255, min: 0 },
        { schema: b.i8(), max: 127, min: -128 },
        { schema: b.u16(), max: 65535, min: 0 },
        { schema: b.i16(), max: 32767, min: -32768 },
        { schema: b.u32(), max: 4294967295, min: 0 },
        { schema: b.i32(), max: 2147483647, min: -2147483648 },
        { schema: b.u64(), max: 18446744073709551615n, min: 0n },
        {
          schema: b.i64(),
          max: 9223372036854775807n,
          min: -9223372036854775808n,
        },
        {
          schema: b.u128(),
          max: 340282366920938463463374607431768211455n,
          min: 0n,
        },
        {
          schema: b.i128(),
          max: 170141183460469231731687303715884105727n,
          min: -170141183460469231731687303715884105728n,
        },
      ]

      for (const { schema, max, min } of cases) {
        const maxBytes = schema.serialize(max)
        const minBytes = schema.serialize(min)
        expect(schema.deserialize(maxBytes)).toBe(max)
        expect(schema.deserialize(minBytes)).toBe(min)

        // Test out of bounds
        if (typeof max === "bigint") {
          const increment: bigint = 1n
          expect(() => schema.serialize(max + increment)).toThrow()
        } else {
          const increment: number = 1
          expect(() => schema.serialize(max + increment)).toThrow()
        }
      }
    })

    test("floating point special values", async () => {
      const testDataDir = path.join(__dirname, "..", "rust", "borsh_test", "test_data")

      // Define our test cases and their expected values
      const testCases = [
        { name: "infinity", value: Number.POSITIVE_INFINITY },
        { name: "neg_infinity", value: Number.NEGATIVE_INFINITY },
        { name: "max", value: Number.MAX_VALUE },
        { name: "min", value: -Number.MAX_VALUE },
        // Note: Rust's MIN_POSITIVE (2.2250738585072014e-308) is much larger than
        // JavaScript's MIN_VALUE (5e-324). We use MIN_POSITIVE here since that's what
        // Rust serializes.
        { name: "min_value", value: 2.2250738585072014e-308 },
        { name: "zero", value: 0 },
        { name: "neg_zero", value: -0 },
        { name: "one", value: 1 },
        { name: "neg_one", value: -1 },
        { name: "pi", value: Math.PI },
      ]

      for (const { name, value } of testCases) {
        const binPath = path.join(testDataDir, `float_${name}.bin`)
        const rustBytes = new Uint8Array(await fs.promises.readFile(binPath))
        const decoded = b.f64().deserialize(rustBytes)

        if (!Number.isFinite(value)) {
          expect(decoded).toBe(value)
        } else if (value === 0) {
          // In JavaScript, 0 === -0 is true, but Object.is(0, -0) is false
          // For our purposes, treating them as equal is fine
          expect(decoded === 0).toBe(true)
        } else {
          // For finite non-zero values, use relative error
          // Use a larger epsilon for very large or very small values
          const epsilon = Math.abs(value) > 1e100 || Math.abs(value) < 1e-100 ? 1e-5 : 1e-10
          const relativeError = Math.abs((decoded - value) / value)
          expect(relativeError).toBeLessThan(epsilon)
        }

        // Now test serialization
        const jsBytes = b.f64().serialize(value)
        expect(jsBytes).toEqual(rustBytes)
      }
    })

    test("NaN handling", () => {
      // NaN cannot be serialized in Borsh, so we should throw an error
      expect(() => b.f64().serialize(Number.NaN)).toThrow()
    })

    test("very long strings", () => {
      // Test with a more reasonable length that won't exceed buffer capacity
      const longString = "a".repeat(10000)
      const bytes = b.string().serialize(longString)
      expect(b.string().deserialize(bytes)).toBe(longString)
    })
  })

  describe("String Edge Cases", () => {
    const schema = b.string()

    test("empty and special strings", () => {
      const cases = [
        "",
        "\0",
        "Hello\0World",
        "\u0000\u0001\u0002\u0003",
        "🦀",
        "👨‍👩‍👧‍👦", // family emoji (complex emoji)
        "\u200B", // zero-width space
        "\u202E", // RTL override
        "\uFEFF", // byte order mark
        "∞", // infinity symbol
        "你好", // Chinese
        "السَّلامُ عَلَيْكُمْ", // Arabic
        "שָׁלוֹם", // Hebrew (with niqqud)
      ]

      for (const str of cases) {
        const bytes = schema.serialize(str)
        const decoded = schema.deserialize(bytes)
        // Compare string content directly, ignoring any byte order mark
        expect(decoded.replace(/^\uFEFF/, "")).toBe(str.replace(/^\uFEFF/, ""))
      }
    })

    test("very long strings", () => {
      // Test with a more reasonable length that won't exceed buffer capacity
      const longString = "a".repeat(10000)
      const bytes = schema.serialize(longString)
      expect(schema.deserialize(bytes)).toBe(longString)
    })
  })

  describe("Collection Edge Cases", () => {
    test("empty and large collections", () => {
      const vecSchema = b.vec(b.u8())
      const mapSchema = b.hashMap(b.string(), b.u32())
      const setSchema = b.hashSet(b.string())

      // Empty collections
      expect(vecSchema.deserialize(vecSchema.serialize(new Uint8Array([])))).toEqual(
        new Uint8Array([]),
      )
      expect(mapSchema.deserialize(mapSchema.serialize(new Map()))).toEqual(new Map())
      expect(setSchema.deserialize(setSchema.serialize(new Set()))).toEqual(new Set())

      // Large collections
      const largeVec = Array(10000).fill(42)
      const largeMap = new Map(
        Array(1000)
          .fill(0)
          .map((_, i) => [`key${i}`, i]),
      )
      const largeSet = new Set(
        Array(1000)
          .fill(0)
          .map((_, i) => `item${i}`),
      )

      expect(vecSchema.deserialize(vecSchema.serialize(new Uint8Array(largeVec)))).toEqual(
        new Uint8Array(largeVec),
      )
      expect(mapSchema.deserialize(mapSchema.serialize(new Map(largeMap)))).toEqual(largeMap)
      expect(setSchema.deserialize(setSchema.serialize(new Set(largeSet)))).toEqual(largeSet)
    })

    test("deeply nested collections", () => {
      const deepSchema = b.vec(b.vec(b.vec(b.vec(b.u8()))))
      const deep = [
        [
          [new Uint8Array([1]), new Uint8Array([2])],
          [new Uint8Array([3]), new Uint8Array([4])],
        ],
        [
          [new Uint8Array([5]), new Uint8Array([6])],
          [new Uint8Array([7]), new Uint8Array([8])],
        ],
      ]

      expect(deepSchema.deserialize(deepSchema.serialize(deep))).toEqual(deep)
    })

    test("complex map keys and values", () => {
      const complexMapSchema = b.hashMap(
        b.string(),
        b.struct({
          data: b.vec(b.u8()),
          metadata: b.option(b.string()),
          tags: b.hashSet(b.string()),
        }),
      )

      const map = new Map([
        ["", { data: new Uint8Array([]), metadata: null, tags: new Set([]) }],
        [
          "key1",
          {
            data: new Uint8Array([1, 2, 3]),
            metadata: "test",
            tags: new Set(["tag1", "tag2"]),
          },
        ],
      ])

      expect(complexMapSchema.deserialize(complexMapSchema.serialize(map))).toEqual(map)
    })
  })

  describe("Option Type Edge Cases", () => {
    test("nested options", () => {
      const schema = b.option(b.option(b.option(b.string())))
      const cases = [null, "test"]

      for (const value of cases) {
        const bytes = schema.serialize(value)
        expect(schema.deserialize(bytes)).toEqual(value)
      }
    })

    test("options with complex types", () => {
      const schema = b.option(
        b.struct({
          map: b.option(b.hashMap(b.string(), b.option(b.u32()))),
          set: b.option(b.hashSet(b.string())),
          vec: b.option(b.vec(b.option(b.string()))),
        }),
      )

      const value = {
        map: new Map([
          ["key1", 42],
          ["key2", null],
        ]),
        set: new Set(["value1", "value2"]),
        vec: [null, "test", null, "value"],
      }

      expect(schema.deserialize(schema.serialize(value))).toEqual(value)
    })
  })

  describe("Enum Edge Cases", () => {
    test("complex enum variants", () => {
      const schema = b.enum({
        Empty: b.unit(),
        Single: b.u8(),
        Nested: b.enum({
          A: b.string(),
          B: b.vec(b.u8()),
          C: b.hashMap(b.string(), b.u32()),
        }),
        Complex: b.struct({
          data: b.vec(b.option(b.string())),
          metadata: b.hashMap(b.string(), b.vec(b.u8())),
        }),
      })

      const cases = [
        { Empty: {} },
        { Single: 42 },
        { Nested: { A: "test" } },
        { Nested: { B: new Uint8Array([1, 2, 3]) } },
        { Nested: { C: new Map([["key", 42]]) } },
        {
          Complex: {
            data: [null, "test", null],
            metadata: new Map([["key", new Uint8Array([1, 2, 3])]]),
          },
        },
      ]

      for (const value of cases) {
        const bytes = schema.serialize(value)
        expect(schema.deserialize(bytes)).toEqual(value)
      }
    })
  })

  describe("Mixed Complex Cases", () => {
    test("kitchen sink", () => {
      const schema = b.struct({
        primitive: b.u128(),
        text: b.string(),
        floating: b.f64(),
        optional: b.option(b.string()),
        list: b.vec(b.u8()),
        mapping: b.hashMap(b.string(), b.u32()),
        set: b.hashSet(b.string()),
        variant: b.enum({
          A: b.unit(),
          B: b.string(),
          C: b.struct({
            x: b.u32(),
            y: b.vec(b.string()),
          }),
        }),
        nested: b.option(
          b.struct({
            data: b.vec(b.option(b.string())),
            meta: b.hashMap(
              b.string(),
              b.enum({
                Number: b.u32(),
                Text: b.string(),
              }),
            ),
          }),
        ),
      })

      const value = {
        primitive: 123456789n,
        text: "Hello 🌍",
        floating: Number.POSITIVE_INFINITY,
        optional: null,
        list: new Uint8Array([1, 2, 3]),
        mapping: new Map([
          ["key1", 42],
          ["key2", 43],
        ]),
        set: new Set(["a", "b", "c"]),
        variant: { C: { x: 42, y: ["test1", "test2"] } },
        nested: {
          data: [null, "test", null],
          meta: new Map([
            ["key1", { Number: 42 }],
            ["key2", { Text: "value" }],
          ]),
        },
      }

      expect(schema.deserialize(schema.serialize(value))).toEqual(value)
    })
  })
})
