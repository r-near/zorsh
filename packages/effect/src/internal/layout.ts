import { HashMap, HashSet, Option, Order, Result } from "effect"
import { BinaryError, checkMaxLength, prepend, type Reader, utf8Length, type Writer } from "./io.js"

export interface Layout {
  readonly minBytes: number
  readonly isZeroSized: boolean
  readonly compare?: (left: unknown, right: unknown) => number
  read(reader: Reader): unknown
  write(writer: Writer, value: unknown): void
}

/** A layout with Rust ordering, usable as a map key or set member. */
export interface Key extends Layout {
  readonly compare: (left: unknown, right: unknown) => number
}

type IntegerBits = 8 | 16 | 32 | 64 | 128

/** Rust's inclusive iN/uN bounds. */
export function integerRange(bits: IntegerBits, signed: boolean) {
  const minimum = signed ? -(1n << BigInt(bits - 1)) : 0n
  const maximum = (1n << BigInt(signed ? bits - 1 : bits)) - 1n
  return { minimum, maximum }
}

/** Native DataView access; up to 32 bits as a number, wider as a bigint. */
export function integer(bits: IntegerBits, signed: boolean): Layout {
  return bits <= 32 ? numberInteger(bits, signed) : bigintInteger(bits, signed)
}

function numberInteger(bits: IntegerBits, signed: boolean): Layout {
  const width = bits / 8
  const name = `${signed ? "i" : "u"}${bits}`
  const range = integerRange(bits, signed)
  const minimum = Number(range.minimum)
  const maximum = Number(range.maximum)
  return {
    compare: comparePrimitive,
    minBytes: width,
    isZeroSized: false,
    read: (r) => {
      const offset = r.advance(width)
      const view = r.view
      if (bits === 8) {
        return signed ? view.getInt8(offset) : view.getUint8(offset)
      }
      if (bits === 16) {
        return signed ? view.getInt16(offset, true) : view.getUint16(offset, true)
      }
      return signed ? view.getInt32(offset, true) : view.getUint32(offset, true)
    },
    write: (w, value) => {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new BinaryError(w.offset, `Expected ${name}`)
      }
      if (value < minimum || value > maximum) {
        throw new BinaryError(w.offset, `Integer outside ${name} range`)
      }
      // Unsigned setters wrap negative values to the same two's complement bytes.
      const offset = w.advance(width)
      if (bits === 8) {
        w.view.setUint8(offset, value)
      } else if (bits === 16) {
        w.view.setUint16(offset, value, true)
      } else {
        w.view.setUint32(offset, value, true)
      }
    },
  }
}

/** 64-bit values are one BigInt64; 128-bit values are two little-endian 64-bit halves. */
function bigintInteger(bits: IntegerBits, signed: boolean): Layout {
  const width = bits / 8
  const name = `${signed ? "i" : "u"}${bits}`
  const { minimum, maximum } = integerRange(bits, signed)
  return {
    compare: comparePrimitive,
    minBytes: width,
    isZeroSized: false,
    read: (r) => {
      const offset = r.advance(width)
      const view = r.view
      if (bits === 64) {
        return signed ? view.getBigInt64(offset, true) : view.getBigUint64(offset, true)
      }
      const high = signed ? view.getBigInt64(offset + 8, true) : view.getBigUint64(offset + 8, true)
      return (high << 64n) | view.getBigUint64(offset, true)
    },
    write: (w, value) => {
      if (typeof value !== "bigint") {
        throw new BinaryError(w.offset, `Expected ${name}`)
      }
      if (value < minimum || value > maximum) {
        throw new BinaryError(w.offset, `Integer outside ${name} range`)
      }
      // BigUint64 setters take the value modulo 2^64, so signed halves need no special case.
      const offset = w.advance(width)
      w.view.setBigUint64(offset, value, true)
      if (bits === 128) {
        w.view.setBigUint64(offset + 8, value >> 64n, true)
      }
    },
  }
}

