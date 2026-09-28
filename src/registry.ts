import type { BinaryReader, BinaryWriter } from "./binary-io"

export interface TypeHandler<TValue, TOptions = unknown> {
  write: (writer: BinaryWriter, value: TValue, options?: TOptions) => void
  read: (reader: BinaryReader, options?: TOptions) => TValue
  /**
   * Total order over values of this type, mirroring Rust's `Ord` for the
   * corresponding Borsh type. Returns a negative number, zero, or a positive
   * number, like an `Array.prototype.sort` comparator.
   *
   * Borsh writes `HashMap` keys and `HashSet` elements in ascending `Ord`
   * order so that equal collections always encode to identical bytes. The
   * map and set handlers sort with this comparator to produce that order.
   */
  compare: (a: TValue, b: TValue, options?: TOptions) => number
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

// ==================== Canonical ordering helpers ====================
//
// Rust's `Ord` is the reference for every comparator below: integers and
// floats compare numerically, `bool` orders `false < true`, strings and byte
// strings compare lexicographically with a shorter prefix first, `Option`
// orders `None < Some`, and structs, tuples, and enums compare field by field
// (enums by variant index first).

/** Numeric comparison for `number` and `bigint` values. */
function compareNumeric(a: number | bigint, b: number | bigint): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Compare two strings by Unicode code point, which is the order of their
 * UTF-8 encodings and therefore Rust's `str` ordering. JavaScript's own string
 * comparison orders by UTF-16 code unit, which disagrees for characters outside
 * the Basic Multilingual Plane. Lone surrogates compare as U+FFFD, the
 * replacement character `TextEncoder` writes for them.
 */
function compareStrings(a: string, b: string): number {
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const [codePointA, lengthA] = codePointAt(a, i)
    const [codePointB, lengthB] = codePointAt(b, j)
    if (codePointA !== codePointB) return codePointA - codePointB
    i += lengthA
    j += lengthB
  }
  return a.length - i - (b.length - j)
}

/** Decode the code point at `index`, returning it with the number of UTF-16 units it spans. */
function codePointAt(value: string, index: number): [codePoint: number, length: number] {
  const unit = value.charCodeAt(index)
  if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) {
    const next = value.charCodeAt(index + 1)
    if (next >= 0xdc00 && next <= 0xdfff) {
      return [(unit - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000, 2]
    }
  }
  if (unit >= 0xd800 && unit <= 0xdfff) return [0xfffd, 1]
  return [unit, 1]
}

/** Lexicographic comparison of byte strings, shorter prefix first. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) {
    const difference = (a[i] as number) - (b[i] as number)
    if (difference !== 0) return difference
  }
  return a.length - b.length
}

/** Lexicographic comparison of sequences whose elements share one handler, shorter prefix first. */
function compareSequences(
  a: unknown[],
  b: unknown[],
  handler: TypeHandler<unknown, unknown>,
  options: unknown,
): number {
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) {
    const result = handler.compare(a[i], b[i], options)
    if (result !== 0) return result
  }
  return a.length - b.length
}

/**
 * Sort a collection into canonical Borsh order. Entries that compare equal are
 * rejected: a Rust `HashSet`/`HashMap` cannot hold them, and strict decoders
 * (borsh-rs with `de_strict_order`) reject keys that are not strictly ascending.
 */
function toCanonicalOrder<T>(
  items: Iterable<T>,
  compare: (a: T, b: T) => number,
  duplicateMessage: string,
): T[] {
  const sorted = Array.from(items).sort(compare)
  for (let i = 1; i < sorted.length; i++) {
    if (compare(sorted[i - 1] as T, sorted[i] as T) === 0) {
      throw new Error(duplicateMessage)
    }
  }
  return sorted
}

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
  compare: compareNumeric,
})

