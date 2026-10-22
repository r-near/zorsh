import {
  Arbitrary,
  Effect,
  Exit,
  HashMap,
  HashSet,
  Option,
  Schema,
  SchemaTransformation,
} from "effect"
import { describe, expect, it, vi } from "vite-plus/test"
import { Borsh } from "../src/index.js"
import { compile } from "../src/internal/compile.js"
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

function sample<S extends Schema.Codec<unknown, unknown>>(schema: S, count: number, seed: number) {
  return Effect.runSync(Arbitrary.sampleEffect(Arbitrary.schema(schema), { count, seed }))
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
    for (const value of sample(schema, 200, 7)) {
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

describe("Borsh.maxLength", () => {
  // Each kind at a length of n, with the value that is one longer; "é" is 2 UTF-8 bytes.
  const kinds = [
    ["String", Schema.String, (n: number) => "é".padEnd(n - 1, "a")],
    ["Bytes", Borsh.Bytes, (n: number) => new Uint8Array(n)],
    ["Array", Schema.Array(Borsh.U8), (n: number) => Array.from({ length: n }, (_, i) => i)],
    ["ReadonlyMap", Schema.ReadonlyMap(Borsh.U8, Borsh.U8), (n: number) => new Map(pairs(n))],
    ["HashMap", Schema.HashMap(Borsh.U8, Borsh.U8), (n: number) => HashMap.fromIterable(pairs(n))],
    ["ReadonlySet", Schema.ReadonlySet(Borsh.U8), (n: number) => new Set(pairs(n).map(([k]) => k))],
    [
      "HashSet",
      Schema.HashSet(Borsh.U8),
      (n: number) => HashSet.fromIterable(pairs(n).map(([k]) => k)),
    ],
  ] as const

  function pairs(n: number): Array<[number, number]> {
    return Array.from({ length: n }, (_, i) => [i, i])
  }

  it.each(kinds)("bounds %s on the wire and in the schema pass", (_, schema, make) => {
    const bounded = (schema as Schema.Codec<unknown>).check(Borsh.maxLength(2) as never)
    const codec = Borsh.toCodec(bounded)
    const unchecked = { disableChecks: true }
    const [at, over] = [make(2), make(3)]
    const overBytes = Schema.encodeUnknownSync(Borsh.toCodec(schema as Schema.Codec<unknown>))(over)
    const atBytes = Schema.encodeSync(codec)(at)
    expect(Schema.encodeSync(codec)(Schema.decodeSync(codec)(atBytes))).toEqual(atBytes)
    expect(Schema.is(bounded)(at)).toBe(true)
    expect(Schema.is(bounded)(over)).toBe(false)
    const wire = "Length 3 exceeds maxLength (2) at byte 0"
    for (const options of [undefined, unchecked]) {
      expect(() => Schema.decodeSync(codec, options)(overBytes)).toThrow(wire)
    }
    expect(() => Schema.encodeSync(codec, unchecked)(over)).toThrow(wire)
    expect(() => Schema.encodeSync(codec)(over)).toThrow("Expected a Borsh length of at most 2")
  })

  it("rejects an oversized string before writing, not as the byte budget", () => {
    const codec = Borsh.toCodec(Schema.String.check(Borsh.maxLength(1)), { maxBytes: 1024 })
    const spy = vi.spyOn(DataView.prototype, "setUint32")
    expect(() => Schema.encodeSync(codec, { disableChecks: true })("é")).toThrow(
      "Length 2 exceeds maxLength (1) at byte 0",
    )
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it("agrees with Schema.is and make on lone surrogates, which have no UTF-8 length", () => {
    const Bounded = Schema.String.check(Borsh.maxLength(10))
    expect(Schema.is(Bounded)("é".repeat(5))).toBe(true)
    expect(Schema.is(Bounded)("é".repeat(5) + "a")).toBe(false)
    expect(Schema.is(Bounded)("\uD800")).toBe(false)
    // Astral characters are 4 bytes, a BOM 3; the count may stop early but never short.
    for (const [value, n, fits] of [
      ["😀", 4, true],
      ["😀", 3, false],
      ["a😀", 4, false],
      ["\uFEFF", 3, true],
      ["", 0, true],
      ["aa\uD800", 1, false],
    ] as const) {
      expect(Schema.is(Schema.String.check(Borsh.maxLength(n)))(value)).toBe(fits)
    }
    expect(() => Bounded.make("a\uDC00")).toThrow()
    expect(() => Schema.decodeSync(Bounded)("a\uDC00")).toThrow("Lone UTF-16 surrogate")
    const encode = Schema.encodeSync(Borsh.toCodec(Bounded), { disableChecks: true })
    expect(() => encode("\uD800")).toThrow("Lone UTF-16 surrogate at byte 0")
  })

  it("fails values without a length prefix rather than throwing", () => {
    const is = Schema.is(Schema.Unknown.check(Borsh.maxLength(1) as never))
    for (const value of [5, null, undefined, {}, { length: 0 }, { size: 0 }]) {
      expect(is(value)).toBe(false)
    }
  })

  it("counts a byte array's bytes, as the writer does", () => {
    class ByteView extends Uint8Array {
      override get length() {
        return 0
      }
    }
    const Bounded = Borsh.Bytes.check(Borsh.maxLength(1))
    expect(Schema.is(Bounded)(new ByteView(2))).toBe(false)
    expect(Schema.is(Bounded)(new ByteView(1))).toBe(true)
  })

  it("stays a wire bound before a transformation, under catchDecoding, in groups and in withBytes", () => {
    const items = Schema.Array(Borsh.U8)
    const placements = [
      items.check(Borsh.maxLength(2)).pipe(
        Schema.decodeTo(
          Schema.Finite,
          SchemaTransformation.transform({
            decode: (array) => array.length,
            encode: (n) => Array.from({ length: n }, () => 0),
          }),
        ),
      ),
      Schema.Struct({
        field: items
          .check(Borsh.maxLength(2))
          .pipe(Schema.catchDecoding(() => Effect.succeedSome([]))),
      }),
      items.check(Schema.makeFilterGroup([Schema.isMinLength(0), Borsh.maxLength(2)] as never)),
      Borsh.withBytes(items.check(Borsh.maxLength(2))),
    ]
    const bytes = Uint8Array.of(...u32(3), 1, 2, 3)
    for (const schema of placements) {
      expect(() =>
        Schema.decodeSync(Borsh.toCodec(schema as Schema.Codec<unknown, unknown>))(bytes),
      ).toThrow(/^Length 3 exceeds maxLength \(2\) at byte 0/)
    }
  })

  it("stays a wire bound when the items, fields or keys inside transform", () => {
    const Lower = Schema.String.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transform({
          decode: (s) => s.toLowerCase(),
          encode: (s) => s,
        }),
      ),
    )
    const cases = [
      [Schema.Array(Schema.FiniteFromString), [1, 2, 3]],
      [Schema.Array(Schema.Struct({ n: Schema.FiniteFromString })), [{ n: 1 }, { n: 2 }, { n: 3 }]],
      [
        Schema.ReadonlyMap(Lower, Borsh.U8),
        new Map([
          ["a", 1],
          ["b", 2],
          ["c", 3],
        ]),
      ],
    ] as const
    for (const [schema, over] of cases) {
      const codec = Borsh.toCodec(
        (schema as Schema.Codec<unknown>).check(Borsh.maxLength(2) as never),
      )
      const bytes = Schema.encodeUnknownSync(Borsh.toCodec(schema as Schema.Codec<unknown>))(over)
      const wire = "Length 3 exceeds maxLength (2) at byte 0"
      expect(() => Schema.decodeSync(codec, { disableChecks: true })(bytes)).toThrow(wire)
      expect(() => Schema.encodeSync(codec, { disableChecks: true })(over)).toThrow(wire)
    }
    const flipped = Borsh.toCodec(Schema.flip(Schema.Array(Lower).check(Borsh.maxLength(2))))
    const bytes = Schema.encodeSync(Borsh.toCodec(Schema.Array(Schema.String)))(["a", "b", "c"])
    expect(() => Schema.decodeSync(flipped, { disableChecks: true })(bytes)).toThrow(
      "Length 3 exceeds maxLength (2) at byte 0",
    )
  })

  it("is only an ordinary check after a transformation", () => {
    const Upper = Schema.String.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transform({
          decode: (s) => s.toUpperCase(),
          encode: (s) => s.toLowerCase(),
        }),
      ),
    ).check(Borsh.maxLength(1))
    const bytes = Uint8Array.of(...u32(2), 97, 98)
    expect(() => decodes(Upper, bytes)).toThrow("Expected a Borsh length of at most 1")
    expect(Schema.decodeSync(Borsh.toCodec(Upper), { disableChecks: true })(bytes)).toBe("AB")
  })

  it("is only an ordinary check on a union with a transformed member", () => {
    // Effect keeps such a union's checks off its encoded side, as for any transformation.
    const Letters = Schema.Union([
      Schema.Literal("a"),
      Schema.Literal("b").pipe(
        Schema.decodeTo(
          Schema.Literal("bb"),
          SchemaTransformation.transform({
            decode: () => "bb" as const,
            encode: () => "b" as const,
          }),
        ),
      ),
    ]).check(Borsh.maxLength(1))
    const codec = Borsh.toCodec(Letters)
    expect(Schema.decodeSync(codec)(Uint8Array.of(0))).toBe("a")
    expect(() => Schema.decodeSync(codec)(Uint8Array.of(1))).toThrow(
      "Expected a Borsh length of at most 1",
    )
    expect(() => Schema.encodeSync(codec)("bb")).toThrow("Expected a Borsh length of at most 1")
    expect(Schema.is(Letters)("bb")).toBe(false)
    expect(Schema.decodeSync(codec, { disableChecks: true })(Uint8Array.of(1))).toBe("bb")
    // Without the transformation the bound sits on the enum's encoded side, where it is misplaced.
    expect(() => Borsh.toCodec(Schema.Literals(["a", "b"]).check(Borsh.maxLength(1)))).toThrow(
      "$: Borsh.maxLength requires a length-prefixed layout",
    )
  })

  it("throws at construction on layouts without a length prefix, and on invalid bounds", () => {
    const bound = Borsh.maxLength(2) as never
    const misplaced = [
      Borsh.fixedBytes(2).check(bound),
      Borsh.fixedArray(Borsh.U8, 2).check(bound),
      Schema.Tuple([Borsh.U8, Borsh.U8]).check(bound),
      Schema.Struct({ a: Borsh.U8 }).check(bound),
      Borsh.U32.check(bound),
      Schema.Option(Borsh.U8).check(bound),
      // Children that transform keep the bound on the encoded side, so misuse still surfaces.
      Schema.Struct({ a: Schema.FiniteFromString }).check(bound),
      Schema.Option(Schema.FiniteFromString).check(bound),
      Schema.declare((u): u is Set<unknown> => u instanceof Set).check(bound),
      // Enum variants and tags are not compiled on their own.
      Schema.Union([Schema.Literal("A").check(bound), Schema.Literal("B")]),
      Schema.Literals(["A", "B"]).check(bound),
      Schema.Union([Schema.TaggedStruct("A", {}).check(bound), Schema.TaggedStruct("B", {})]),
    ]
    for (const schema of misplaced) {
      expect(() => Borsh.toCodec(schema)).toThrow(
        "$: Borsh.maxLength requires a length-prefixed layout (string, bytes, vector, map or set)",
      )
    }
    const groupedTag = Schema.Union([
      Schema.Struct({ _tag: Schema.Literal("A").check(Schema.makeFilterGroup([bound])) }),
      Schema.TaggedStruct("B", {}),
    ])
    expect(() => Borsh.toCodec(groupedTag)).toThrow('$["_tag"]: Borsh.maxLength')
    expect(() => Borsh.toCodec(Schema.Struct({ id: Borsh.fixedBytes(2).check(bound) }))).toThrow(
      '$["id"]: Borsh.maxLength',
    )
    for (const n of [-1, 1.5, 2 ** 32, Number.NaN]) {
      expect(() => Borsh.maxLength(n)).toThrow("$: maxLength must be a safe integer")
    }
  })

  it("applies the smallest bound, ahead of maxItems, and keeps it whatever the annotations", () => {
    const smallest = Schema.Array(Borsh.U8).check(
      Borsh.maxLength(5),
      Borsh.maxLength(2),
      Borsh.maxLength(3),
    )
    expect(decodeFailure(smallest, u32(10), { maxItems: 1 }).message).toBe(
      "Length 10 exceeds maxLength (2) at byte 0",
    )
    expect(decodeFailure(smallest, u32(2), { maxItems: 1 }).message).toBe(
      "Input exceeds maxItems (1) at byte 0",
    )
    const annotated = Borsh.maxLength(1, {
      expected: "one item",
      representation: { id: "other", payload: null },
      arbitraryConstraint: { maxLength: 9 },
    })
    const schema = Schema.Array(Borsh.U8).check(annotated)
    expect(decodeFailure(schema, [...u32(2), 1, 2]).message).toBe(
      "Length 2 exceeds maxLength (1) at byte 0",
    )
    expect(encodeFailure(schema, [1, 2]).message).toBe("Expected one item")
  })

  it.each([0, 3, 10])("samples values that encode at n = %i", (n) => {
    for (const [, schema] of kinds) {
      const bounded = (schema as Schema.Codec<unknown>).check(Borsh.maxLength(n) as never)
      const encode = Schema.encodeUnknownSync(Borsh.toCodec(bounded))
      for (const value of sample(bounded, 100, n)) {
        expect(() => encode(value)).not.toThrow()
      }
    }
  })
})

