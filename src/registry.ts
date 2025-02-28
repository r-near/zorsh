import type { BinaryReader, BinaryWriter } from "./binary-io"
import type { TypedArrayType } from "./types"

export interface TypeHandler<TValue, TOptions = unknown> {
  write: (writer: BinaryWriter, value: TValue, options?: TOptions) => void
  read: (reader: BinaryReader, options?: TOptions) => TValue
}

export class TypeRegistry {
  private handlers = new Map<string, TypeHandler<unknown, unknown>>()

  register<TValue, TOptions = unknown>(type: string, handler: TypeHandler<TValue, TOptions>): void {
    this.handlers.set(type, handler as TypeHandler<unknown, unknown>)
  }

  getHandler<TValue, TOptions = unknown>(type: string): TypeHandler<TValue, TOptions> {
    const handler = this.handlers.get(type)
    if (!handler) {
      throw new Error(`No handler registered for type: ${type}`)
    }
    return handler as TypeHandler<TValue, TOptions>
  }
}

// Create and initialize the global registry with primitive types
export const registry = new TypeRegistry()

// Register all primitive type handlers

// Unsigned integers
registry.register<number>("u8", {
  write: (writer, value) => {
    if (value < 0 || value > 255 || !Number.isInteger(value)) {
      throw new Error("Value out of range for u8")
    }
    writer.writeUint8(value)
  },
  read: (reader) => reader.readUint8(),
})

registry.register<number>("u16", {
  write: (writer, value) => {
    if (value < 0 || value > 65535 || !Number.isInteger(value)) {
      throw new Error("Value out of range for u16")
    }
    writer.writeUint16(value)
  },
  read: (reader) => reader.readUint16(),
})

registry.register<number>("u32", {
  write: (writer, value) => {
    if (value < 0 || value > 4294967295 || !Number.isInteger(value)) {
      throw new Error("Value out of range for u32")
    }
    writer.writeUint32(value)
  },
  read: (reader) => reader.readUint32(),
})

registry.register<bigint>("u64", {
  write: (writer, value) => {
    if (value < 0n || value > 18446744073709551615n) {
      throw new Error("Value out of range for u64")
    }
    writer.writeUint64(value)
  },
  read: (reader) => reader.readUint64(),
})

registry.register<bigint>("u128", {
  write: (writer, value) => {
    if (value < 0n || value > 340282366920938463463374607431768211455n) {
      throw new Error("Value out of range for u128")
    }
    writer.writeUint128(value)
  },
  read: (reader) => reader.readUint128(),
})

// Signed integers
registry.register<number>("i8", {
  write: (writer, value) => {
    if (value < -128 || value > 127 || !Number.isInteger(value)) {
      throw new Error("Value out of range for i8")
    }
    writer.writeInt8(value)
  },
  read: (reader) => reader.readInt8(),
})

registry.register<number>("i16", {
  write: (writer, value) => {
    if (value < -32768 || value > 32767 || !Number.isInteger(value)) {
      throw new Error("Value out of range for i16")
    }
    writer.writeInt16(value)
  },
  read: (reader) => reader.readInt16(),
})

registry.register<number>("i32", {
  write: (writer, value) => {
    if (value < -2147483648 || value > 2147483647 || !Number.isInteger(value)) {
      throw new Error("Value out of range for i32")
    }
    writer.writeInt32(value)
  },
  read: (reader) => reader.readInt32(),
})

registry.register<bigint>("i64", {
  write: (writer, value) => {
    if (value < -9223372036854775808n || value > 9223372036854775807n) {
      throw new Error("Value out of range for i64")
    }
    writer.writeInt64(value)
  },
  read: (reader) => reader.readInt64(),
})

registry.register<bigint>("i128", {
  write: (writer, value) => {
    if (
      value < -170141183460469231731687303715884105728n ||
      value > 170141183460469231731687303715884105727n
    ) {
      throw new Error("Value out of range for i128")
    }
    writer.writeInt128(value)
  },
  read: (reader) => reader.readInt128(),
})

// Floating point
registry.register<number>("f32", {
  write: (writer, value) => writer.writeFloat32(value),
  read: (reader) => reader.readFloat32(),
})

registry.register<number>("f64", {
  write: (writer, value) => {
    if (Number.isNaN(value)) {
      throw new Error("For portability reasons we do not allow serializing NaN values.")
    }
    writer.writeFloat64(value)
  },
  read: (reader) => reader.readFloat64(),
})

// String and unit type
registry.register<string>("string", {
  write: (writer, value) => writer.writeString(value),
  read: (reader) => reader.readString(),
})

registry.register<Record<string, never>>("unit", {
  write: () => {}, // Unit type takes up no space
  read: () => ({}),
})

