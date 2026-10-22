import {
  Arbitrary,
  Cause,
  Context,
  Effect,
  Exit,
  Option,
  Schema,
  SchemaGetter,
  SchemaIssue,
  SchemaTransformation,
} from "effect"
import fc from "fast-check"
import { describe, expect, it } from "vite-plus/test"
import { Borsh } from "../src/index.js"

/** u32 little endian, as a Borsh length prefix. */
function u32(value: number): number[] {
  return [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, value >>> 24]
}

function repeat(byte: number, count: number): number[] {
  return Array.from({ length: count }, () => byte)
}

function str(value: string): number[] {
  return [...u32(value.length), ...Array.from(value, (char) => char.charCodeAt(0))]
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

/** The issue beneath the Encoding wrappers a codec adds around its binary failures. */
function unwrapped(issue: SchemaIssue.Issue): SchemaIssue.Issue {
  return issue._tag === "Encoding" ? unwrapped(issue.issue) : issue
}

const Frame = Schema.Struct({ id: Borsh.U32, body: Schema.String })
const frame = (id: number, body: string) => [...u32(id), ...str(body)]

describe("decodePrefixSync", () => {
  it("decodes concatenated frames in a loop that ends exactly at the end of the buffer", () => {
    const decodeFrame = Borsh.decodePrefixSync(Frame)
    const buffer = Uint8Array.of(...frame(1, "a"), ...frame(2, ""), ...frame(3, "xyz"))
    const frames: Array<typeof Frame.Type> = []
    const offsets: number[] = []
    let offset = 0
    while (offset < buffer.byteLength) {
      const next = decodeFrame(buffer, offset)
      frames.push(next.value)
      offsets.push(next.offset)
      offset = next.offset
    }
    expect(frames).toEqual([
      { id: 1, body: "a" },
      { id: 2, body: "" },
      { id: 3, body: "xyz" },
    ])
    expect(offsets).toEqual([9, 17, 28])
  })

  it("decodes a value at an offset inside an envelope and leaves the trailer", () => {
    const decodeMessage = Borsh.decodePrefixSync(Frame, { maxBytes: 64 })
    const packet = Uint8Array.of(...u32(0xfeed), ...frame(7, "hi"), 0xde, 0xad)
    const { value, offset } = decodeMessage(packet, 4)
    expect(value).toEqual({ id: 7, body: "hi" })
    expect(offset).toBe(14)
    expect([...packet.subarray(offset)]).toEqual([0xde, 0xad])
  })

  it("defaults the offset to 0 and respects a subarray's own offset", () => {
    const decode = Borsh.decodePrefixSync(Borsh.U16)
    expect(decode(Uint8Array.of(0x34, 0x12, 0xff))).toEqual({ value: 0x1234, offset: 2 })
    const view = Uint8Array.of(9, 9, 0x34, 0x12, 0xff).subarray(2)
    expect(decode(view, 1)).toEqual({ value: 0xff12, offset: 3 })
  })

  it("reports error offsets as positions in the whole buffer", () => {
    const decode = Borsh.decodePrefixSync(
      Schema.Struct({ id: Borsh.U8, note: Schema.Option(Borsh.U8) }),
    )
    const buffer = Uint8Array.of(1, 0, 2, 1, 5, 3, 7)
    expect(decode(buffer, 0)).toEqual({ value: { id: 1, note: Option.none() }, offset: 2 })
    expect(decode(buffer, 2)).toEqual({ value: { id: 2, note: Option.some(5) }, offset: 5 })
    expect(String(failure(() => decode(buffer, 5)))).toBe(
      'SchemaError(Invalid Option tag 7 at byte 6\n  at ["note"])',
    )
  })

  it("caps the value with maxBytes, not the buffer", () => {
    const decode = Borsh.decodePrefixSync(Frame, { maxBytes: 9 })
    const buffer = Uint8Array.of(...repeat(0, 100), ...frame(5, "a"), ...frame(6, "ab"))
    expect(decode(buffer, 100)).toEqual({ value: { id: 5, body: "a" }, offset: 109 })
    // The second frame needs 10 bytes; the buffer has them, but maxBytes does not allow them.
    expect(failure(() => decode(buffer, 109)).message).toBe(
      'Value exceeds maxBytes (9) at byte 117\n  at ["body"]',
    )
    // The whole-input codec still rejects the buffer up front.
    expect(() => Schema.decodeSync(Borsh.toCodec(Frame, { maxBytes: 9 }))(buffer)).toThrow(
      "Input exceeds maxBytes (9) at byte 0",
    )
  })

  it("reports a count that cannot fit in maxBytes as exceeding it, before reading any item", () => {
    const decode = Borsh.decodePrefixSync(Schema.Array(Borsh.U32), { maxBytes: 12 })
    const buffer = Uint8Array.of(...u32(3), ...repeat(1, 12))
    expect(failure(() => decode(buffer)).message).toBe("Value exceeds maxBytes (12) at byte 4")
    const fits = Uint8Array.of(...u32(2), ...repeat(1, 8), ...repeat(2, 8))
    expect(decode(fits)).toEqual({ value: [0x0101_0101, 0x0101_0101], offset: 12 })
  })

  it("reports every kind of read past maxBytes as exceeding it, however short the buffer", () => {
    // Each value starts at byte 3 and claims more than its 8 bytes; "at byte" is where it fails.
    const cases = [
      [Schema.String, [...u32(50), 97, 98], 7],
      [Borsh.Bytes, [...u32(1000)], 7],
      [Schema.Array(Borsh.U16), [...u32(10), 1, 0], 7],
      [Borsh.fixedArray(Borsh.U32, 3), [1, 0, 0, 0], 3],
      [Schema.ReadonlyMap(Borsh.U8, Borsh.U8), [...u32(5), 1, 1], 7],
    ] as const
    for (const [schema, value, at] of cases) {
      const decode = Borsh.decodePrefixSync(schema as Schema.Codec<unknown>, { maxBytes: 8 })
      const message = `Value exceeds maxBytes (8) at byte ${at}`
      // A streaming caller must not wait for more input when no amount of it could help.
      expect(failure(() => decode(Uint8Array.of(9, 9, 9, ...value), 3)).message).toBe(message)
      const long = Uint8Array.of(9, 9, 9, ...value, ...repeat(0, 64))
      expect(failure(() => decode(long, 3)).message).toBe(message)
    }
  })

  it("judges maxBytes by the current read alone, not by fields still to come", () => {
    const decode = Borsh.decodePrefixSync(
      Schema.Struct({ payload: Borsh.Bytes, tail: Borsh.U32 }),
      { maxBytes: 8 },
    )
    // The payload fits, so its truncation is reported; the tail then overruns once it arrives.
    expect(failure(() => decode(Uint8Array.of(...u32(2)))).message).toBe(
      'Truncated input: need 2 bytes at byte 4\n  at ["payload"]',
    )
    expect(failure(() => decode(Uint8Array.of(...u32(2), 1, 2))).message).toBe(
      'Value exceeds maxBytes (8) at byte 6\n  at ["tail"]',
    )
  })

  it("reports truncation when the buffer, not maxBytes, ends first", () => {
    const decode = Borsh.decodePrefixSync(Frame, { maxBytes: 64 })
    const buffer = Uint8Array.of(0, ...frame(5, "abc").slice(0, -1))
    expect(failure(() => decode(buffer, 1)).message).toBe(
      'Truncated input: need 3 bytes at byte 9\n  at ["body"]',
    )
  })

  it("gives a truncated value at the end of the buffer the same error as toCodec", () => {
    const schemas = [
      Frame,
      Schema.Array(Borsh.U16),
      Borsh.fixedArray(Borsh.U8, 4),
      Schema.ReadonlyMap(Borsh.U8, Borsh.U8),
    ] as const
    const inputs = [
      Uint8Array.of(...frame(5, "abc").slice(0, -1)),
      Uint8Array.of(...u32(2), 1, 0, 2),
      Uint8Array.of(1, 2, 3),
      Uint8Array.of(...u32(2), 1, 1),
    ]
    schemas.forEach((schema, i) => {
      const input = inputs[i] as Uint8Array
      const whole = failure(() => Schema.decodeSync(Borsh.toCodec(schema))(input))
      const prefix = failure(() => Borsh.decodePrefixSync(schema)(input))
      expect(prefix.message).toBe(whole.message)
      expect(prefix.issue).toEqual(unwrapped(whole.issue))
    })
  })

  it("runs the same schema pass as toCodec", () => {
    const Checked = Schema.Struct({
      a: Borsh.U8.check(Schema.isLessThan(5)),
      b: Borsh.U8.check(Schema.isLessThan(5)),
    })
    const input = Uint8Array.of(9, 9, 0)
    const whole = failure(() => Schema.decodeSync(Borsh.toCodec(Checked))(input.subarray(0, 2)))
    const prefix = failure(() => Borsh.decodePrefixSync(Checked)(input))
    expect(prefix.message).toBe(whole.message)
    // The root of the issue is the schema's own node; toCodec's names its codec instead.
    expect(prefix.issue).toMatchObject({ _tag: "Composite", ast: Checked.ast })
    expect(prefix.issue._tag === "Composite" && prefix.issue.issues).toEqual(
      whole.issue._tag === "Composite" && whole.issue.issues,
    )
    const Text = Borsh.U8.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transform({ decode: String, encode: Number }),
      ),
    )
    expect(Borsh.decodePrefixSync(Text)(Uint8Array.of(3, 0))).toEqual({ value: "3", offset: 1 })
  })

  it("enforces Borsh.maxLength and maxItems inside the value, at absolute offsets", () => {
    const Bounded = Schema.Struct({
      tag: Borsh.U8,
      items: Schema.Array(Borsh.U8).check(Borsh.maxLength(2)),
    })
    const buffer = Uint8Array.of(0, 0, 0, 7, ...u32(3), 1, 2, 3)
    const decodeBounded = Borsh.decodePrefixSync(Bounded)
    for (const options of [undefined, { disableChecks: true }]) {
      expect(failure(() => decodeBounded(buffer, 3, options)).message).toBe(
        'Length 3 exceeds maxLength (2) at byte 4\n  at ["items"]',
      )
    }
    const decodeBudgeted = Borsh.decodePrefixSync(Schema.Array(Borsh.U8), { maxItems: 2 })
    expect(failure(() => decodeBudgeted(buffer, 4)).message).toBe(
      "Input exceeds maxItems (2) at byte 4",
    )
  })

  it("gives every call its own maxItems budget", () => {
    const decode = Borsh.decodePrefixSync(Schema.Array(Borsh.U8), { maxItems: 2 })
    const buffer = Uint8Array.of(...u32(2), 1, 2, ...u32(2), 3, 4)
    expect(decode(buffer, 0)).toEqual({ value: [1, 2], offset: 6 })
    expect(decode(buffer, 6)).toEqual({ value: [3, 4], offset: 12 })
  })

  it("passes parse options through to the binary layer and the schema pass", () => {
    const Checked = Schema.Struct({
      a: Borsh.U8.check(Schema.isLessThan(5)),
      b: Borsh.U8.check(Schema.isLessThan(5)),
    })
    const decode = Borsh.decodePrefixSync(Checked)
    const input = Uint8Array.of(9, 9)
    expect(failure(() => decode(input)).message).toBe('Expected a value less than 5\n  at ["a"]')
    expect(failure(() => decode(input, 0, { errors: "all" })).message).toBe(
      'Expected a value less than 5\n  at ["a"]\nExpected a value less than 5\n  at ["b"]',
    )
    expect(decode(input, 0, { disableChecks: true })).toEqual({ value: { a: 9, b: 9 }, offset: 2 })
  })

  it("throws a RangeError, not a SchemaError, for an offset outside the buffer", () => {
    const decode = Borsh.decodePrefixSync(Borsh.U8)
    const buffer = Uint8Array.of(1, 2)
    for (const offset of [-1, 3, 0.5, Number.NaN, Infinity, 2 ** 53]) {
      expect(() => decode(buffer, offset)).toThrow(
        new RangeError(`Prefix offset must be an integer from 0 through 2, got ${offset}`),
      )
    }
  })

  it("throws a TypeError for bytes that are not a Uint8Array, or an offset that is not a number", () => {
    const decode = Borsh.decodePrefixSync(Borsh.U8)
    expect(() => decode([1, 2] as never)).toThrow(
      new TypeError("Prefix decoding requires a Uint8Array"),
    )
    // Parse options go third, unlike with Schema.decodeSync.
    for (const offset of [{ errors: "all" }, "1", null]) {
      expect(() => decode(Uint8Array.of(1), offset as never)).toThrow(
        new TypeError("Prefix offset must be a number; parse options are the third argument"),
      )
    }
  })

  it("accepts the end of the buffer as an offset, where any value is truncated", () => {
    const decode = Borsh.decodePrefixSync(Borsh.U8)
    expect(failure(() => decode(Uint8Array.of(1, 2), 2)).message).toBe(
      "Truncated input: need 1 bytes at byte 2",
    )
    expect(failure(() => decode(new Uint8Array(0))).message).toBe(
      "Truncated input: need 1 bytes at byte 0",
    )
  })

  it("lets decoding middleware recover from schema-pass failures, but not binary ones", () => {
    // toCodec can recover from both; a prefix decoder has no end offset for a value it never read.
    const Recovering = Schema.Boolean.pipe(Schema.catchDecoding(() => Effect.succeedSome(false)))
    expect(Schema.decodeSync(Borsh.toCodec(Recovering))(Uint8Array.of(2))).toBe(false)
    expect(failure(() => Borsh.decodePrefixSync(Recovering)(Uint8Array.of(2))).message).toBe(
      "Invalid bool tag 2 at byte 0",
    )
    const Checked = Schema.Struct({ a: Borsh.U8.check(Schema.isLessThan(5)) }).pipe(
      Schema.catchDecoding(() => Effect.succeedSome({ a: 0 })),
    )
    expect(Schema.decodeSync(Borsh.toCodec(Checked))(Uint8Array.of(9))).toEqual({ a: 0 })
    expect(Borsh.decodePrefixSync(Checked)(Uint8Array.of(9, 7))).toEqual({
      value: { a: 0 },
      offset: 1,
    })
  })

  it("rethrows defects from the schema unchanged", () => {
    const defect = new Error("boom")
    const Exploding = Borsh.U8.pipe(
      Schema.decodeTo(Schema.Finite, {
        decode: SchemaGetter.transform(() => {
          throw defect
        }),
        encode: SchemaGetter.transform((value) => value),
      }),
    )
    expect(() => Borsh.decodePrefixSync(Exploding)(Uint8Array.of(1))).toThrow(defect)
  })
})

