/**
 * Property-based tests (fast-check), in the spirit of pyborsh's hypothesis suite.
 *
 *   P1  round-trip:   deserialize(serialize(x)) equals x, and re-encoding is
 *                     byte-stable.
 *   P2  determinism:  hashMap/hashSet encodings never depend on insertion order.
 *   P3  canonicity:   keys and elements are written strictly ascending in Rust
 *                     `Ord` order, checked against independent oracles for the
 *                     primitive key types (numeric order, bytewise order, UTF-8
 *                     byte order), and entries that compare equal are rejected.
 */

import fc from "fast-check"
import { describe, expect, test } from "vitest"
import { b, type Schema } from "../src/schema"
import { arbitraryFor } from "./arbitraries"

enum Color {
  Red = 0,
  Green = 1,
  Blue = 2,
}

const PrimitivesSchema = b.struct({
  u8: b.u8(),
  u16: b.u16(),
  u32: b.u32(),
  u64: b.u64(),
  u128: b.u128(),
  i8: b.i8(),
  i16: b.i16(),
  i32: b.i32(),
  i64: b.i64(),
  i128: b.i128(),
  f32: b.f32(),
  f64: b.f64(),
  bool: b.bool(),
  string: b.string(),
  bytes: b.bytes(),
  fixedBytes: b.bytes(4),
})

const VersionSchema = b.struct({ major: b.u8(), minor: b.u8() })
const TagSchema = b.enum({ Number: b.u8(), Empty: b.unit(), Label: b.string() })

const CollectionsSchema = b.struct({
  vec: b.vec(b.u16()),
  array: b.array(b.u8(), 3),
  option: b.option(b.u32()),
  tuple: b.tuple(b.u8(), b.string(), b.bool()),
  stringSet: b.hashSet(b.string()),
  stringMap: b.hashMap(b.string(), b.u32()),
  bytesMap: b.hashMap(b.bytes(), b.bytes()),
  numberMap: b.hashMap(b.i32(), b.u8()),
  bigintSet: b.hashSet(b.u64()),
  tupleSet: b.hashSet(b.tuple(b.u8(), b.string())),
  optionSet: b.hashSet(b.option(b.u8())),
  structMap: b.hashMap(VersionSchema, b.u8()),
  enumMap: b.hashMap(TagSchema, b.u8()),
  nestedSet: b.hashSet(b.hashSet(b.u8())),
  nestedMap: b.hashMap(b.hashMap(b.u8(), b.u8()), b.u8()),
})

const NestedSchema = b.struct({
  inner: b.option(b.struct({ x: b.u32(), label: b.string() })),
  events: b.vec(
    b.enum({ Ping: b.unit(), Move: b.struct({ dx: b.i8(), dy: b.i8() }), Say: b.string() }),
  ),
  color: b.nativeEnum(Color),
  colors: b.hashSet(b.nativeEnum(Color)),
})

const schemas: [string, Schema<unknown>][] = [
  ["primitives", PrimitivesSchema as Schema<unknown>],
  ["collections", CollectionsSchema as Schema<unknown>],
  ["nested", NestedSchema as Schema<unknown>],
]

const mapSchemas: [string, Schema<Map<unknown, unknown>>][] = [
  ["bytes keys", b.hashMap(b.bytes(), b.bytes()) as Schema<Map<unknown, unknown>>],
  ["string keys", b.hashMap(b.string(), b.u32()) as Schema<Map<unknown, unknown>>],
  ["i64 keys", b.hashMap(b.i64(), b.u8()) as Schema<Map<unknown, unknown>>],
  ["option keys", b.hashMap(b.option(b.u16()), b.u8()) as Schema<Map<unknown, unknown>>],
  ["struct keys", b.hashMap(VersionSchema, b.u8()) as Schema<Map<unknown, unknown>>],
  ["enum keys", b.hashMap(TagSchema, b.u8()) as Schema<Map<unknown, unknown>>],
  [
    "nested map keys",
    b.hashMap(b.hashMap(b.u8(), b.u8()), b.u8()) as Schema<Map<unknown, unknown>>,
  ],
]

const setSchemas: [string, Schema<Set<unknown>>][] = [
  ["bytes elements", b.hashSet(b.bytes()) as Schema<Set<unknown>>],
  ["string elements", b.hashSet(b.string()) as Schema<Set<unknown>>],
  ["u128 elements", b.hashSet(b.u128()) as Schema<Set<unknown>>],
  ["tuple elements", b.hashSet(b.tuple(b.u8(), b.string())) as Schema<Set<unknown>>],
  ["vec elements", b.hashSet(b.vec(b.u8())) as Schema<Set<unknown>>],
  ["nested set elements", b.hashSet(b.hashSet(b.u8())) as Schema<Set<unknown>>],
]