// Add struct handler - handles objects with named fields
interface StructFields {
  [field: string]: {
    type: string
    options: unknown
  }
}

registry.register<Record<string, unknown>, StructFields>("struct", {
  write: (writer, value, fields) => {
    if (!fields) return
    for (const [field, def] of Object.entries(fields)) {
      const handler = registry.getHandler(def.type)
      handler.write(writer, value[field], def.options)
    }
  },
  read: (reader, fields) => {
    if (!fields) return {}
    const result: Record<string, unknown> = {}
    for (const [field, def] of Object.entries(fields)) {
      const handler = registry.getHandler(def.type)
      result[field] = handler.read(reader, def.options)
    }
    return result
  },
})

// Add Vec handler - handles dynamic-length arrays
interface VecOptions<T> {
  elementType: string
  elementOptions: T
}

registry.register<unknown[] | TypedArrayType, VecOptions<unknown>>("vec", {
  write: (writer, value, options) => {
    if (!options) return
    const { elementType, elementOptions } = options

    // Handle TypedArrays and regular arrays
    const length = ArrayBuffer.isView(value) ? value.length : value.length
    writer.writeUint32(length)

    const handler = registry.getHandler(elementType)
    if (ArrayBuffer.isView(value)) {
      for (let i = 0; i < length; i++) {
        handler.write(writer, value[i], elementOptions)
      }
    } else {
      for (const item of value) {
        handler.write(writer, item, elementOptions)
      }
    }
  },
  read: (reader, options) => {
    if (!options) return []
    const { elementType, elementOptions } = options
    const length = reader.readUint32()
    const handler = registry.getHandler(elementType)

    // Create array of raw values first
    const values = Array.from({ length }, () => handler.read(reader, elementOptions))

    // Convert to appropriate TypedArray if needed
    switch (elementType) {
      case "u8":
        return new Uint8Array(values as number[])
      case "u16":
        return new Uint16Array(values as number[])
      case "u32":
        return new Uint32Array(values as number[])
      case "i8":
        return new Int8Array(values as number[])
      case "i16":
        return new Int16Array(values as number[])
      case "i32":
        return new Int32Array(values as number[])
      case "i64":
        return new BigInt64Array(values as bigint[])
      case "f32":
        return new Float32Array(values as number[])
      case "f64":
        return new Float64Array(values as number[])
      default:
        return values
    }
  },
})

// Add HashSet handler
interface SetOptions<T> {
  elementType: string
  elementOptions: T
}

registry.register<Set<unknown>, SetOptions<unknown>>("set", {
  write: (writer, value, options) => {
    if (!options) return
    const { elementType, elementOptions } = options
    const array = Array.from(value).sort()
    writer.writeUint32(array.length)
    const handler = registry.getHandler<unknown>(elementType)
    for (const item of array) {
      handler.write(writer, item, elementOptions)
    }
  },
  read: (reader, options) => {
    if (!options) return new Set()
    const { elementType, elementOptions } = options
    const length = reader.readUint32()
    const handler = registry.getHandler<unknown>(elementType)
    const items = Array.from({ length }, () => handler.read(reader, elementOptions))
    return new Set(items)
  },
})

// Add HashMap handler
interface MapOptions<K, V> {
  keyType: string
  keyOptions: K
  valueType: string
  valueOptions: V
}

registry.register<Map<unknown, unknown>, MapOptions<unknown, unknown>>("map", {
  write: (writer, value, options) => {
    if (!options) return
    const { keyType, keyOptions, valueType, valueOptions } = options
    const entries = Array.from(value.entries()).sort()
    writer.writeUint32(entries.length)
    const keyHandler = registry.getHandler<unknown>(keyType)
    const valueHandler = registry.getHandler<unknown>(valueType)
    for (const [key, val] of entries) {
      keyHandler.write(writer, key, keyOptions)
      valueHandler.write(writer, val, valueOptions)
    }
  },
  read: (reader, options) => {
    if (!options) return new Map()
    const { keyType, keyOptions, valueType, valueOptions } = options
    const length = reader.readUint32()
    const keyHandler = registry.getHandler<unknown>(keyType)
    const valueHandler = registry.getHandler<unknown>(valueType)
    const entries = Array.from({ length }, () => {
      const key = keyHandler.read(reader, keyOptions)
      const value = valueHandler.read(reader, valueOptions)
      return [key, value] as const
    })
    return new Map(entries)
  },
})

// Add Option handler
interface OptionOptions<T> {
  valueType: string
  valueOptions: T
}

