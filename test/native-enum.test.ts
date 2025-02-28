// test/native-enum.test.ts
import { describe, expect, test } from "vitest"
import { b } from "../src/schema"
import type { EnumLike } from "../src/types"

describe("Native TypeScript Enum Support", () => {
  // Test numeric enum (default)
  enum NumericEnum {
    Zero = 0, // 0
    One = 1, // 1
    Two = 2, // 2
    Three = 3, // 3
  }

  // Test explicit numeric enum with non-sequential values
  enum ExplicitNumericEnum {
    Twenty = 20,
    Thirty = 30,
    Fifty = 50,
  }

  // Test string enum
  enum StringEnum {
    Red = "RED",
    Green = "GREEN",
    Blue = "BLUE",
  }

  // Test heterogeneous enum
  const HeterogeneousObj = {
    String: "string-value",
    Number: 42,
    // This is not supported, but we're testing to make sure we handle it properly
  }

  test("numeric enum serialization/deserialization", () => {
    const schema = b.nativeEnum(NumericEnum)

    // Test all variants
    const testValues = [NumericEnum.Zero, NumericEnum.One, NumericEnum.Two, NumericEnum.Three]

    for (const value of testValues) {
      const serialized = schema.serialize(value)
      const deserialized = schema.deserialize(serialized)

      expect(deserialized).toBe(value)
      // Should be a single byte for these simple enums
      expect(serialized.length).toBe(1)

      // For numeric enums, the serialized value should match the enum index, not the value
      // For example, NumericEnum.Two (value 2) should serialize as index 2 -> [2]
      // NumericEnum.Zero has index 0, One has index 1, etc.
      const valueAsNumber = value as number
      expect(serialized[0]).toBe(valueAsNumber)
    }
  })

  test("explicit numeric enum serialization/deserialization", () => {
    const schema = b.nativeEnum(ExplicitNumericEnum)

    // Test all variants
    const testValues = [
      ExplicitNumericEnum.Twenty,
      ExplicitNumericEnum.Thirty,
      ExplicitNumericEnum.Fifty,
    ]

    for (const value of testValues) {
      const serialized = schema.serialize(value)
      const deserialized = schema.deserialize(serialized)

      expect(deserialized).toBe(value)
      // Should be a single byte because we're serializing the variant index (0, 1, 2)
      // NOT the value (20, 30, 50)
      expect(serialized.length).toBe(1)

      // The index for Twenty is 0, Thirty is 1, Fifty is 2 - regardless of their values
      let expectedIndex = -1
      if (value === ExplicitNumericEnum.Twenty) expectedIndex = 0
      else if (value === ExplicitNumericEnum.Thirty) expectedIndex = 1
      else if (value === ExplicitNumericEnum.Fifty) expectedIndex = 2

      expect(serialized[0]).toBe(expectedIndex)
    }
  })

  test("string enum serialization/deserialization", () => {
    const schema = b.nativeEnum(StringEnum)

    // Test all variants
    const testValues = [StringEnum.Red, StringEnum.Green, StringEnum.Blue]

    for (const value of testValues) {
      const serialized = schema.serialize(value)
      const deserialized = schema.deserialize(serialized)

      expect(deserialized).toBe(value)
      // Should be a single byte for these simple enums
      expect(serialized.length).toBe(1)

      // The serialized value should be the index: Red=0, Green=1, Blue=2
      let expectedIndex = -1
      if (value === StringEnum.Red) expectedIndex = 0
      else if (value === StringEnum.Green) expectedIndex = 1
      else if (value === StringEnum.Blue) expectedIndex = 2

      expect(serialized[0]).toBe(expectedIndex)
    }
  })

  test("invalid enum values are rejected", () => {
    const schema = b.nativeEnum(NumericEnum)

    // @ts-expect-error - Invalid enum value
    expect(() => schema.serialize(99)).toThrow()
    // @ts-expect-error - Invalid enum value
    expect(() => schema.serialize("invalid")).toThrow()
  })

  test("mixed string/numeric enums should throw", () => {
    expect(() => b.nativeEnum(HeterogeneousObj)).toThrow()
  })

  test("enums with more than 255 variants should error", () => {
    // Create a large enum with more than 255 variants (just mock the object)
    // Create enum as a class to bypass index signature compatibility issues
    class LargeEnum implements EnumLike {
      [key: string]: string | number
      [numericKey: number]: string
    }

    const largeEnum = new LargeEnum()
    for (let i = 0; i < 256; i++) {
      largeEnum[`Variant${i}`] = i
      // Add reverse mapping to make it conform to EnumLike interface
      largeEnum[i] = `Variant${i}`
    }

    expect(() => b.nativeEnum(largeEnum)).toThrow()
  })

  test("type inference works correctly", () => {
    const schema = b.nativeEnum(StringEnum)

    // Type checking - this is compile-time verification
    type Expected = StringEnum
    type Actual = b.infer<typeof schema>

    // This assignment would fail if types don't match
    const _typecheck: Expected = {} as Actual

    // Make sure TypeScript sees StringEnum.Red as assignable to the inferred type
    const value: Actual = StringEnum.Red
    expect(value).toBe(StringEnum.Red)
  })

  test("enums in complex structures", () => {
    // Define a schema with an enum field
    const PlayerSchema = b.struct({
      name: b.string(),
      status: b.nativeEnum(NumericEnum),
      color: b.nativeEnum(StringEnum),
    })

    type Player = b.infer<typeof PlayerSchema>

    const player: Player = {
      name: "Alice",
      status: NumericEnum.Two,
      color: StringEnum.Blue,
    }

    const serialized = PlayerSchema.serialize(player)
    const deserialized = PlayerSchema.deserialize(serialized)

    expect(deserialized).toEqual(player)
    expect(deserialized.status).toBe(NumericEnum.Two)
    expect(deserialized.color).toBe(StringEnum.Blue)
  })
})