export function float(bits: 32 | 64): Layout {
  return {
    minBytes: bits / 8,
    isZeroSized: false,
    read: (r) => {
      const offset = r.advance(bits / 8)
      const value = bits === 32 ? r.view.getFloat32(offset, true) : r.view.getFloat64(offset, true)
      if (Number.isNaN(value)) {
        throw new BinaryError(offset, "Borsh forbids NaN")
      }
      return value
    },
    write: (w, value) => {
      if (
        typeof value !== "number" ||
        Number.isNaN(value) ||
        (bits === 32 && !Object.is(Math.fround(value), value))
      ) {
        throw new BinaryError(w.offset, `Expected exact non-NaN f${bits}`)
      }
      const offset = w.advance(bits / 8)
      if (bits === 32) {
        w.view.setFloat32(offset, value, true)
      } else {
        w.view.setFloat64(offset, value, true)
      }
    },
  }
}

export const boolean: Layout = {
  compare: comparePrimitive,
  minBytes: 1,
  isZeroSized: false,
  read: (r) => {
    const offset = r.offset
    const value = r.u8()
    if (value > 1) {
      throw new BinaryError(offset, `Invalid bool tag ${value}`)
    }
    return value === 1
  },
  write: (w, value) => {
    if (typeof value !== "boolean") {
      throw new BinaryError(w.offset, "Expected boolean")
    }
    w.u8(value ? 1 : 0)
  },
}

export function string(maxLength: number): Layout {
  return {
    compare: compareString,
    minBytes: 4,
    isZeroSized: false,
    read: (r) => {
      const offset = r.offset
      const length = r.u32()
      checkMaxLength(length, maxLength, offset)
      return r.string(length)
    },
    write: (w, value) => {
      if (typeof value !== "string") {
        throw new BinaryError(w.offset, "Expected string")
      }
      const offset = w.offset
      const length = utf8Length(value)
      if (length < 0) {
        throw new BinaryError(offset, "Lone UTF-16 surrogate")
      }
      checkMaxLength(length, maxLength, offset)
      w.ensure(4 + length)
      w.u32(length)
      w.string(value, length)
    },
  }
}

/** Rust Vec<u8>: a u32 length, then the bytes. */
export function bytes(maxLength: number): Layout {
  return {
    minBytes: 4,
    isZeroSized: false,
    read: (r) => {
      const offset = r.offset
      const length = r.u32()
      checkMaxLength(length, maxLength, offset)
      return r.take(length).slice()
    },
    write: (w, value) => {
      if (!(value instanceof Uint8Array)) {
        throw new BinaryError(w.offset, "Expected Uint8Array")
      }
      const length = value.byteLength
      if (length > 0xffff_ffff) {
        throw new BinaryError(w.offset, "Byte array exceeds u32 length")
      }
      checkMaxLength(length, maxLength, w.offset)
      // Reserve the prefix with the payload, so an oversized array fails at the prefix offset.
      w.ensure(4 + length)
      w.u32(length)
      w.bytes(value)
    },
  }
}

/** Rust [u8; N]: exactly length bytes, with no prefix. */
export function fixedBytes(length: number): Layout {
  return {
    minBytes: length,
    isZeroSized: length === 0,
    read: (r) => r.take(length).slice(),
    write: (w, value) => {
      if (!(value instanceof Uint8Array)) {
        throw new BinaryError(w.offset, "Expected Uint8Array")
      }
      if (value.byteLength !== length) {
        throw new BinaryError(w.offset, `Expected ${length} bytes`)
      }
      w.bytes(value)
    },
  }
}

function comparePrimitive(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") {
    return Order.Number(a, b)
  }
  if (typeof a === "bigint" && typeof b === "bigint") {
    return Order.BigInt(a, b)
  }
  if (typeof a === "boolean" && typeof b === "boolean") {
    return Order.Boolean(a, b)
  }
  throw new BinaryError(0, "Expected ordered primitive")
}

/** Rust orders str by UTF-8 bytes, which is Unicode scalar order rather than UTF-16 order. */
function compareString(a: unknown, b: unknown): number {
  if (typeof a !== "string" || typeof b !== "string") {
    throw new BinaryError(0, "Expected string key")
  }
  // One index serves both strings: it only moves past equal code points, which have equal width.
  let i = 0
  while (i < a.length && i < b.length) {
    const left = a.codePointAt(i) as number
    const right = b.codePointAt(i) as number
    if (left !== right) {
      return left < right ? -1 : 1
    }
    i += left > 0xffff ? 2 : 1
  }
  // One string is a prefix of the other, so the shorter sorts first.
  return a.length - b.length
}