registry.register<number>("u16", {
  write: (writer, value) => {
    if (value < 0 || value > 65535 || !Number.isInteger(value)) {
      throw new Error("Value out of range for u16")
    }
    writer.writeUint16(value)
  },
  read: (reader) => reader.readUint16(),
  compare: compareNumeric,
})

registry.register<number>("u32", {
  write: (writer, value) => {
    if (value < 0 || value > 4294967295 || !Number.isInteger(value)) {
      throw new Error("Value out of range for u32")
    }
    writer.writeUint32(value)
  },
  read: (reader) => reader.readUint32(),
  compare: compareNumeric,
})

registry.register<bigint>("u64", {
  write: (writer, value) => {
    if (value < 0n || value > 18446744073709551615n) {
      throw new Error("Value out of range for u64")
    }
    writer.writeUint64(value)
  },
  read: (reader) => reader.readUint64(),
  compare: compareNumeric,
})

registry.register<bigint>("u128", {
  write: (writer, value) => {
    if (value < 0n || value > 340282366920938463463374607431768211455n) {
      throw new Error("Value out of range for u128")
    }
    writer.writeUint128(value)
  },
  read: (reader) => reader.readUint128(),
  compare: compareNumeric,
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
  compare: compareNumeric,
})

registry.register<number>("i16", {
  write: (writer, value) => {
    if (value < -32768 || value > 32767 || !Number.isInteger(value)) {
      throw new Error("Value out of range for i16")
    }
    writer.writeInt16(value)
  },
  read: (reader) => reader.readInt16(),
  compare: compareNumeric,
})

registry.register<number>("i32", {
  write: (writer, value) => {
    if (value < -2147483648 || value > 2147483647 || !Number.isInteger(value)) {
      throw new Error("Value out of range for i32")
    }
    writer.writeInt32(value)
  },
  read: (reader) => reader.readInt32(),
  compare: compareNumeric,
})

registry.register<bigint>("i64", {
  write: (writer, value) => {
    if (value < -9223372036854775808n || value > 9223372036854775807n) {
      throw new Error("Value out of range for i64")
    }
    writer.writeInt64(value)
  },
  read: (reader) => reader.readInt64(),
  compare: compareNumeric,
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
  compare: compareNumeric,
})

// Floating point
registry.register<number>("f32", {
  write: (writer, value) => writer.writeFloat32(value),
  read: (reader) => reader.readFloat32(),
  // Compare the values as they are written: two numbers that round to the same
  // float32 are the same element on the wire.
  compare: (a, b) => compareNumeric(Math.fround(a), Math.fround(b)),
})

registry.register<number>("f64", {
  write: (writer, value) => {
    if (Number.isNaN(value)) {
      throw new Error("For portability reasons we do not allow serializing NaN values.")
    }
    writer.writeFloat64(value)
  },
  read: (reader) => reader.readFloat64(),
  compare: compareNumeric,
})

// Boolean, string and unit type
registry.register<boolean>("bool", {
  write: (writer, value) => writer.writeBool(value),
  read: (reader) => reader.readBool(),
  compare: (a, b) => Number(a) - Number(b),
})

registry.register<string>("string", {
  write: (writer, value) => writer.writeString(value),
  read: (reader) => reader.readString(),
  compare: compareStrings,
})

registry.register<Record<string, never>>("unit", {
  write: () => {}, // Unit type takes up no space
  read: () => ({}),
  compare: () => 0,
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
  compare: (a, b, fields) => {
    if (!fields) return 0
    for (const [field, def] of Object.entries(fields)) {
      const handler = registry.getHandler(def.type)
      const result = handler.compare(a[field], b[field], def.options)
      if (result !== 0) return result
    }
    return 0
  },
})

// Add Vec handler - handles dynamic-length arrays
interface VecOptions<T> {
  elementType: string
  elementOptions: T
}