describe("untrusted input", () => {
  // 16 MiB: a count of 16,777,212, then that many zero bytes, each a Noop variant.
  const Action = Schema.TaggedUnion({ Noop: {}, Transfer: { amount: Borsh.U128 } })
  const input = new Uint8Array(16 * 1024 * 1024)
  new DataView(input.buffer).setUint32(0, input.byteLength - 4, true)

  it("rejects millions of one-byte items with Borsh.maxLength before reading any", () => {
    const codec = Borsh.toCodec(Schema.Array(Action).check(Borsh.maxLength(16)))
    expect(countReads("getUint8", () => Schema.decodeSync(codec)(input))).toBe(0)
    expect(() => Schema.decodeSync(codec)(input)).toThrow(
      `Length ${input.byteLength - 4} exceeds maxLength (16) at byte 0`,
    )
  })

  it("rejects them with maxItems alone", () => {
    const codec = Borsh.toCodec(Schema.Array(Action), { maxItems: 10_000 })
    expect(countReads("getUint8", () => Schema.decodeSync(codec)(input))).toBe(0)
    expect(() => Schema.decodeSync(codec)(input)).toThrow(
      "Input exceeds maxItems (10000) at byte 0",
    )
  })

  it("runs the package README Receipt example", () => {
    const Receipt = Schema.Struct({
      logs: Schema.Array(Schema.String.check(Borsh.maxLength(1024))).check(Borsh.maxLength(100)),
      payload: Borsh.Bytes.check(Borsh.maxLength(64 * 1024)),
    })
    const codec = Borsh.toCodec(Receipt, { maxBytes: 256 * 1024, maxItems: 10_000 })
    expect(() => Schema.decodeSync(codec)(Uint8Array.of(...u32(0xffff_ffff)))).toThrow(
      /^Length 4294967295 exceeds maxLength \(100\) at byte 0\n {2}at \["logs"\]$/,
    )
    const value = { logs: ["ok"], payload: Uint8Array.of(1, 2) }
    expect(Schema.decodeSync(codec)(Schema.encodeSync(codec)(value))).toEqual(value)
  })
})
