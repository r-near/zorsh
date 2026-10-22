import { Arbitrary, Effect, Exit, HashMap, Option, Schema } from "effect"
import { describe, expect, it, vi } from "vite-plus/test"
import { Borsh } from "../src/index.js"
import { compile } from "../src/internal/compiler.js"
import { Writer } from "../src/internal/io.js"

/** u32 little endian, as a Borsh length prefix. */
function u32(value: number): number[] {
  return [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, value >>> 24]
}

function failure(run: () => unknown): Schema.SchemaError {
  try {
    run()
  } catch (error) {
    if (Schema.isSchemaError(error)) {
      return error
    }
    throw error
  }
  throw new Error("Expected SchemaError")
}

function decodes(schema: Schema.Top, bytes: ArrayLike<number>, options?: Borsh.Options): unknown {
  const codec = Borsh.toCodec(schema as Schema.Codec<unknown, unknown>, options)
  return Schema.decodeSync(codec)(Uint8Array.from(bytes))
}

function decodeFailure(schema: Schema.Top, bytes: ArrayLike<number>, options?: Borsh.Options) {
  return failure(() => decodes(schema, bytes, options))
}

function encodeFailure(schema: Schema.Top, value: unknown, options?: Borsh.Options) {
  const codec = Borsh.toCodec(schema as Schema.Codec<unknown, unknown>, options)
  return failure(() => Schema.encodeUnknownSync(codec)(value))
}

/** Count DataView reads while run decodes, to show which bytes a failure touched. */
function countReads(method: "getUint8" | "getUint32", run: () => unknown): number {
  const spy = vi.spyOn(DataView.prototype, method)
  try {
    run()
  } catch {
    // Only the reads matter here.
  }
  const reads = spy.mock.calls.length
  spy.mockRestore()
  return reads
}