registry.register<unknown | null, OptionOptions<unknown>>("option", {
  write: (writer, value, options) => {
    if (!options) return
    const { valueType, valueOptions } = options
    const isSome = value !== null
    writer.writeUint8(isSome ? 1 : 0)
    if (isSome) {
      const handler = registry.getHandler<unknown>(valueType)
      handler.write(writer, value, valueOptions)
    }
  },
  read: (reader, options) => {
    if (!options) return null
    const { valueType, valueOptions } = options
    const isSome = reader.readUint8() === 1
    if (isSome) {
      const handler = registry.getHandler<unknown>(valueType)
      return handler.read(reader, valueOptions)
    }
    return null
  },
})

// Add enum handler
interface EnumVariant {
  index: number
  name: string
  type: string
  options: unknown
}

interface EnumOptions {
  variants: EnumVariant[]
}

registry.register<Record<string, unknown>, EnumOptions>("enum", {
  write: (writer, value, options) => {
    if (!options) return

    // Get the variant name (should be the only key in the object)
    const variantName = Object.keys(value)[0]
    // Assert variantName exists and is a string key of the value object
    const variantValue = value[variantName as keyof typeof value]

    // Find the variant definition
    const variant = options.variants.find((v) => v.name === variantName)
    if (!variant) {
      throw new Error(`Unknown enum variant: ${variantName}`)
    }

    // Write variant index
    writer.writeUint8(variant.index)

    // Write variant value if it has associated data
    if (variant.type !== "unit") {
      const handler = registry.getHandler(variant.type)
      handler.write(writer, variantValue, variant.options)
    }
  },
  read: (reader, options) => {
    if (!options) return {}

    const index = reader.readUint8()
    const variant = options.variants.find((v) => v.index === index)
    if (!variant) {
      throw new Error(`Unknown enum variant index: ${index}`)
    }

    // Return early for unit type
    if (variant.type === "unit") {
      return { [variant.name]: {} }
    }

    // Handle non-unit types
    const handler = registry.getHandler(variant.type)
    const value = handler.read(reader, variant.options)
    return { [variant.name]: value }
  },
})

// Define the type for a single tuple element's type info
interface TupleElement {
  type: string
  options: unknown
}

// The full tuple type is an array of these elements
type TupleTypes = TupleElement[]

// Add the tuple handler to the registry
registry.register<unknown[], TupleTypes>("tuple", {
  write: (writer, value, types) => {
    if (!types) return
    if (value.length !== types.length) {
      throw new Error(`Tuple length mismatch: expected ${types.length}, got ${value.length}`)
    }
    for (let i = 0; i < types.length; i++) {
      const typeInfo = types[i]
      if (!typeInfo) {
        throw new Error(`Missing type information for tuple element at index ${i}`)
      }
      const handler = registry.getHandler(typeInfo.type)
      handler.write(writer, value[i], typeInfo.options)
    }
  },
  read: (reader, types) => {
    if (!types) return []
    const result = []
    for (const type of types) {
      const handler = registry.getHandler(type.type)
      result.push(handler.read(reader, type.options))
    }
    return result
  },
})

// Add fixed-length array handler
interface ArrayOptions<T> {
  elementType: string
  elementOptions: T
  length: number
}

registry.register<unknown[], ArrayOptions<unknown>>("array", {
  write: (writer, value, options) => {
    if (!options) return
    const { elementType, elementOptions, length } = options
    if (value.length !== length) {
      throw new Error(`Array length mismatch: expected ${length}, got ${value.length}`)
    }
    const handler = registry.getHandler<unknown>(elementType)
    for (const item of value) {
      handler.write(writer, item, elementOptions)
    }
  },
  read: (reader, options) => {
    if (!options) return []
    const { elementType, elementOptions, length } = options
    const handler = registry.getHandler<unknown>(elementType)
    return Array.from({ length }, () => handler.read(reader, elementOptions))
  },
})

// Add native TypeScript enum handler
registry.register<
  unknown,
  {
    enumObj: Record<string, string | number>
    valueToIndexMap: Map<string | number, number>
    indexToValueMap: Map<number, string | number>
  }
>("nativeEnum", {
  write: (writer, value, options) => {
    if (!options) return
    const { valueToIndexMap } = options

    // Cast to string | number to satisfy TypeScript
    const enumValue = value as string | number
    const index = valueToIndexMap.get(enumValue)
    if (index === undefined) {
      throw new Error(`Invalid enum value: ${String(value)}`)
    }

    // Always encode enum variant as u8, per Borsh spec
    writer.writeUint8(index)
  },
  read: (reader, options) => {
    if (!options) return null
    const { indexToValueMap } = options

    const index = reader.readUint8()
    const value = indexToValueMap.get(index)

    if (value === undefined) {
      throw new Error(`Invalid enum index: ${index}`)
    }

    return value
  },
})