describe("decodePrefixEffect", () => {
  class Label extends Context.Service<Label, { readonly label: string }>()("Label") {}
  const Labelled = Borsh.U8.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformEffect({
        decode: (n) => Effect.map(Label, ({ label }) => `${label}${n}`),
        encode: (value) => Effect.succeed(Number(value.slice(1))),
      }),
    ),
  )

  it("decodes frames in a loop with the schema's services", () => {
    const decodeFrame = Borsh.decodePrefixEffect(Labelled)
    const decodeAll = Effect.fnUntraced(function* (buffer: Uint8Array) {
      const frames: string[] = []
      let offset = 0
      while (offset < buffer.byteLength) {
        const next = yield* decodeFrame(buffer, offset)
        frames.push(next.value)
        offset = next.offset
      }
      return frames
    })
    const frames = Effect.runSync(
      decodeAll(Uint8Array.of(1, 2, 3)).pipe(Effect.provideService(Label, { label: "#" })),
    )
    expect(frames).toEqual(["#1", "#2", "#3"])
  })

  it("fails with the same SchemaError as the sync variant", () => {
    const decode = Borsh.decodePrefixEffect(Frame, { maxBytes: 9 })
    const buffer = Uint8Array.of(...frame(6, "ab"), 0)
    const exit = Effect.runSyncExit(decode(buffer, 0, { errors: "all" }))
    const expected = failure(() => Borsh.decodePrefixSync(Frame, { maxBytes: 9 })(buffer))
    expect(exit).toEqual(Exit.fail(expected))
    const checked = Borsh.decodePrefixEffect(
      Schema.Struct({
        a: Borsh.U8.check(Schema.isLessThan(5)),
        b: Borsh.U8.check(Schema.isLessThan(5)),
      }),
    )
    const all = Effect.runSyncExit(checked(Uint8Array.of(9, 9), 0, { errors: "all" }))
    expect(Exit.isFailure(all) && String(Cause.squash(all.cause))).toContain('at ["b"]')
  })

  it("dies with a RangeError for an offset outside the buffer, when run", () => {
    const decode = Borsh.decodePrefixEffect(Borsh.U8)
    const effect = decode(Uint8Array.of(1), 2)
    const exit = Effect.runSyncExit(effect)
    expect(exit).toEqual(
      Exit.die(new RangeError("Prefix offset must be an integer from 0 through 1, got 2")),
    )
  })

  it("caps the value with maxBytes at an offset, and reports absolute error offsets", () => {
    const decode = Borsh.decodePrefixEffect(Frame, { maxBytes: 9 })
    const buffer = Uint8Array.of(0xff, ...frame(5, "a"), ...frame(6, "ab"))
    expect(Effect.runSync(decode(buffer, 1))).toEqual({ value: { id: 5, body: "a" }, offset: 10 })
    const exit = Effect.runSyncExit(decode(buffer, 10))
    expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toBe(
      'SchemaError(Value exceeds maxBytes (9) at byte 18\n  at ["body"])',
    )
  })

  it("fails binary reads that decoding middleware on the schema would recover in toCodec", () => {
    const Recovering = Schema.Boolean.pipe(Schema.catchDecoding(() => Effect.succeedSome(false)))
    const exit = Effect.runSyncExit(Borsh.decodePrefixEffect(Recovering)(Uint8Array.of(2)))
    expect(exit).toEqual(
      Exit.fail(failure(() => Borsh.decodePrefixSync(Recovering)(Uint8Array.of(2)))),
    )
  })

  it("dies with a TypeError for bytes that are not a Uint8Array", () => {
    const exit = Effect.runSyncExit(Borsh.decodePrefixEffect(Borsh.U8)([1] as never))
    expect(exit).toEqual(Exit.die(new TypeError("Prefix decoding requires a Uint8Array")))
  })

  it("reads the buffer when run, not when the effect is built", () => {
    const decode = Borsh.decodePrefixEffect(Borsh.U8)
    const buffer = Uint8Array.of(1)
    const effect = decode(buffer)
    buffer[0] = 2
    expect(Effect.runSync(effect)).toEqual({ value: 2, offset: 1 })
  })
})

