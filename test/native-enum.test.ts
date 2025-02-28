import { describe, expect, it } from "vitest"
import { BinaryWriter } from "../src/binary-io"
import { nativeEnum } from "../src/native-enum"

describe("Native Enum Serialization/Deserialization", () => {
  it("should serialize and deserialize a simple enum", () => {
    enum TestEnum {
      A = 0,
      B = 1,
      C = 2,
    }

    const schema = nativeEnum(TestEnum)
    const serializedA = schema.serialize("A")
    const deserializedA = schema.deserialize(serializedA)
    expect(deserializedA).toBe("A")

    const serializedB = schema.serialize("B")
    const deserializedB = schema.deserialize(serializedB)
    expect(deserializedB).toBe("B")

    const serializedC = schema.serialize("C")
    const deserializedC = schema.deserialize(serializedC)
    expect(deserializedC).toBe("C")
  })

  it("should serialize and deserialize an enum with explicit values", () => {
    enum TestEnum {
      A = 10,
      B = 20,
      C = 30,
    }

    const schema = nativeEnum(TestEnum)
    const serializedA = schema.serialize("A")
    const deserializedA = schema.deserialize(serializedA)
    expect(deserializedA).toBe("A")

    const serializedB = schema.serialize("B")
    const deserializedB = schema.deserialize(serializedB)
    expect(deserializedB).toBe("B")

    const serializedC = schema.serialize("C")
    const deserializedC = schema.deserialize(serializedC)
    expect(deserializedC).toBe("C")
  })

  it("should handle out-of-order explicit values", () => {
    enum TestEnum {
      A = 5,
      B = 1,
      C = 10,
    }
    const schema = nativeEnum(TestEnum)

    const serializedA = schema.serialize("A")
    const deserializedA = schema.deserialize(serializedA)
    expect(deserializedA).toBe("A")

    const serializedB = schema.serialize("B")
    const deserializedB = schema.deserialize(serializedB)
    expect(deserializedB).toBe("B")

    const serializedC = schema.serialize("C")
    const deserializedC = schema.deserialize(serializedC)
    expect(deserializedC).toBe("C")
  })

  it("should throw an error for invalid enum values during serialization", () => {
    enum TestEnum {
      A = 0,
      B = 1,
      C = 2,
    }
    const schema = nativeEnum(TestEnum)

    expect(() => schema.serialize("D" as never)).toThrowError("Invalid enum variant: D")
  })

  it("should throw an error for invalid enum index during deserialization", () => {
    enum TestEnum {
      A = 0,
      B = 1,
      C = 2,
    }

    const schema = nativeEnum(TestEnum)
    const writer = new BinaryWriter()
    writer.writeUint8(10) // Invalid index
    const invalidBuffer = writer.getBuffer()

    expect(() => schema.deserialize(invalidBuffer)).toThrowError("Invalid enum index: 10")
  })
})
