import { describe, expect, test } from "vitest"
import { BinaryReader, BinaryWriter } from "../src/binary-io"
import { registry } from "../src/registry"
import { b } from "../src/schema"

describe("Coverage - Missing Lines", () => {
  describe("BinaryReader.getOffset()", () => {
    test("should return current offset", () => {
      const writer = new BinaryWriter()
      writer.writeUint32(42)
      writer.writeString("test")
      const buffer = writer.getBuffer()

      const reader = new BinaryReader(buffer)
      expect(reader.getOffset()).toBe(0)

      reader.readUint32()
      expect(reader.getOffset()).toBe(4)

      reader.readString()
      // String length (4 bytes) + "test" (4 bytes) = 8 bytes
      expect(reader.getOffset()).toBe(12)
    })
  })

  describe("TypedArray Coverage", () => {
    test("u32 vec returns Uint32Array", () => {
      const schema = b.vec(b.u32())
      const value = new Uint32Array([1, 2, 3, 4, 5])

      const buffer = schema.serialize(value)
      const decoded = schema.deserialize(buffer)
      expect(decoded).toBeInstanceOf(Uint32Array)
      expect(decoded).toEqual(value)
    })

    test("i8 vec returns Int8Array", () => {
      const schema = b.vec(b.i8())
      const value = new Int8Array([-1, 2, -3, 4, -5])

      const buffer = schema.serialize(value)
      const decoded = schema.deserialize(buffer)
      expect(decoded).toBeInstanceOf(Int8Array)
      expect(decoded).toEqual(value)
    })

    test("i16 vec returns Int16Array", () => {
      const schema = b.vec(b.i16())
      const value = new Int16Array([-1000, 2000, -3000, 4000])

      const buffer = schema.serialize(value)
      const decoded = schema.deserialize(buffer)
      expect(decoded).toBeInstanceOf(Int16Array)
      expect(decoded).toEqual(value)
    })

    test("i32 vec returns Int32Array", () => {
      const schema = b.vec(b.i32())
      const value = new Int32Array([-100000, 200000, -300000])

      const buffer = schema.serialize(value)
      const decoded = schema.deserialize(buffer)
      expect(decoded).toBeInstanceOf(Int32Array)
      expect(decoded).toEqual(value)
    })

    test("f64 vec returns Float64Array", () => {
      const schema = b.vec(b.f64())
      const value = new Float64Array([1.1, 2.2, 3.3, 4.4, 5.5])

      const buffer = schema.serialize(value)
      const decoded = schema.deserialize(buffer)
      expect(decoded).toBeInstanceOf(Float64Array)
      expect(decoded).toEqual(value)
    })
  })

  describe("Enum Error Cases", () => {
    test("should throw error for unknown enum variant during serialization", () => {
      const schema = b.enum({
        A: b.unit(),
        B: b.string(),
      })

      // Create an invalid enum value with a variant that doesn't exist
      const invalidValue = { UnknownVariant: {} } as unknown as { A: Record<string, never> }

      expect(() => schema.serialize(invalidValue)).toThrow("Unknown enum variant: UnknownVariant")
    })

    test("should throw error for unknown enum variant index during deserialization", () => {
      const schema = b.enum({
        A: b.unit(),
        B: b.string(),
      })

      // Create a buffer with an invalid variant index
      const writer = new BinaryWriter()
      writer.writeUint8(99) // Invalid index - only 0 and 1 are valid
      const buffer = writer.getBuffer()

      expect(() => schema.deserialize(buffer)).toThrow("Unknown enum variant index: 99")
    })
  })

  describe("Tuple Error Cases", () => {
    test("should throw error for missing type information in tuple", () => {
      // Serialize a valid tuple
      const value: [string, number, bigint] = ["test", 42, 100n]

      // Access the internal registry handler to trigger the error path
      const handler = registry.getHandler("tuple")

      // Create a types array with undefined in it
      const corruptedTypes = [
        { type: "string", options: undefined },
        undefined, // This will trigger the error
        { type: "u64", options: undefined },
      ] as unknown as Array<{ type: string; options: unknown }>

      expect(() => handler.write(new BinaryWriter(), value, corruptedTypes)).toThrow(
        "Missing type information for tuple element at index 1",
      )
    })
  })

  describe("Native Enum Error Cases", () => {
    test("should throw error for invalid native enum index during deserialization", () => {
      enum Status {
        Active = 0,
        Inactive = 1,
        Pending = 2,
      }

      const schema = b.nativeEnum(Status)

      // Create a buffer with an invalid enum index
      const writer = new BinaryWriter()
      writer.writeUint8(99) // Invalid index - only 0, 1, 2 are valid
      const buffer = writer.getBuffer()

      expect(() => schema.deserialize(buffer)).toThrow("Invalid enum index: 99")
    })
  })

  describe("Registry Error Cases", () => {
    test("should throw error for unknown type handler", () => {
      expect(() => registry.getHandler("nonexistent-type")).toThrow(
        "No handler registered for type: nonexistent-type",
      )
    })
  })

  describe("Handler Early Return Coverage", () => {
    test("struct write handler with undefined fields", () => {
      const handler = registry.getHandler("struct")
      const writer = new BinaryWriter()
      handler.write(writer, {}, undefined)
      // Should return early without writing anything
      expect(writer.getBuffer().length).toBe(0)
    })

    test("struct read handler with undefined fields", () => {
      const handler = registry.getHandler("struct")
      const reader = new BinaryReader(new Uint8Array([]))
      const result = handler.read(reader, undefined)
      expect(result).toEqual({})
    })

    test("vec write handler with undefined options", () => {
      const handler = registry.getHandler("vec")
      const writer = new BinaryWriter()
      handler.write(writer, [], undefined)
      // Should return early without writing anything
      expect(writer.getBuffer().length).toBe(0)
    })

    test("vec read handler with undefined options", () => {
      const handler = registry.getHandler("vec")
      const reader = new BinaryReader(new Uint8Array([]))
      const result = handler.read(reader, undefined)
      expect(result).toEqual([])
    })

    test("set write handler with undefined options", () => {
      const handler = registry.getHandler("set")
      const writer = new BinaryWriter()
      handler.write(writer, new Set(), undefined)
      // Should return early without writing anything
      expect(writer.getBuffer().length).toBe(0)
    })

    test("set read handler with undefined options", () => {
      const handler = registry.getHandler("set")
      const reader = new BinaryReader(new Uint8Array([]))
      const result = handler.read(reader, undefined)
      expect(result).toEqual(new Set())
    })

    test("map write handler with undefined options", () => {
      const handler = registry.getHandler("map")
      const writer = new BinaryWriter()
      handler.write(writer, new Map(), undefined)
      // Should return early without writing anything
      expect(writer.getBuffer().length).toBe(0)
    })

    test("map read handler with undefined options", () => {
      const handler = registry.getHandler("map")
      const reader = new BinaryReader(new Uint8Array([]))
      const result = handler.read(reader, undefined)
      expect(result).toEqual(new Map())
    })

    test("tuple write handler with undefined types", () => {
      const handler = registry.getHandler("tuple")
      const writer = new BinaryWriter()
      handler.write(writer, [], undefined)
      // Should return early without writing anything
      expect(writer.getBuffer().length).toBe(0)
    })

    test("tuple read handler with undefined types", () => {
      const handler = registry.getHandler("tuple")
      const reader = new BinaryReader(new Uint8Array([]))
      const result = handler.read(reader, undefined)
      expect(result).toEqual([])
    })

    test("array write handler with undefined options", () => {
      const handler = registry.getHandler("array")
      const writer = new BinaryWriter()
      handler.write(writer, [], undefined)
      // Should return early without writing anything
      expect(writer.getBuffer().length).toBe(0)
    })

    test("array read handler with undefined options", () => {
      const handler = registry.getHandler("array")
      const reader = new BinaryReader(new Uint8Array([]))
      const result = handler.read(reader, undefined)
      expect(result).toEqual([])
    })

    test("option write handler with undefined options", () => {
      const handler = registry.getHandler("option")
      const writer = new BinaryWriter()
      handler.write(writer, null, undefined)
      // Should return early without writing anything
      expect(writer.getBuffer().length).toBe(0)
    })

    test("option read handler with undefined options", () => {
      const handler = registry.getHandler("option")
      const reader = new BinaryReader(new Uint8Array([]))
      const result = handler.read(reader, undefined)
      expect(result).toBe(null)
    })

    test("enum write handler with undefined options", () => {
      const handler = registry.getHandler("enum")
      const writer = new BinaryWriter()
      handler.write(writer, {}, undefined)
      // Should return early without writing anything
      expect(writer.getBuffer().length).toBe(0)
    })

    test("enum read handler with undefined options", () => {
      const handler = registry.getHandler("enum")
      const reader = new BinaryReader(new Uint8Array([]))
      const result = handler.read(reader, undefined)
      expect(result).toEqual({})
    })

    test("nativeEnum write handler with undefined options", () => {
      const handler = registry.getHandler("nativeEnum")
      const writer = new BinaryWriter()
      handler.write(writer, 0, undefined)
      // Should return early without writing anything
      expect(writer.getBuffer().length).toBe(0)
    })

    test("nativeEnum read handler with undefined options", () => {
      const handler = registry.getHandler("nativeEnum")
      const reader = new BinaryReader(new Uint8Array([0]))
      const result = handler.read(reader, undefined)
      expect(result).toBe(null)
    })
  })
})