describe("zero-sized schemas", () => {
  const zeroSized = [
    Borsh.Unit,
    Schema.Struct({}),
    Borsh.fixedBytes(0),
    Borsh.fixedArray(Borsh.U32, 0),
    Borsh.fixedArray(Borsh.Unit, 3),
    Schema.Tuple([Borsh.Unit, Schema.Struct({ empty: Schema.Struct({}) })]),
    Borsh.Unit.pipe(
      Schema.decodeTo(Schema.Literal("unit"), {
        decode: SchemaGetter.transform(() => "unit" as const),
        encode: SchemaGetter.transform(() => [] as const),
      }),
    ),
  ]

  it("throw at construction, because a decoding loop would never advance", () => {
    for (const schema of zeroSized) {
      const message =
        "$: Prefix decoding requires a schema that encodes to at least one byte; this one always encodes to zero bytes, so a decoding loop would never advance"
      expect(() => Borsh.decodePrefixSync(schema as Schema.Codec<unknown>)).toThrow(message)
      expect(() => Borsh.decodePrefixEffect(schema)).toThrow(message)
    }
  })

  it("exclude Rust zero-sized types that still write a byte, such as a one-variant enum", () => {
    const Single = Schema.TaggedUnion({ Only: {} })
    expect(() => Borsh.toCodec(Schema.Array(Single))).not.toThrow()
    expect(() =>
      Schema.decodeSync(Borsh.toCodec(Schema.Array(Single)))(Uint8Array.of(0, 0, 0, 0)),
    ).toThrow("Borsh forbids vectors of zero-sized values")
    expect(Borsh.decodePrefixSync(Single)(Uint8Array.of(0, 0))).toEqual({
      value: { _tag: "Only" },
      offset: 1,
    })
    expect(Borsh.decodePrefixSync(Schema.Literals(["Only"]))(Uint8Array.of(0))).toEqual({
      value: "Only",
      offset: 1,
    })
    expect(Borsh.decodePrefixSync(Schema.Option(Borsh.Unit))(Uint8Array.of(1))).toEqual({
      value: Option.some([]),
      offset: 1,
    })
  })

  // Leaves that encode to zero bytes, a fixed width, a prefix or a tag, combined into composites.
  const leaves: ReadonlyArray<Schema.Codec<unknown>> = [
    Borsh.Unit,
    Schema.Struct({}),
    Borsh.fixedBytes(0),
    Borsh.fixedBytes(2),
    Borsh.U8,
    Schema.Boolean,
    Borsh.Bytes,
    Schema.Array(Borsh.U8),
    Schema.TaggedUnion({ Only: {} }),
    Schema.Literals(["Only"]),
    Schema.Literals(["A", "B"]),
  ] as never
  const schemas = fc.letrec<{ schema: Schema.Codec<unknown> }>((tie) => ({
    schema: fc.oneof(
      { depthSize: "small", withCrossShrink: true },
      fc.constantFrom(...leaves),
      fc
        .array(tie("schema"), { maxLength: 3 })
        .map((fields) =>
          Schema.Struct(Object.fromEntries(fields.map((field, i) => [`f${i}`, field]))),
        ),
      fc.array(tie("schema"), { maxLength: 3 }).map((items) => Schema.Tuple(items)),
      fc.tuple(tie("schema"), fc.nat(2)).map(([item, length]) => Borsh.fixedArray(item, length)),
      tie("schema").map((item) => Schema.Option(item)),
      tie("schema").map((item) => Schema.TaggedUnion({ Only: { item } })),
      tie("schema").map((item) => Schema.TaggedUnion({ Empty: {}, Full: { item } })),
      fc.tuple(tie("schema"), tie("schema")).map(([ok, err]) => Schema.Result(ok, err)),
      tie("schema").map((value) => Schema.ReadonlyMap(Borsh.U8, value)),
    ) as fc.Arbitrary<Schema.Codec<unknown>>,
  })).schema

  it("are exactly the schemas whose every value encodes to zero bytes", () => {
    fc.assert(
      fc.property(schemas, fc.nat(), (schema, seed) => {
        const encode = Schema.encodeSync(Borsh.toCodec(schema))
        const values = Effect.runSync(
          Arbitrary.sampleEffect(Arbitrary.schema(schema), { count: 8, seed }),
        )
        const lengths = values.map((value) => encode(value).byteLength)
        let decode: ((bytes: Uint8Array, offset?: number) => Borsh.Prefix<unknown>) | undefined
        try {
          decode = Borsh.decodePrefixSync(schema)
        } catch {
          expect(lengths.every((length) => length === 0)).toBe(true)
          return
        }
        expect(lengths.every((length) => length > 0)).toBe(true)
        // Every sample decodes as a prefix and reports where it ended.
        for (const value of values) {
          const bytes = encode(value)
          const framed = Uint8Array.of(0xaa, ...bytes, 0xbb)
          expect(decode(framed, 1).offset).toBe(1 + bytes.byteLength)
        }
      }),
      { numRuns: 200, seed: 20261022 },
    )
  })
})