// ==================== Oracles (the Borsh spec, stated independently) ====================

const utf8 = (text: string) => new TextEncoder().encode(text)

/** Bytewise lexicographic order, shorter prefix first: Rust's `Ord` for `Vec<u8>`. */
function bytewise(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) {
    const difference = (a[i] as number) - (b[i] as number)
    if (difference !== 0) return difference
  }
  return a.length - b.length
}

/** Rust's `Ord` for `str`: the bytewise order of the UTF-8 encoding. */
const utf8Order = (a: string, b: string) => bytewise(utf8(a), utf8(b))

/** Rust's `Ord` for integers. */
const numeric = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0)

/** Every adjacent pair of `items` must be strictly ascending under `compare`. */
function expectStrictlyAscending<T>(items: T[], compare: (a: T, b: T) => number): void {
  for (let i = 1; i < items.length; i++) {
    expect(compare(items[i - 1] as T, items[i] as T)).toBeLessThan(0)
  }
}

/** Entries in the order they were written; deserialization preserves wire order. */
function wireOrder<T>(schema: Schema<T>, value: T): unknown[] {
  const decoded = schema.deserialize(schema.serialize(value))
  return decoded instanceof Map ? Array.from(decoded.keys()) : Array.from(decoded as Set<unknown>)
}

// ==================== Properties ====================

describe("P1 round-trip", () => {
  test.each(schemas)(
    "%s: deserialize(serialize(x)) equals x and re-encodes identically",
    (_, schema) => {
      fc.assert(
        fc.property(arbitraryFor(schema), (value) => {
          const bytes = schema.serialize(value)
          const decoded = schema.deserialize(bytes)
          expect(decoded).toEqual(value)
          expect(schema.serialize(decoded)).toEqual(bytes)
        }),
      )
    },
  )
})

describe("P2 insertion order does not affect the encoding", () => {
  test.each(mapSchemas)("hashMap with %s", (_, schema) => {
    const valueAndPermutation = arbitraryFor(schema).chain((value) => {
      const entries = Array.from(value.entries())
      return fc
        .shuffledSubarray(entries, { minLength: entries.length, maxLength: entries.length })
        .map((shuffled) => [value, new Map(shuffled)] as const)
    })
    fc.assert(
      fc.property(valueAndPermutation, ([value, shuffled]) => {
        expect(schema.serialize(shuffled)).toEqual(schema.serialize(value))
      }),
    )
  })

  test.each(setSchemas)("hashSet with %s", (_, schema) => {
    const valueAndPermutation = arbitraryFor(schema).chain((value) => {
      const items = Array.from(value)
      return fc
        .shuffledSubarray(items, { minLength: items.length, maxLength: items.length })
        .map((shuffled) => [value, new Set(shuffled)] as const)
    })
    fc.assert(
      fc.property(valueAndPermutation, ([value, shuffled]) => {
        expect(schema.serialize(shuffled)).toEqual(schema.serialize(value))
      }),
    )
  })
})

describe("P3 canonical order", () => {
  test("bytes keys are written in bytewise order", () => {
    const schema = b.hashMap(b.bytes(), b.u8())
    fc.assert(
      fc.property(arbitraryFor(schema), (value) => {
        expectStrictlyAscending(wireOrder(schema, value) as Uint8Array[], bytewise)
      }),
    )
  })

  test("string elements are written in UTF-8 byte order", () => {
    const schema = b.hashSet(b.string())
    fc.assert(
      fc.property(arbitraryFor(schema), (value) => {
        expectStrictlyAscending(wireOrder(schema, value) as string[], utf8Order)
      }),
    )
  })

  test("any two distinct strings are ordered like their UTF-8 encodings", () => {
    const schema = b.hashSet(b.string())
    const text = fc.string({ unit: "binary", maxLength: 6 })
    fc.assert(
      fc.property(text, text, (x, y) => {
        fc.pre(utf8Order(x, y) !== 0)
        const [first] = wireOrder(schema, new Set([x, y]))
        expect(first).toBe(utf8Order(x, y) < 0 ? x : y)
      }),
    )
  })

  test("integer elements are written in numeric order", () => {
    const schema = b.hashSet(b.i128())
    fc.assert(
      fc.property(arbitraryFor(schema), (value) => {
        expectStrictlyAscending(wireOrder(schema, value) as bigint[], numeric)
      }),
    )
  })

  test("a key that compares equal to an existing key is rejected", () => {
    const schema = b.hashMap(b.bytes(), b.u8())
    fc.assert(
      fc.property(arbitraryFor(b.bytes()), arbitraryFor(b.u8()), (key, value) => {
        const duplicate = new Map([
          [key, value],
          [new Uint8Array(key), value],
        ])
        expect(() => schema.serialize(duplicate)).toThrow(/keys that compare equal/)
      }),
    )
  })
})