registry.register<unknown[], VecOptions<unknown>>("vec", {
  write: (writer, value, options) => {
    if (!options) return
    const { elementType, elementOptions } = options

    const length = value.length
    writer.writeUint32(length)

    const handler = registry.getHandler(elementType)
    for (const item of value) {
      handler.write(writer, item, elementOptions)
    }
  },
  read: (reader, options) => {
    if (!options) return []
    const { elementType, elementOptions } = options
    const length = reader.readUint32()
    const handler = registry.getHandler(elementType)

    return Array.from({ length }, () => handler.read(reader, elementOptions))
  },
  compare: (a, b, options) => {
    if (!options) return 0
    const { elementType, elementOptions } = options
    return compareSequences(a, b, registry.getHandler(elementType), elementOptions)
  },
})

// Add HashSet handler
interface SetOptions<T> {
  elementType: string
  elementOptions: T
}

function canonicalSetElements(value: Set<unknown>, options: SetOptions<unknown>): unknown[] {
  const { elementType, elementOptions } = options
  const handler = registry.getHandler<unknown>(elementType)
  return toCanonicalOrder(
    value,
    (a, b) => handler.compare(a, b, elementOptions),
    "hashSet contains elements that compare equal; Borsh requires strictly ascending elements",
  )
}

registry.register<Set<unknown>, SetOptions<unknown>>("set", {
  write: (writer, value, options) => {
    if (!options) return
    const { elementType, elementOptions } = options
    const array = canonicalSetElements(value, options)
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
  compare: (a, b, options) => {
    if (!options) return 0
    const { elementType, elementOptions } = options
    return compareSequences(
      canonicalSetElements(a, options),
      canonicalSetElements(b, options),
      registry.getHandler(elementType),
      elementOptions,
    )
  },
})

// Add HashMap handler
interface MapOptions<K, V> {
  keyType: string
  keyOptions: K
  valueType: string
  valueOptions: V
}

function canonicalMapEntries(
  value: Map<unknown, unknown>,
  options: MapOptions<unknown, unknown>,
): [unknown, unknown][] {
  const { keyType, keyOptions } = options
  const keyHandler = registry.getHandler<unknown>(keyType)
  return toCanonicalOrder(
    value.entries(),
    ([a], [b]) => keyHandler.compare(a, b, keyOptions),
    "hashMap contains keys that compare equal; Borsh requires strictly ascending keys",
  )
}

registry.register<Map<unknown, unknown>, MapOptions<unknown, unknown>>("map", {
  write: (writer, value, options) => {
    if (!options) return
    const { keyType, keyOptions, valueType, valueOptions } = options
    const entries = canonicalMapEntries(value, options)
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
  compare: (a, b, options) => {
    if (!options) return 0
    const { keyType, keyOptions, valueType, valueOptions } = options
    const keyHandler = registry.getHandler<unknown>(keyType)
    const valueHandler = registry.getHandler<unknown>(valueType)
    const entriesA = canonicalMapEntries(a, options)
    const entriesB = canonicalMapEntries(b, options)
    const length = Math.min(entriesA.length, entriesB.length)
    for (let i = 0; i < length; i++) {
      const [keyA, valueA] = entriesA[i] as [unknown, unknown]
      const [keyB, valueB] = entriesB[i] as [unknown, unknown]
      const keyResult = keyHandler.compare(keyA, keyB, keyOptions)
      if (keyResult !== 0) return keyResult
      const valueResult = valueHandler.compare(valueA, valueB, valueOptions)
      if (valueResult !== 0) return valueResult
    }
    return entriesA.length - entriesB.length
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
  compare: (a, b, options) => {
    if (a === null || b === null) return Number(a !== null) - Number(b !== null)
    if (!options) return 0
    const { valueType, valueOptions } = options
    return registry.getHandler<unknown>(valueType).compare(a, b, valueOptions)
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

/** Resolve the variant an enum value uses (its single key) and the payload stored under it. */
function resolveEnumVariant(
  value: Record<string, unknown>,
  options: EnumOptions,
): { variant: EnumVariant; payload: unknown } {
  // Get the variant name (should be the only key in the object)
  const variantName = Object.keys(value)[0]
  // Assert variantName exists and is a string key of the value object
  const payload = value[variantName as keyof typeof value]

  // Find the variant definition
  const variant = options.variants.find((v) => v.name === variantName)
  if (!variant) {
    throw new Error(`Unknown enum variant: ${variantName}`)
  }
  return { variant, payload }
}

registry.register<Record<string, unknown>, EnumOptions>("enum", {
  write: (writer, value, options) => {
    if (!options) return

    const { variant, payload: variantValue } = resolveEnumVariant(value, options)

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
  compare: (a, b, options) => {
    if (!options) return 0
    const left = resolveEnumVariant(a, options)
    const right = resolveEnumVariant(b, options)
    if (left.variant.index !== right.variant.index) {
      return left.variant.index - right.variant.index
    }
    if (left.variant.type === "unit") return 0
    const handler = registry.getHandler(left.variant.type)
    return handler.compare(left.payload, right.payload, left.variant.options)
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
  compare: (a, b, types) => {
    if (!types) return 0
    for (let i = 0; i < types.length; i++) {
      const typeInfo = types[i]
      if (!typeInfo) {
        throw new Error(`Missing type information for tuple element at index ${i}`)
      }
      const handler = registry.getHandler(typeInfo.type)
      const result = handler.compare(a[i], b[i], typeInfo.options)
      if (result !== 0) return result
    }
    return 0
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
  compare: (a, b, options) => {
    if (!options) return 0
    const { elementType, elementOptions } = options
    return compareSequences(a, b, registry.getHandler(elementType), elementOptions)
  },
})

// Add bytes handler - handles raw byte sequences as Uint8Array
export interface BytesOptions {
  length?: number
}

registry.register<Uint8Array, BytesOptions>("bytes", {
  write: (writer, value, options) => {
    const length = value.length

    if (options?.length != null) {
      if (length !== options.length) {
        throw new Error(`Bytes length mismatch: expected ${options.length}, got ${length}`)
      }
      for (let i = 0; i < length; i++) {
        writer.writeUint8(value[i] as number)
      }
    } else {
      writer.writeUint32(length)
      for (let i = 0; i < length; i++) {
        writer.writeUint8(value[i] as number)
      }
    }
  },
  read: (reader, options) => {
    const length = options?.length != null ? options.length : reader.readUint32()
    const bytes = new Uint8Array(length)
    for (let i = 0; i < length; i++) {
      bytes[i] = reader.readUint8()
    }
    return bytes
  },
  compare: compareBytes,
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
  compare: (a, b, options) => {
    if (!options) return 0
    const { valueToIndexMap } = options
    const indexA = valueToIndexMap.get(a as string | number)
    const indexB = valueToIndexMap.get(b as string | number)
    if (indexA === undefined) throw new Error(`Invalid enum value: ${String(a)}`)
    if (indexB === undefined) throw new Error(`Invalid enum value: ${String(b)}`)
    return indexA - indexB
  },
})

// Add lazy handler - enables recursive/self-referential schemas
interface LazyOptions {
  factory: () => { type: string; options: unknown }
  _cached?: { type: string; options: unknown }
}

function resolveLazy(options: LazyOptions): { type: string; options: unknown } {
  if (!options._cached) {
    const resolved = options.factory()
    options._cached = { type: resolved.type, options: resolved.options }
  }
  return options._cached
}

registry.register<unknown, LazyOptions>("lazy", {
  write: (writer, value, options) => {
    if (!options) return
    const resolved = resolveLazy(options)
    const handler = registry.getHandler(resolved.type)
    handler.write(writer, value, resolved.options)
  },
  read: (reader, options) => {
    if (!options) return undefined
    const resolved = resolveLazy(options)
    const handler = registry.getHandler(resolved.type)
    return handler.read(reader, resolved.options)
  },
})