describe("maxItems", () => {
  const nested = Schema.Array(Schema.Array(Borsh.U8))
  // Two outer items, then two and one inner items: five in total.
  const nestedValue = [[1, 2], [3]]
  const nestedBytes = [...u32(2), ...u32(2), 1, 2, ...u32(1), 3]

  it("accepts exactly the budget and fails one over at the prefix that overran it", () => {
    expect(decodes(nested, nestedBytes, { maxItems: 5 })).toEqual(nestedValue)
    expect(decodeFailure(nested, nestedBytes, { maxItems: 4 }).message).toBe(
      "Input exceeds maxItems (4) at byte 10\n  at [1]",
    )
    // The outer count is charged before any inner one.
    expect(decodeFailure(nested, nestedBytes, { maxItems: 1 }).message).toBe(
      "Input exceeds maxItems (1) at byte 0",
    )
    expect(decodes(nested, u32(0), { maxItems: 0 })).toEqual([])
  })

  it("charges encoding the same way, after checking the value's shape", () => {
    const at = Borsh.toCodec(nested, { maxItems: 5 })
    expect(Schema.encodeSync(at)(nestedValue)).toEqual(Uint8Array.from(nestedBytes))
    expect(encodeFailure(nested, nestedValue, { maxItems: 4 }).message).toBe(
      "Output exceeds maxItems (4) at byte 10\n  at [1]",
    )
    const map = new Map([
      [1, 2],
      [3, 4],
    ])
    expect(
      encodeFailure(Schema.ReadonlyMap(Borsh.U8, Borsh.U8), map, { maxItems: 1 }).message,
    ).toBe("Output exceeds maxItems (1) at byte 0")
    const fixed = Borsh.fixedArray(Borsh.U8, 3)
    expect(encodeFailure(fixed, [1, 2, 3], { maxItems: 2 }).message).toBe(
      "Output exceeds maxItems (2) at byte 0",
    )
    const shape = Schema.encodeUnknownSync(Borsh.toCodec(fixed, { maxItems: 0 }), {
      disableChecks: true,
    })
    expect(() => shape([1])).toThrow("Expected fixed array of length 3 at byte 0")
    const vector = compile(Schema.toEncoded(Schema.Array(Borsh.U8)).ast)
    expect(() => vector.write(new Writer(64, 0), {})).toThrow("Expected array with u32 length")
    expect(() => vector.write(new Writer(64, 0), [1])).toThrow("Output exceeds maxItems (0)")
  })

  it("counts vector items, map entries, set members and fixed-array items, not bytes or strings", () => {
    const schema = Schema.Struct({
      bytes: Borsh.Bytes,
      text: Schema.String,
      map: Schema.HashMap(Borsh.U8, Borsh.U8),
      set: Schema.ReadonlySet(Borsh.U8),
      fixed: Borsh.fixedArray(Borsh.U8, 2),
    })
    const value = {
      bytes: new Uint8Array(100),
      text: "a".repeat(100),
      map: HashMap.make([1, 2]),
      set: new Set([3, 4]),
      fixed: [5, 6],
    }
    const exact = Borsh.toCodec(schema, { maxItems: 5 })
    const bytes = Schema.encodeSync(exact)(value)
    expect(Schema.decodeSync(exact)(bytes)).toEqual(value)
    expect(decodeFailure(schema, bytes, { maxItems: 4 }).message).toBe(
      `Input exceeds maxItems (4) at byte ${bytes.byteLength - 2}\n  at ["fixed"]`,
    )
  })

  it("bounds fixed arrays of zero-sized items, which no byte count bounds", () => {
    // Vec<{ a: u8, b: [(); 1000] }> visits 1000 units per input byte.
    const schema = Schema.Array(
      Schema.Struct({ a: Borsh.U8, b: Borsh.fixedArray(Borsh.Unit, 1000) }),
    )
    const bytes = [...u32(3), 1, 2, 3]
    expect(decodes(schema, bytes, { maxItems: 3003 })).toHaveLength(3)
    expect(decodeFailure(schema, bytes, { maxItems: 3002 }).message).toBe(
      'Input exceeds maxItems (3002) at byte 7\n  at [2]["b"]',
    )
  })

  it("charges only what is read, before the remaining-bytes check", () => {
    const schema = Schema.Option(Schema.Array(Borsh.U8))
    expect(decodes(schema, [0], { maxItems: 0 })).toEqual(Option.none())
    expect(decodeFailure(schema, [1, ...u32(1), 7], { maxItems: 0 }).message).toBe(
      'Input exceeds maxItems (0) at byte 1\n  at ["value"]',
    )
    for (const truncated of [Schema.Array(Borsh.U8), Schema.ReadonlySet(Borsh.U8)]) {
      expect(decodeFailure(truncated, u32(10), { maxItems: 5 }).message).toBe(
        "Input exceeds maxItems (5) at byte 0",
      )
    }
    expect(decodeFailure(Schema.Array(Borsh.U8), u32(10), { maxItems: 10 }).message).toBe(
      "Truncated vector payload at byte 4",
    )
  })

  it("applies under disableChecks, because it is a codec limit rather than a schema check", () => {
    const codec = Borsh.toCodec(Schema.Array(Borsh.U8), { maxItems: 1 })
    expect(() =>
      Schema.decodeSync(codec, { disableChecks: true })(Uint8Array.of(...u32(2), 1, 2)),
    ).toThrow(/Input exceeds maxItems \(1\) at byte 0/)
  })

  it("validates the option and memoizes codecs by it", () => {
    const schema = Schema.Array(Borsh.U8)
    for (const maxItems of [-1, 1.5, Number.NaN, Infinity, 2 ** 53, null]) {
      expect(() => Borsh.toCodec(schema, { maxItems: maxItems as number })).toThrow(
        "$: maxItems must be a non-negative safe integer",
      )
    }
    const unlimited = Borsh.toCodec(schema)
    const limited = Borsh.toCodec(schema, { maxItems: 0 })
    expect(Borsh.toCodec(schema, { maxItems: undefined })).toBe(unlimited)
    expect(limited).not.toBe(unlimited)
    expect(Borsh.toCodec(schema, { maxItems: 0 })).toBe(limited)
    expect(Borsh.toCodec(schema, { maxItems: 0, maxBytes: 8 })).not.toBe(limited)
    expect(Schema.decodeSync(unlimited)(Uint8Array.of(...u32(1), 7))).toEqual([7])
    expect(() => Schema.decodeSync(limited)(Uint8Array.of(...u32(1), 7))).toThrow(/maxItems \(0\)/)
  })

  it("accepts and encodes exactly the values that fit the budget", () => {
    const schema = Schema.Struct({
      vectors: Schema.Array(Schema.Array(Borsh.U8)),
      map: Schema.ReadonlyMap(Borsh.U8, Schema.Array(Borsh.U8)),
      fixed: Borsh.fixedArray(Schema.Option(Borsh.U8), 2),
    })
    const items = (value: typeof schema.Type) =>
      value.vectors.reduce((sum, inner) => sum + 1 + inner.length, 0) +
      [...value.map.values()].reduce((sum, inner) => sum + 1 + inner.length, 0) +
      2
    const unlimited = Borsh.toCodec(schema)
    const samples = Arbitrary.sampleEffect(Arbitrary.schema(schema), { count: 200, seed: 7 })
    for (const value of Effect.runSync(samples)) {
      const bytes = Schema.encodeSync(unlimited)(value)
      const count = items(value)
      for (const maxItems of [count, count - 1]) {
        const limited = Borsh.toCodec(schema, { maxItems: Math.max(0, maxItems) })
        const fits = count <= Math.max(0, maxItems)
        expect(Exit.isSuccess(Schema.decodeExit(limited)(bytes))).toBe(fits)
        expect(Exit.isSuccess(Schema.encodeExit(limited)(value))).toBe(fits)
      }
    }
  })
})

describe("untrusted input", () => {
  // 16 MiB: a count of 16,777,212, then that many zero bytes, each a Noop variant.
  const Action = Schema.TaggedUnion({ Noop: {}, Transfer: { amount: Borsh.U128 } })
  const input = new Uint8Array(16 * 1024 * 1024)
  new DataView(input.buffer).setUint32(0, input.byteLength - 4, true)

  it("rejects millions of one-byte items with maxItems before reading any", () => {
    const codec = Borsh.toCodec(Schema.Array(Action), { maxItems: 10_000 })
    expect(countReads("getUint8", () => Schema.decodeSync(codec)(input))).toBe(0)
    expect(() => Schema.decodeSync(codec)(input)).toThrow(
      "Input exceeds maxItems (10000) at byte 0",
    )
  })
})