export interface Field {
  readonly name: string | number
  readonly layout: Layout
}

/** A Rust struct: fields in declaration order. */
export function struct(fields: ReadonlyArray<Field>): Layout {
  // Assignment would hit an inherited setter or a frozen inherited property. Checked once here:
  // Effect's schema pass, which runs next, assigns plainly too.
  const entries = fields.map((field) => ({ ...field, define: field.name in Object.prototype }))
  return {
    minBytes: sum(fields, (field) => field.layout.minBytes),
    isZeroSized: fields.every((field) => field.layout.isZeroSized),
    read: (r) => {
      const value: Record<PropertyKey, unknown> = {}
      let name: string | number = ""
      try {
        for (const field of entries) {
          name = field.name
          const item = field.layout.read(r)
          if (field.define) {
            defineField(value, name, item)
          } else {
            value[name] = item
          }
        }
      } catch (error) {
        throw prepend(error, name)
      }
      return value
    },
    write: (w, value) => {
      if (entries.length === 0) {
        return
      }
      if (typeof value !== "object" || value === null) {
        throw new BinaryError(w.offset, "Expected object")
      }
      let name: string | number = ""
      try {
        for (const field of entries) {
          name = field.name
          if (!Object.hasOwn(value, name)) {
            throw new BinaryError(w.offset, "Missing required field")
          }
          field.layout.write(w, Reflect.get(value, name))
        }
      } catch (error) {
        throw prepend(error, name)
      }
    },
  }
}

