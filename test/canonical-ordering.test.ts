/**
 * Borsh writes `HashMap` keys and `HashSet` elements sorted by the key's Rust
 * `Ord`, so equal collections always encode to identical bytes. These tests pin
 * that order for every key type Zorsh supports. The Rust-generated vectors in
 * `test/rust/canonical-ordering.test.ts` cover the same cases against borsh-rs.
 */

import { describe, expect, test } from "vitest"
import { b, type Schema } from "../src/schema"

const utf8 = (text: string) => new TextEncoder().encode(text)
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

/** Keys in the order they were written; deserialization preserves wire order. */
function serializedKeys<K, V>(schema: Schema<Map<K, V>>, value: Map<K, V>): K[] {
  return Array.from(schema.deserialize(schema.serialize(value)).keys())
}

/** Elements in the order they were written; deserialization preserves wire order. */
function serializedElements<T>(schema: Schema<Set<T>>, value: Set<T>): T[] {
  return Array.from(schema.deserialize(schema.serialize(value)))
}

describe("canonical ordering of hashMap keys and hashSet elements", () => {
  test("bytes keys compare bytewise with a shorter prefix first", () => {
    const schema = b.hashMap(b.bytes(), b.u8())
    const value = new Map([
      [utf8("zeta"), 1],
      [utf8("alpha"), 2],
      [utf8("alphabet"), 3],
      [new Uint8Array(), 4],
      [new Uint8Array([2]), 5],
      [new Uint8Array([10]), 6],
      [new Uint8Array([0x80]), 7],
      [new Uint8Array([9]), 8],
    ])

    expect(serializedKeys(schema, value)).toEqual([
      new Uint8Array(),
      new Uint8Array([2]),
      new Uint8Array([9]),
      new Uint8Array([10]),
      utf8("alpha"),
      utf8("alphabet"),
      utf8("zeta"),
      new Uint8Array([0x80]),
    ])
  })

  test("encoding is byte-identical regardless of insertion order", () => {
    const schema = b.hashMap(b.bytes(), b.u8())
    const zetaFirst = new Map([
      [utf8("zeta"), 1],
      [utf8("alpha"), 2],
    ])
    const alphaFirst = new Map([
      [utf8("alpha"), 2],
      [utf8("zeta"), 1],
    ])
    const expected = `02000000${"05000000"}${hex(utf8("alpha"))}02${"04000000"}${hex(utf8("zeta"))}01`

    expect(hex(schema.serialize(zetaFirst))).toBe(expected)
    expect(hex(schema.serialize(alphaFirst))).toBe(expected)
  })

  test("integer keys compare numerically, not as decimal strings", () => {
    expect(
      serializedKeys(
        b.hashMap(b.u32(), b.u8()),
        new Map([
          [10, 0],
          [2, 0],
          [1, 0],
          [4294967295, 0],
          [0, 0],
        ]),
      ),
    ).toEqual([0, 1, 2, 10, 4294967295])
    expect(
      serializedKeys(
        b.hashMap(b.i32(), b.u8()),
        new Map([
          [-1, 0],
          [2, 0],
          [-10, 0],
          [0, 0],
        ]),
      ),
    ).toEqual([-10, -1, 0, 2])
    expect(
      serializedKeys(
        b.hashMap(b.u64(), b.u8()),
        new Map([
          [10n, 0],
          [9n, 0],
          [100n, 0],
        ]),
      ),
    ).toEqual([9n, 10n, 100n])
    expect(serializedElements(b.hashSet(b.i128()), new Set([-1n, 1n, 0n, -10n]))).toEqual([
      -10n,
      -1n,
      0n,
      1n,
    ])
  })

  test("string keys compare by code point (UTF-8 order), not by UTF-16 code unit", () => {
    const schema = b.hashSet(b.string())
    const value = new Set(["\u{10000}", "￿", "a", "", "", "ab"])

    expect(serializedElements(schema, value)).toEqual(["", "a", "ab", "", "￿", "\u{10000}"])
  })

  test("bool orders false before true", () => {
    expect(serializedElements(b.hashSet(b.bool()), new Set([true, false]))).toEqual([false, true])
  })

  test("option orders None before Some", () => {
    const schema = b.hashMap(b.option(b.u8()), b.u8())
    const value = new Map([
      [5, 0],
      [null, 0],
      [0, 0],
    ])

    expect(serializedKeys(schema, value)).toEqual([null, 0, 5])
  })

  test("tuples compare element by element", () => {
    const schema = b.hashSet(b.tuple(b.u8(), b.string()))
    const value = new Set<[number, string]>([
      [1, "b"],
      [1, "a"],
      [0, "z"],
    ])

    expect(serializedElements(schema, value)).toEqual([
      [0, "z"],
      [1, "a"],
      [1, "b"],
    ])
  })

  test("structs compare field by field in definition order", () => {
    const schema = b.hashMap(b.struct({ major: b.u8(), minor: b.u8() }), b.u8())
    const value = new Map([
      [{ major: 1, minor: 0 }, 0],
      [{ major: 0, minor: 255 }, 0],
      [{ major: 0, minor: 1 }, 0],
    ])

    expect(serializedKeys(schema, value)).toEqual([
      { major: 0, minor: 1 },
      { major: 0, minor: 255 },
      { major: 1, minor: 0 },
    ])
  })

  test("enums compare by variant index, then by payload", () => {
    const keySchema = b.enum({ Number: b.u8(), Empty: b.unit(), Label: b.string() })
    const schema = b.hashMap(keySchema, b.u8())
    const value = new Map<b.infer<typeof keySchema>, number>([
      [{ Label: "x" }, 0],
      [{ Empty: {} }, 0],
      [{ Number: 5 }, 0],
      [{ Number: 1 }, 0],
    ])

    expect(serializedKeys(schema, value)).toEqual([
      { Number: 1 },
      { Number: 5 },
      { Empty: {} },
      { Label: "x" },
    ])
  })

  test("vec keys compare lexicographically with a shorter prefix first", () => {
    const schema = b.hashSet(b.vec(b.u16()))
    const value = new Set([[2], [1, 2, 3], [1, 2], []])

    expect(serializedElements(schema, value)).toEqual([[], [1, 2], [1, 2, 3], [2]])
  })

  test("fixed arrays compare element by element", () => {
    const schema = b.hashSet(b.array(b.u8(), 2))
    const value = new Set([
      [1, 0],
      [0, 9],
    ])

    expect(serializedElements(schema, value)).toEqual([
      [0, 9],
      [1, 0],
    ])
  })

  test("native enums order by declaration index", () => {
    enum Color {
      Red = 0,
      Green = 1,
      Blue = 2,
    }
    enum Direction {
      Up = "up",
      Down = "down",
    }

    expect(
      serializedElements(
        b.hashSet(b.nativeEnum(Color)),
        new Set([Color.Blue, Color.Red, Color.Green]),
      ),
    ).toEqual([Color.Red, Color.Green, Color.Blue])
    // "down" < "up" as strings, but Up is declared first
    expect(
      serializedElements(
        b.hashSet(b.nativeEnum(Direction)),
        new Set([Direction.Down, Direction.Up]),
      ),
    ).toEqual([Direction.Up, Direction.Down])
  })

  test("nested sets and maps compare as sorted sequences of their entries", () => {
    const setSchema = b.hashSet(b.hashSet(b.u8()))
    const sets = new Set([new Set([2]), new Set([1, 3]), new Set<number>(), new Set([1])])
    expect(serializedElements(setSchema, sets)).toEqual([
      new Set(),
      new Set([1]),
      new Set([1, 3]),
      new Set([2]),
    ])

    const mapSchema = b.hashMap(b.hashMap(b.u8(), b.u8()), b.u8())
    const maps = new Map([
      [new Map([[1, 1]]), 0],
      [new Map<number, number>(), 0],
      [new Map([[1, 2]]), 0],
      [new Map([[0, 9]]), 0],
    ])
    expect(serializedKeys(mapSchema, maps)).toEqual([
      new Map(),
      new Map([[0, 9]]),
      new Map([[1, 1]]),
      new Map([[1, 2]]),
    ])
  })

  test("entries that compare equal are rejected", () => {
    expect(() => b.hashSet(b.bytes()).serialize(new Set([utf8("a"), utf8("a")]))).toThrow(
      /elements that compare equal/,
    )
    expect(() =>
      b.hashMap(b.bytes(), b.u8()).serialize(
        new Map([
          [utf8("a"), 1],
          [utf8("a"), 2],
        ]),
      ),
    ).toThrow(/keys that compare equal/)
    expect(() =>
      b.hashSet(b.tuple(b.u8(), b.u8())).serialize(
        new Set<[number, number]>([
          [1, 2],
          [1, 2],
        ]),
      ),
    ).toThrow(/elements that compare equal/)
  })

  test("round-trip preserves every entry", () => {
    const schema = b.hashMap(b.bytes(), b.string())
    const value = new Map([
      [utf8("zeta"), "last"],
      [utf8("alpha"), "first"],
    ])

    const decoded = schema.deserialize(schema.serialize(value))

    expect(decoded.size).toBe(2)
    expect(Array.from(decoded.entries())).toEqual([
      [utf8("alpha"), "first"],
      [utf8("zeta"), "last"],
    ])
  })
})