/** Define an own data property where assignment would reach Object.prototype. */
function defineField(target: object, name: PropertyKey, value: unknown): void {
  Object.defineProperty(target, name, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

export function tuple(items: ReadonlyArray<Layout>): Layout {
  return {
    minBytes: sum(items, (item) => item.minBytes),
    isZeroSized: items.every((item) => item.isZeroSized),
    read: (r) => {
      const value: unknown[] = []
      let i = 0
      try {
        for (const item of items) {
          value.push(item.read(r))
          i++
        }
      } catch (error) {
        throw prepend(error, i)
      }
      return value
    },
    write: (w, value) => {
      if (!Array.isArray(value) || value.length !== items.length) {
        throw new BinaryError(w.offset, `Expected tuple of length ${items.length}`)
      }
      let i = 0
      try {
        for (const item of items) {
          item.write(w, value[i])
          i++
        }
      } catch (error) {
        throw prepend(error, i)
      }
    },
  }
}

/** Rust Vec<T>. Zero-sized items are rejected when visited, as borsh-rs does. */
export function vector(item: Layout, maxLength: number): Layout {
  const rejectZeroSizedItem = (offset: number) => {
    if (item.isZeroSized) {
      throw new BinaryError(offset, "Borsh forbids vectors of zero-sized values")
    }
  }
  return {
    minBytes: 4,
    isZeroSized: false,
    read: (r) => {
      rejectZeroSizedItem(r.offset)
      const offset = r.offset
      const count = r.u32()
      checkMaxLength(count, maxLength, offset)
      r.charge(count, offset)
      // Each item needs at least minBytes, so reject an impossible count before allocating.
      if (count > Math.floor((r.end - r.offset) / item.minBytes)) {
        throw r.pastEnd(r.offset, count * item.minBytes, "Truncated vector payload")
      }
      return readItems(r, item, count)
    },
    write: (w, value) => {
      rejectZeroSizedItem(w.offset)
      if (!Array.isArray(value) || value.length > 0xffff_ffff) {
        throw new BinaryError(w.offset, "Expected array with u32 length")
      }
      checkMaxLength(value.length, maxLength, w.offset)
      w.charge(value.length, w.offset)
      w.u32(value.length)
      writeItems(w, item, value)
    },
  }
}

/** Rust [T; N], without a count prefix. Every read and write charges all N items to maxItems. */
export function array(item: Layout, length: number): Layout {
  // Nested fixed arrays can multiply past 2^53, so clamp to stay a safe integer.
  const minBytes = length === 0 ? 0 : Math.min(Number.MAX_SAFE_INTEGER, length * item.minBytes)
  return {
    minBytes,
    isZeroSized: length === 0 || item.isZeroSized,
    read: (r) => {
      // Zero-sized items cost no bytes, so maxItems is the only bound on how many a read visits.
      r.charge(length, r.offset)
      if (minBytes > r.end - r.offset) {
        throw r.pastEnd(r.offset, minBytes, "Truncated fixed array payload")
      }
      return readItems(r, item, length)
    },
    write: (w, value) => {
      if (!Array.isArray(value) || value.length !== length) {
        throw new BinaryError(w.offset, `Expected fixed array of length ${length}`)
      }
      w.charge(length, w.offset)
      w.ensure(minBytes)
      let i = 0
      try {
        for (; i < length; i++) {
          item.write(w, value[i])
        }
      } catch (error) {
        throw prepend(error, i)
      }
    },
  }
}

function readItems(r: Reader, item: Layout, count: number): unknown[] {
  const value: unknown[] = []
  let i = 0
  try {
    for (; i < count; i++) {
      value.push(item.read(r))
    }
  } catch (error) {
    throw prepend(error, i)
  }
  return value
}

function writeItems(w: Writer, item: Layout, value: readonly unknown[]): void {
  let i = 0
  try {
    for (; i < value.length; i++) {
      item.write(w, value[i])
    }
  } catch (error) {
    throw prepend(error, i)
  }
}

export function option(item: Layout): Layout {
  return {
    minBytes: 1,
    isZeroSized: false,
    read: (r) => {
      const offset = r.offset
      const tag = r.u8()
      if (tag > 1) {
        throw new BinaryError(offset, `Invalid Option tag ${tag}`)
      }
      if (tag === 0) {
        return Option.none()
      }
      try {
        return Option.some(item.read(r))
      } catch (error) {
        throw prepend(error, "value")
      }
    },
    write: (w, value) => {
      if (!Option.isOption(value)) {
        throw new BinaryError(w.offset, "Expected Option")
      }
      w.u8(Option.isSome(value) ? 1 : 0)
      if (Option.isNone(value)) {
        return
      }
      try {
        item.write(w, value.value)
      } catch (error) {
        throw prepend(error, "value")
      }
    },
  }
}

/** Rust Result<T, E>: tag 1 then the Ok value, or tag 0 then the Err value. */
export function result(ok: Layout, err: Layout): Layout {
  return {
    minBytes: 1 + Math.min(ok.minBytes, err.minBytes),
    isZeroSized: false,
    read: (r) => {
      const offset = r.offset
      const tag = r.u8()
      if (tag > 1) {
        throw new BinaryError(offset, `Invalid Result tag ${tag}`)
      }
      try {
        return tag === 1 ? Result.succeed(ok.read(r)) : Result.fail(err.read(r))
      } catch (error) {
        throw prepend(error, tag === 1 ? "success" : "failure")
      }
    },
    write: (w, value) => {
      if (!Result.isResult(value)) {
        throw new BinaryError(w.offset, "Expected Result")
      }
      const success = Result.isSuccess(value)
      w.u8(success ? 1 : 0)
      try {
        if (success) {
          ok.write(w, value.success)
        } else {
          err.write(w, value.failure)
        }
      } catch (error) {
        throw prepend(error, success ? "success" : "failure")
      }
    },
  }
}

/** The shape `Borsh.withBytes` decodes to and encodes from, on either side of its schema. */
export interface ValueWithBytes<A> {
  readonly value: A
  readonly bytes: Uint8Array
}

/** Own properties only, as for any struct field, so an inherited `bytes` is never trusted. */
export function isValueWithBytes(input: unknown): input is ValueWithBytes<unknown> {
  return (
    typeof input === "object" &&
    input !== null &&
    Object.hasOwn(input, "value") &&
    Object.hasOwn(input, "bytes") &&
    Reflect.get(input, "bytes") instanceof Uint8Array
  )
}

/** The layout of the wrapped value, also keeping the exact span it was read from. */
export function withBytes(value: Layout): Layout {
  // No compare: as a map key or set member it fails at construction, like any unordered key.
  return {
    minBytes: value.minBytes,
    isZeroSized: value.isZeroSized,
    read: (r) => {
      const start = r.offset
      try {
        // The reader's input is a plain view, so slice copies rather than aliasing the caller.
        return { value: value.read(r), bytes: r.input.slice(start, r.offset) }
      } catch (error) {
        throw prepend(error, "value")
      }
    },
    write: (w, input) => {
      if (!isValueWithBytes(input)) {
        throw new BinaryError(w.offset, "Expected value with bytes")
      }
      const start = w.offset
      try {
        value.write(w, input.value)
      } catch (error) {
        throw prepend(error, "value")
      }
      const difference = w.firstDifference(start, input.bytes)
      if (difference !== undefined) {
        throw prepend(new BinaryError(difference, "Bytes do not match the encoded value"), "bytes")
      }
    },
  }
}

/** How a native map or set type is read from and built from Rust-ordered entries. */
export interface Collection {
  get(value: unknown): { readonly size: number; readonly entries: Iterable<Entry> } | undefined
  make(entries: Entry[]): unknown
}

type Entry = readonly [unknown, unknown]

export const readonlyMap: Collection = {
  get: (value) => (value instanceof Map ? { size: value.size, entries: value } : undefined),
  make: (entries) => new Map(entries),
}

export const readonlySet: Collection = {
  get: (value) =>
    value instanceof Set ? { size: value.size, entries: value.entries() } : undefined,
  make: (entries) => new Set(entries.map(([key]) => key)),
}

export const hashMap: Collection = {
  get: (value) =>
    HashMap.isHashMap(value) ? { size: HashMap.size(value), entries: value } : undefined,
  make: HashMap.fromIterable,
}

export const hashSet: Collection = {
  get: (value) =>
    HashSet.isHashSet(value) ? { size: HashSet.size(value), entries: keyPairs(value) } : undefined,
  make: (entries) => HashSet.fromIterable(entries.map(([key]) => key)),
}

/** Set members as [key, key] entries, the shape Set.prototype.entries yields. */
function* keyPairs<K>(keys: Iterable<K>): Generator<readonly [K, K]> {
  for (const key of keys) {
    yield [key, key] as const
  }
}

/**
 * Rust BTreeMap/BTreeSet, also for Hash collections: a u32 count, then strictly increasing keys.
 * Sets have no value layout.
 */
export function collection(
  kind: Collection,
  key: Key,
  value: Layout | undefined,
  maxLength: number,
): Layout {
  const compare = key.compare
  const minEntryBytes = key.minBytes + (value?.minBytes ?? 0)
  const assertIncreasing = (previous: unknown, next: unknown, offset: number) => {
    if (compare(previous, next) >= 0) {
      throw new BinaryError(offset, "Collection keys must be strictly increasing")
    }
  }
  const readEntries = (r: Reader, count: number) => {
    // Each entry needs at least minEntryBytes, so reject an impossible count before allocating.
    if (count > Math.floor((r.end - r.offset) / minEntryBytes)) {
      throw r.pastEnd(r.offset, count * minEntryBytes, "Truncated collection payload")
    }
    const entries: Entry[] = []
    // The entry index and part locate a failure, as in [3]["value"].
    let i = 0
    let part = "key"
    try {
      for (; i < count; i++) {
        const offset = r.offset
        part = "key"
        const item = key.read(r)
        if (i > 0) {
          assertIncreasing(entries[i - 1]?.[0], item, offset)
        }
        part = "value"
        entries.push([item, value === undefined ? undefined : value.read(r)])
      }
    } catch (error) {
      throw prepend(prepend(error, part), i)
    }
    return kind.make(entries)
  }
  const writeEntries = (w: Writer, size: number, items: Iterable<Entry>) => {
    w.ensure(4 + (size === 0 ? 0 : size * minEntryBytes))
    // Sorted into Rust order, so the increasing check below only rejects keys Rust deems equal.
    const entries = Array.from(items).sort(([a], [b]) => compare(a, b))
    w.u32(entries.length)
    let i = 0
    let part = "key"
    try {
      for (const [item, itemValue] of entries) {
        part = "key"
        if (i > 0) {
          assertIncreasing(entries[i - 1]?.[0], item, w.offset)
        }
        key.write(w, item)
        part = "value"
        if (value !== undefined) {
          value.write(w, itemValue)
        }
        i++
      }
    } catch (error) {
      throw prepend(prepend(error, part), i)
    }
  }
  return {
    minBytes: 4,
    isZeroSized: false,
    read: (r) => {
      const offset = r.offset
      const count = r.u32()
      checkMaxLength(count, maxLength, offset)
      r.charge(count, offset)
      return readEntries(r, count)
    },
    write: (w, input) => {
      const native = kind.get(input)
      if (native === undefined || native.size > 0xffff_ffff) {
        throw new BinaryError(w.offset, "Expected native collection with u32 length")
      }
      checkMaxLength(native.size, maxLength, w.offset)
      w.charge(native.size, w.offset)
      writeEntries(w, native.size, native.entries)
    },
  }
}

export interface Variant {
  readonly label: string
  readonly discriminant: number
  readonly value?: unknown
  readonly payload?: Layout
}

/** A literal union or TS enum: each value is written as its discriminant alone. */
export function valueEnum(variants: ReadonlyArray<Variant>, isZeroSized: boolean): Layout {
  const readVariant = variantReader(variants)
  const discriminantByValue = new Map(
    variants.map((variant) => [variant.value, variant.discriminant]),
  )
  return {
    minBytes: 1,
    isZeroSized,
    read: (r) => readVariant(r).value,
    write: (w, value) => {
      const discriminant = discriminantByValue.get(value)
      if (discriminant === undefined) {
        throw new BinaryError(w.offset, "Invalid enum value")
      }
      w.u8(discriminant)
    },
  }
}

/** A tagged union: the discriminant, then the variant's fields without its tag. */
export function objectEnum(
  variants: ReadonlyArray<Variant & { readonly payload: Layout }>,
  tag: string,
  isZeroSized: boolean,
): Layout {
  const readVariant = variantReader(variants)
  const variantByLabel = new Map(variants.map((variant) => [variant.label, variant]))
  // As for struct fields, assignment would hit an inherited setter or a frozen inherited property.
  const define = tag in Object.prototype
  return {
    minBytes: 1 + Math.min(...variants.map((variant) => variant.payload.minBytes)),
    isZeroSized,
    read: (r) => {
      const variant = readVariant(r)
      const value = variant.payload.read(r) as Record<string, unknown>
      if (define) {
        defineField(value, tag, variant.label)
      } else {
        value[tag] = variant.label
      }
      return value
    },
    write: (w, value) => {
      if (typeof value !== "object" || value === null) {
        throw new BinaryError(w.offset, "Expected enum object")
      }
      const label = Object.hasOwn(value, tag) ? Reflect.get(value, tag) : undefined
      const variant = typeof label === "string" ? variantByLabel.get(label) : undefined
      if (variant === undefined) {
        throw prepend(new BinaryError(w.offset, "Invalid enum label"), tag)
      }
      w.u8(variant.discriminant)
      variant.payload.write(w, value)
    },
  }
}

/** Read the u8 discriminant, reporting an unknown one at its own offset. */
function variantReader<V extends Variant>(variants: ReadonlyArray<V>): (r: Reader) => V {
  const variantByDiscriminant = new Map(variants.map((variant) => [variant.discriminant, variant]))
  return (r) => {
    const offset = r.offset
    const discriminant = r.u8()
    const variant = variantByDiscriminant.get(discriminant)
    if (variant === undefined) {
      throw new BinaryError(offset, `Invalid enum tag ${discriminant}`)
    }
    return variant
  }
}

function sum<T>(items: ReadonlyArray<T>, size: (item: T) => number): number {
  return items.reduce((total, item) => total + size(item), 0)
}
