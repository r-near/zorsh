import {
  Effect,
  Equal,
  Exit,
  HashMap,
  Option,
  Result,
  Schema,
  SchemaAST,
  SchemaIssue,
  SchemaTransformation,
} from "effect"
import fc from "fast-check"
import { describe, expect, it, vi } from "vite-plus/test"
import { Borsh } from "../src/index.js"
import { compile } from "../src/internal/compiler.js"
import { Reader, Writer } from "../src/internal/io.js"
import { noLimits } from "../src/internal/limits.js"

/** u32 little endian, as a Borsh length prefix. */
function u32(value: number): number[] {
  return [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, value >>> 24]
}

function str(value: string): number[] {
  return [...u32(value.length), ...Array.from(value, (char) => char.charCodeAt(0))]
}

const singular = { items: "item", bytes: "byte", entries: "entry", members: "member" } as const

/** The count part of an early check failure, as in "got 1 item" or "got 4 items". */
function got(count: number, unit: keyof typeof singular): string {
  return `got ${count} ${count === 1 ? singular[unit] : unit}`
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

function decodeFailure(schema: Schema.Top, bytes: ArrayLike<number>, options?: Borsh.Options) {
  return failure(() => decodes(schema, bytes, options))
}

/** The Filter issues in an issue tree, in order. */
function filters(issue: SchemaIssue.Issue): Array<SchemaIssue.Filter> {
  switch (issue._tag) {
    case "Filter":
      return [issue, ...filters(issue.issue)]
    case "Encoding":
    case "Pointer":
      return filters(issue.issue)
    case "Composite":
    case "AnyOf":
      return issue.issues.flatMap(filters)
  }
  return []
}

function decodes(schema: Schema.Top, bytes: ArrayLike<number>, options?: Borsh.Options): unknown {
  const codec = Borsh.toCodec(schema as Schema.Codec<unknown, unknown>, options)
  return Schema.decodeSync(codec)(Uint8Array.from(bytes))
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

describe("early length and size checks", () => {
  it("fails Schema.isMaxLength on a vector after its prefix, before any item is read", () => {
    const check = Schema.isMaxLength(1)
    const schema = Schema.Array(Borsh.U32).check(check)
    const bytes = [...u32(4), ...u32(1), ...u32(2), ...u32(3), ...u32(4)]
    const error = decodeFailure(schema, bytes)
    expect(error.message).toBe("Expected a value with a length of at most 1, got 4 items at byte 0")
    const [filter, ...rest] = filters(error.issue)
    expect(filter?.filter).toBe(check)
    expect(filter?.issue).toBeInstanceOf(SchemaIssue.InvalidValue)
    expect(rest).toEqual([])
    // Only the prefix is read; before early checks, all four items were read first.
    expect(countReads("getUint32", () => decodes(schema, bytes))).toBe(1)
    // A prefix with no payload fails the check rather than reporting truncation.
    expect(decodeFailure(schema, u32(4)).message).toMatch(/at most 1, got 4 items at byte 0$/)
    expect(decodes(schema, [...u32(1), ...u32(9)])).toEqual([9])
  })

  it("reports the path and the offset of the length prefix", () => {
    const schema = Schema.Struct({
      flag: Borsh.U8,
      logs: Schema.Array(Schema.String).check(Schema.isMaxLength(100)),
    })
    const error = decodeFailure(schema, [1, ...u32(0xffff_ffff)])
    expect(error.message).toBe(
      'Expected a value with a length of at most 100, got 4294967295 items at byte 1\n  at ["logs"]',
    )
    const nested = Schema.Array(Schema.Array(Borsh.U8).check(Schema.isNonEmpty()))
    expect(decodeFailure(nested, [...u32(2), ...u32(1), 7, ...u32(0)]).message).toBe(
      "Expected a value with a length of at least 1, got 0 items at byte 9\n  at [1]",
    )
  })

  it("enforces every Effect length check on vectors and Borsh.Bytes", () => {
    const cases = [
      [Schema.isMinLength(2), 1, "Expected a value with a length of at least 2"],
      [Schema.isNonEmpty(), 0, "Expected a value with a length of at least 1"],
      [Schema.isMaxLength(2), 3, "Expected a value with a length of at most 2"],
      [Schema.isBetweenLength(2, 3), 1, "Expected a value with a length between 2 and 3"],
      [Schema.isBetweenLength(2, 3), 4, "Expected a value with a length between 2 and 3"],
      [Schema.isBetweenLength(2, 2), 3, "Expected a value with a length of 2"],
    ] as const
    for (const [check, count, expected] of cases) {
      const vector = Schema.Array(Borsh.U8).check(check)
      const vectorError = decodeFailure(vector, [
        ...u32(count),
        ...Array.from({ length: count }, () => 0),
      ])
      expect(vectorError.message).toBe(`${expected}, ${got(count, "items")} at byte 0`)
      expect(filters(vectorError.issue)[0]?.filter).toBe(check)
      const bytes = Borsh.Bytes.check(check)
      const bytesError = decodeFailure(bytes, [
        ...u32(count),
        ...Array.from({ length: count }, () => 0),
      ])
      expect(bytesError.message).toBe(`${expected}, ${got(count, "bytes")} at byte 0`)
      expect(filters(bytesError.issue)[0]?.filter).toBe(check)
    }
    expect(decodes(Borsh.Bytes.check(Schema.isBetweenLength(1, 2)), [...u32(2), 5, 6])).toEqual(
      Uint8Array.of(5, 6),
    )
  })

  it("enforces every Effect size check on maps and sets", () => {
    const cases = [
      [Schema.isMinSize(2), 1, "Expected a value with a size of at least 2"],
      [Schema.isMaxSize(1), 2, "Expected a value with a size of at most 1"],
      [Schema.isBetweenSize(1, 2), 0, "Expected a value with a size between 1 and 2"],
      [Schema.isBetweenSize(1, 2), 3, "Expected a value with a size between 1 and 2"],
    ] as const
    for (const [check, count, expected] of cases) {
      const keys = Array.from({ length: count }, (_, i) => i)
      const schemas = [
        [Schema.ReadonlyMap(Borsh.U8, Borsh.U8).check(check), "entries", true],
        // Effect's types leave size checks off HashMap and HashSet, but they can be added.
        [Schema.HashMap(Borsh.U8, Borsh.U8).check(check as never), "entries", true],
        [Schema.ReadonlySet(Borsh.U8).check(check), "members", false],
        [Schema.HashSet(Borsh.U8).check(check as never), "members", false],
      ] as const
      for (const [schema, unit, hasValues] of schemas) {
        const entries = keys.flatMap((key) => (hasValues ? [key, 9] : [key]))
        const error = decodeFailure(schema, [...u32(count), ...entries])
        expect(error.message).toBe(`${expected}, ${got(count, unit)} at byte 0`)
        expect(filters(error.issue)[0]?.filter).toBe(check)
      }
    }
    const set = Schema.ReadonlySet(Borsh.U8).check(Schema.isBetweenSize(1, 2))
    expect(decodes(set, [...u32(2), 1, 2])).toEqual(new Set([1, 2]))
    const map = Schema.HashMap(Borsh.U8, Borsh.U8).check(Schema.isMinSize(1) as never)
    expect(Equal.equals(decodes(map, [...u32(1), 1, 2]), HashMap.make([1, 2]))).toBe(true)
  })

  it("finds checks in filter groups and reports the first failing one in schema order", () => {
    const min = Schema.isMinLength(1)
    const max = Schema.isMaxLength(3)
    const grouped = Schema.Array(Borsh.U8).check(Schema.makeFilterGroup([min, max]))
    expect(filters(decodeFailure(grouped, u32(4)).issue)[0]?.filter).toBe(max)
    expect(filters(decodeFailure(grouped, u32(0)).issue)[0]?.filter).toBe(min)
    const loose = Schema.isMaxLength(10)
    const tight = Schema.isMaxLength(5)
    const ordered = Schema.Array(Borsh.U8).check(loose, tight)
    expect(filters(decodeFailure(ordered, u32(7)).issue)[0]?.filter).toBe(tight)
    expect(filters(decodeFailure(ordered, u32(20)).issue)[0]?.filter).toBe(loose)
    const sized = Schema.ReadonlySet(Borsh.U8).check(
      Schema.makeFilterGroup([Schema.isMinSize(0), Schema.makeFilterGroup([Schema.isMaxSize(1)])]),
    )
    expect(decodeFailure(sized, u32(2)).message).toBe(
      "Expected a value with a size of at most 1, got 2 members at byte 0",
    )
  })

  it("keeps a custom message and falls back when a check has no wording", () => {
    const custom = Schema.Array(Borsh.U8).check(
      Schema.isMaxLength(1, { message: "too many items" }),
    )
    expect(decodeFailure(custom, u32(4)).message).toBe("too many items, got 4 items at byte 0")
    const unnamed = Schema.Array(Borsh.U8).check(Schema.isMaxLength(1, { expected: undefined }))
    expect(decodeFailure(unnamed, u32(4)).message).toBe(
      "Failed length check, got 4 items at byte 0",
    )
    const unnamedSize = Schema.ReadonlySet(Borsh.U8).check(
      Schema.isMaxSize(1, { expected: undefined }),
    )
    expect(decodeFailure(unnamedSize, u32(2)).message).toBe(
      "Failed size check, got 2 members at byte 0",
    )
  })

  it("enforces from-side checks on a transformed root", () => {
    const schema = Schema.Array(Borsh.U32)
      .check(Schema.isMaxLength(1))
      .pipe(Schema.decodeTo(Schema.Array(Schema.Finite), SchemaTransformation.passthrough()))
    expect(decodeFailure(schema, u32(4)).message).toBe(
      "Expected a value with a length of at most 1, got 4 items at byte 0",
    )
  })

  it("skips early checks under disableChecks, as the schema pass does", () => {
    const schema = Schema.Array(Borsh.U8).check(Schema.isMaxLength(1))
    const codec = Borsh.toCodec(schema)
    const bytes = Uint8Array.of(...u32(2), 1, 2)
    expect(Schema.decodeSync(codec, { disableChecks: true })(bytes)).toEqual([1, 2])
    expect(() => Schema.decodeSync(codec)(bytes)).toThrow(/got 2 items at byte 0/)
    const set = Schema.ReadonlySet(Borsh.U8).check(Schema.isMinSize(1))
    expect(
      Schema.decodeSync(Borsh.toCodec(set), { disableChecks: true })(Uint8Array.of(...u32(0))),
    ).toEqual(new Set())
  })

  it('reports one length issue, and reads no items, under errors: "all"', () => {
    const schema = Schema.Array(Borsh.U8.check(Schema.isLessThan(5))).check(Schema.isMaxLength(1))
    const codec = Borsh.toCodec(schema)
    const error = failure(() =>
      Schema.decodeSync(codec, { errors: "all" })(Uint8Array.of(...u32(2), 9, 9)),
    )
    expect(error.message).toBe("Expected a value with a length of at most 1, got 2 items at byte 0")
  })

  it("does not report the decoded value, which is never built", () => {
    const schema = Schema.Array(Borsh.U8).check(Schema.isMaxLength(1))
    const error = failure(() =>
      Schema.decodeSync(Borsh.toCodec(schema), { reportInput: true })(Uint8Array.of(...u32(2))),
    )
    const [filter] = filters(error.issue)
    expect(filter === undefined ? undefined : SchemaIssue.hasInput(filter)).toBe(false)
  })
})

describe("checks the binary layer leaves to the schema pass", () => {
  it("ignores arbitraryConstraint, which is only a generation hint", () => {
    const hinted = Schema.Array(Borsh.U8).check(
      Schema.makeFilter((items) => items.length <= 10, { arbitraryConstraint: { maxLength: 1 } }),
    )
    expect(decodes(hinted, [...u32(3), 1, 2, 3])).toEqual([1, 2, 3])
  })

  it("leaves custom filters opaque", () => {
    const custom = Schema.Array(Borsh.U8).check(Schema.makeFilter((items) => items.length < 2))
    expect(decodeFailure(custom, u32(5)).message).toBe("Truncated vector payload at byte 4")
    expect(decodeFailure(custom, [...u32(2), 1, 2]).message).toMatch(/^Expected <filter>/)
  })

  it("does not recognise a check whose representation is overridden or malformed", () => {
    const overridden = Schema.isMaxLength(1, { representation: { id: "app/limit", payload: null } })
    const forged = (id: string, payload: Schema.Json) =>
      Schema.makeFilter((value: { readonly length: number }) => value.length <= 1, {
        representation: { id: `effect/schema/${id}`, payload },
      })
    for (const check of [
      overridden,
      forged("isBetweenLength", null),
      forged("isBetweenLength", 7),
      forged("isBetweenLength", { minimum: 0 }),
      forged("isBetweenLength", { minimum: 0, maximum: "1" }),
      forged("isBetweenLength", { minimum: 0, maximum: 1.5 }),
      forged("isBetweenLength", { minimum: -1, maximum: 1 }),
      forged("isMinLength", { minLength: "1" }),
      forged("isMaxLength", { length: 1 }),
    ]) {
      const schema = Schema.Array(Borsh.U8).check(check)
      expect(decodeFailure(schema, u32(5)).message).toBe("Truncated vector payload at byte 4")
    }
    for (const check of [forged("isMinSize", { minSize: null }), forged("isMaxSize", [1])]) {
      const schema = Schema.ReadonlySet(Borsh.U8).check(check as never)
      expect(decodeFailure(schema, u32(5)).message).toBe("Truncated collection payload at byte 4")
    }
  })

  it("trusts a filter that copies an Effect representation to implement its predicate", () => {
    const copied = Schema.makeFilter((items: ReadonlyArray<number>) => items.length <= 1, {
      expected: "at most one item",
      representation: { id: "effect/schema/isMaxLength", payload: { maxLength: 1 } },
    })
    const schema = Schema.Array(Borsh.U8).check(copied)
    expect(decodeFailure(schema, u32(5)).message).toBe(
      "Expected at most one item, got 5 items at byte 0",
    )
  })

  it("leaves checks after a transformation to the schema pass", () => {
    const schema = Schema.Array(Borsh.U32).pipe(
      Schema.decodeTo(
        Schema.Array(Schema.Finite).check(Schema.isMaxLength(1)),
        SchemaTransformation.passthrough(),
      ),
    )
    expect(decodeFailure(schema, u32(4)).message).toBe("Truncated vector payload at byte 4")
    expect(decodeFailure(schema, [...u32(2), ...u32(1), ...u32(2)]).message).toBe(
      "Expected a value with a length of at most 1",
    )
  })

  it("leaves checks beneath decoding middleware, which can recover from them", () => {
    const recoverEmpty = Schema.catchDecoding(() => Effect.succeedSome([]))
    const capped = Schema.Array(Borsh.U8).check(Schema.isMaxLength(1))
    const twoItems = [...u32(2), 1, 2]
    // Recovery in a field only sees the schema pass, so failing early would bypass it.
    expect(decodes(Schema.Struct({ array: capped.pipe(recoverEmpty) }), twoItems)).toEqual({
      array: [],
    })
    const batch = Schema.Array(Schema.Struct({ array: capped })).pipe(recoverEmpty)
    expect(decodes(Schema.Struct({ batch }), [...u32(1), ...twoItems])).toEqual({ batch: [] })
    expect(decodes(capped.pipe(recoverEmpty), twoItems)).toEqual([])
    const pair = Schema.Struct({ a: capped, b: capped }).pipe(
      Schema.catchDecoding(() => Effect.succeedSome({ a: [], b: [] })),
    )
    expect(decodes(pair, [...twoItems, ...twoItems])).toEqual({ a: [], b: [] })
    // Recovery around a declaration covers the checks in its type parameters.
    const option = Schema.Option(capped).pipe(
      Schema.catchDecoding(() => Effect.succeedSome(Option.none())),
    )
    expect(decodes(Schema.Struct({ option }), [1, ...twoItems])).toEqual({ option: Option.none() })
    // Flipping encoding middleware makes it decoding middleware, with the checks in encodingChecks.
    const flipped = Schema.flip(capped.pipe(Schema.catchEncoding(() => Effect.succeedSome([]))))
    expect(decodes(Schema.Struct({ flipped }), twoItems)).toEqual({ flipped: [] })
    // The check object is shared, so outside the middleware it also waits for the schema pass.
    const shared = Schema.Struct({ plain: capped, recovered: capped.pipe(recoverEmpty) })
    expect(decodeFailure(shared, [...twoItems, ...twoItems]).message).toBe(
      'Expected a value with a length of at most 1\n  at ["plain"]',
    )
  })

  it("leaves checks in a union with decoding middleware, whose member can stand in", () => {
    const A = Schema.TaggedStruct("A", { xs: Schema.Array(Borsh.U8).check(Schema.isMaxLength(1)) })
    const B = Schema.TaggedStruct("B", { n: Borsh.U8 }).pipe(
      Schema.catchDecoding(() => Effect.succeedSome({ _tag: "B" as const, n: 0 })),
    )
    // Effect tries B for every input, so its fallback replaces an A that fails the check.
    const oversizedA = [0, ...u32(2), 1, 2]
    expect(decodes(Schema.Union([A, B]), oversizedA)).toEqual({ _tag: "B", n: 0 })
    expect(decodes(Schema.Union([B, A]), [1, ...u32(2), 1, 2])).toEqual({ _tag: "B", n: 0 })
    // Middleware deeper in a member does not match other tags, but is deferred all the same.
    const deep = Schema.TaggedStruct("B", {
      n: Borsh.U8.pipe(Schema.catchDecoding(() => Effect.succeedSome(0))),
    })
    expect(decodeFailure(Schema.Union([A, deep]), oversizedA).message).toBe(
      'Expected a value with a length of at most 1\n  at ["xs"]',
    )
  })

  it("still enforces checks beneath encoding-only middleware", () => {
    const schema = Schema.Array(Borsh.U8)
      .check(Schema.isMaxLength(1))
      .pipe(Schema.middlewareEncoding((effect) => effect))
    expect(decodeFailure(schema, u32(5)).message).toBe(
      `Expected a value with a length of at most 1, ${got(5, "items")} at byte 0`,
    )
  })

  it("leaves string lengths, which count UTF-16 units rather than prefix bytes", () => {
    const schema = Schema.String.check(Schema.isMaxLength(1))
    expect(decodeFailure(schema, u32(5)).message).toBe("Truncated input: need 5 bytes at byte 4")
    // Three UTF-8 bytes are one UTF-16 unit, so the prefix alone cannot decide.
    expect(decodes(schema, [...u32(3), 0xe4, 0xb8, 0xad])).toBe("中")
  })

  it("leaves tuples, fixed arrays and fixed bytes, whose length is fixed by the schema", () => {
    const tuple = Schema.Tuple([Borsh.U8, Borsh.U8]).check(Schema.isMaxLength(1))
    expect(decodeFailure(tuple, [1]).message).toBe(
      "Truncated input: need 1 bytes at byte 1\n  at [1]",
    )
    const fixed = Schema.Array(Borsh.U8).check(Schema.isMaxLength(1)).pipe(Borsh.fixedArray(2))
    expect(decodeFailure(fixed, [1]).message).toBe("Truncated fixed array payload at byte 0")
    const fixedBytes = Borsh.fixedBytes(2).check(Schema.isMaxLength(1))
    expect(decodeFailure(fixedBytes, [1]).message).toBe("Truncated input: need 2 bytes at byte 0")
  })

  it("leaves the maximum size of maps and sets whose keys can merge", () => {
    // "01" and "1" are distinct wire keys that both decode to 1, so Effect accepts size 1.
    const wireKeys = [...u32(2), ...str("01"), 7, ...str("1"), 8]
    const lossy = Schema.ReadonlyMap(Schema.FiniteFromString, Borsh.U8).check(Schema.isMaxSize(1))
    expect(decodes(lossy, wireKeys)).toEqual(new Map([[1, 8]]))
    const between = Schema.HashMap(Schema.FiniteFromString, Borsh.U8).check(
      Schema.isBetweenSize(1, 1) as never,
    )
    expect(Equal.equals(decodes(between, wireKeys), HashMap.make([1, 8]))).toBe(true)
    // Merging only shrinks a collection, so its minimum still fails early.
    expect(decodeFailure(between, u32(0)).message).toBe(
      "Expected a value with a size of 1, got 0 entries at byte 0",
    )
    const set = Schema.ReadonlySet(Schema.FiniteFromString).check(Schema.isMaxSize(1))
    expect(decodes(set, [...u32(2), ...str("01"), ...str("1")])).toEqual(new Set([1]))
  })

  it("skips a maximum size shared by a merging map and a plain one for both", () => {
    const max = Schema.isMaxSize(1)
    const schema = Schema.Struct({
      plain: Schema.ReadonlyMap(Schema.String, Borsh.U8).check(max),
      lossy: Schema.ReadonlyMap(Schema.FiniteFromString, Borsh.U8).check(max),
    })
    expect(decodeFailure(schema, u32(2)).message).toBe(
      'Truncated collection payload at byte 4\n  at ["plain"]',
    )
    const plain = Schema.ReadonlyMap(Schema.String, Borsh.U8).check(Schema.isMaxSize(1))
    expect(decodeFailure(plain, u32(2)).message).toMatch(/got 2 entries at byte 0$/)
  })

  it("enforces a flipped schema's checks, which Effect runs on the wire-side collection", () => {
    // Flipped, the key's encode turns "01" and "1" into 1, but the size checks see the wire map.
    const key = Borsh.U8.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transform({ decode: String, encode: (value) => Number(value) }),
      ),
    )
    const wireKeys = [...u32(2), ...str("01"), 7, ...str("1"), 8]
    const atMost = Schema.flip(Schema.ReadonlyMap(key, Borsh.U8).check(Schema.isMaxSize(1)))
    expect(decodeFailure(atMost, wireKeys).message).toBe(
      "Expected a value with a size of at most 1, got 2 entries at byte 0",
    )
    const atLeast = Schema.flip(Schema.ReadonlyMap(key, Borsh.U8).check(Schema.isMinSize(2)))
    expect(decodes(atLeast, wireKeys)).toEqual(new Map([[1, 8]]))
    const vector = Schema.flip(Schema.Array(Borsh.U8).check(Schema.isMaxLength(1)))
    expect(decodeFailure(vector, u32(3)).message).toMatch(/at most 1, got 3 items at byte 0$/)
  })

  it("only makes HashSet size checks fail sooner, since Effect's own reject every HashSet", () => {
    // Effect 4.0.5's HashSet has no size property, so isMinSize and isMaxSize never pass on it.
    const schema = Schema.HashSet(Borsh.U8).check(Schema.isBetweenSize(1, 2) as never)
    expect(decodeFailure(schema, [...u32(1), 7]).message).toBe(
      "Expected a value with a size between 1 and 2",
    )
    expect(decodeFailure(schema, u32(3)).message).toBe(
      "Expected a value with a size between 1 and 2, got 3 members at byte 0",
    )
  })
})

describe("maxItems", () => {
  const nested = Schema.Array(Schema.Array(Borsh.U8))
  // Two outer items, then two and one inner items: five in total.
  const nestedValue = [[1, 2], [3]]
  const nestedBytes = [...u32(2), ...u32(2), 1, 2, ...u32(1), 3]

  it("accepts exactly the budget and fails one over at the prefix that overran it", () => {
    expect(decodes(nested, nestedBytes, { maxItems: 5 })).toEqual(nestedValue)
    const error = decodeFailure(nested, nestedBytes, { maxItems: 4 })
    expect(error.message).toBe("Input exceeds maxItems (4) at byte 10\n  at [1]")
    expect(filters(error.issue)).toEqual([])
    // The outer count is charged before any inner one.
    expect(decodeFailure(nested, nestedBytes, { maxItems: 1 }).message).toBe(
      "Input exceeds maxItems (1) at byte 0",
    )
    expect(decodes(nested, u32(0), { maxItems: 0 })).toEqual([])
  })

  it("charges encoding the same way", () => {
    const at = Borsh.toCodec(nested, { maxItems: 5 })
    expect(Schema.encodeSync(at)(nestedValue)).toEqual(Uint8Array.from(nestedBytes))
    const over = failure(() =>
      Schema.encodeSync(Borsh.toCodec(nested, { maxItems: 4 }))(nestedValue),
    )
    expect(over.message).toBe("Output exceeds maxItems (4) at byte 10\n  at [1]")
    const map = Schema.ReadonlyMap(Borsh.U8, Borsh.U8)
    const mapError = failure(() =>
      Schema.encodeSync(Borsh.toCodec(map, { maxItems: 1 }))(
        new Map([
          [1, 2],
          [3, 4],
        ]),
      ),
    )
    expect(mapError.message).toBe("Output exceeds maxItems (1) at byte 0")
    const fixed = Schema.Array(Borsh.U8).pipe(Borsh.fixedArray(3))
    const fixedError = failure(() =>
      Schema.encodeSync(Borsh.toCodec(fixed, { maxItems: 2 }))([1, 2, 3]),
    )
    expect(fixedError.message).toBe("Output exceeds maxItems (2) at byte 0")
    const shape = failure(() =>
      Schema.encodeUnknownSync(Borsh.toCodec(fixed, { maxItems: 0 }), { disableChecks: true })([1]),
    )
    expect(shape.message).toBe("Expected fixed array of length 3 at byte 0")
  })

  it("checks a value's shape before charging it", () => {
    const limits = { ...noLimits, countItems: true }
    const vector = compile(Schema.toEncoded(Schema.Array(Borsh.U8)).ast, limits)
    expect(() => vector.write(new Writer(64, 0), {})).toThrow(
      "Expected array with u32 length at byte 0",
    )
    expect(() => vector.write(new Writer(64, 0), [1])).toThrow(
      "Output exceeds maxItems (0) at byte 0",
    )
  })

  it("counts vector items, map entries, set members and fixed-array items, not bytes or strings", () => {
    const schema = Schema.Struct({
      bytes: Borsh.Bytes,
      text: Schema.String,
      map: Schema.HashMap(Borsh.U8, Borsh.U8),
      set: Schema.ReadonlySet(Borsh.U8),
      fixed: Schema.Array(Borsh.U8).pipe(Borsh.fixedArray(2)),
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
    const error = failure(() => Schema.decodeSync(Borsh.toCodec(schema, { maxItems: 4 }))(bytes))
    expect(error.message).toBe(
      `Input exceeds maxItems (4) at byte ${bytes.byteLength - 2}\n  at ["fixed"]`,
    )
  })

  it("bounds fixed arrays of zero-sized items, which no byte count bounds", () => {
    // Vec<{ a: u8, b: [(); 1000] }> visits 1000 units per input byte.
    const schema = Schema.Array(
      Schema.Struct({ a: Borsh.U8, b: Schema.Array(Borsh.Unit).pipe(Borsh.fixedArray(1000)) }),
    )
    const bytes = [...u32(3), 1, 2, 3]
    expect(decodes(schema, bytes, { maxItems: 3003 })).toHaveLength(3)
    expect(decodeFailure(schema, bytes, { maxItems: 3002 }).message).toBe(
      'Input exceeds maxItems (3002) at byte 7\n  at [2]["b"]',
    )
    expect(decodeFailure(schema, bytes, { maxItems: 2002 }).message).toBe(
      'Input exceeds maxItems (2002) at byte 6\n  at [1]["b"]',
    )
  })

  it("charges only what is read", () => {
    const schema = Schema.Option(Schema.Array(Borsh.U8))
    expect(decodes(schema, [0], { maxItems: 0 })).toEqual(Option.none())
    expect(decodeFailure(schema, [1, ...u32(1), 7], { maxItems: 0 }).message).toBe(
      'Input exceeds maxItems (0) at byte 1\n  at ["value"]',
    )
  })

  it("runs after the early checks and before the remaining-bytes check", () => {
    const checked = Schema.Array(Borsh.U8).check(Schema.isMaxLength(2))
    expect(decodeFailure(checked, u32(10), { maxItems: 5 }).message).toBe(
      "Expected a value with a length of at most 2, got 10 items at byte 0",
    )
    expect(decodeFailure(Schema.Array(Borsh.U8), u32(10), { maxItems: 5 }).message).toBe(
      "Input exceeds maxItems (5) at byte 0",
    )
    const set = Schema.ReadonlySet(Borsh.U8)
    expect(decodeFailure(set, u32(10), { maxItems: 5 }).message).toBe(
      "Input exceeds maxItems (5) at byte 0",
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
})

describe("untrusted input", () => {
  // 16 MiB: a count of 16,777,212, then that many zero bytes, each a Noop variant.
  const Action = Schema.TaggedUnion({ Noop: {}, Transfer: { amount: Borsh.U128 } })
  const input = new Uint8Array(16 * 1024 * 1024)
  const count = input.byteLength - 4
  new DataView(input.buffer).setUint32(0, count, true)

  it("rejects millions of one-byte items with Schema.isMaxLength before reading any", () => {
    const codec = Borsh.toCodec(Schema.Array(Action).check(Schema.isMaxLength(16)))
    const reads = countReads("getUint8", () => Schema.decodeSync(codec)(input))
    expect(reads).toBe(0)
    expect(() => Schema.decodeSync(codec)(input)).toThrow(
      `Expected a value with a length of at most 16, got ${count} items at byte 0`,
    )
  })

  it("rejects them with maxItems alone", () => {
    const codec = Borsh.toCodec(Schema.Array(Action), { maxItems: 10_000 })
    const reads = countReads("getUint8", () => Schema.decodeSync(codec)(input))
    expect(reads).toBe(0)
    expect(() => Schema.decodeSync(codec)(input)).toThrow(
      "Input exceeds maxItems (10000) at byte 0",
    )
  })
})

/** A generated encoded-side schema, a generator of frames for it, and its structural item count. */
interface Shape {
  readonly schema: Schema.Top
  readonly frame: fc.Arbitrary<number[]>
  /** Collection items in the binary layer's output, as maxItems counts them. */
  readonly items: (raw: unknown) => number
  /** Whether the schema has a transformation, so flipping it would change its wire layout. */
  readonly transformed: boolean
}

const smallCount = fc.integer({ min: 0, max: 4 })

const lengthChecks: fc.Arbitrary<ReadonlyArray<SchemaAST.Check<{ readonly length: number }>>> =
  fc.array(
    fc.oneof(
      smallCount.map((n) => Schema.isMinLength(n)),
      smallCount.map((n) => Schema.isMaxLength(n)),
      fc.tuple(smallCount, smallCount).map(([a, b]) => Schema.isBetweenLength(a, b)),
      fc.constant(Schema.isNonEmpty()),
      fc
        .tuple(smallCount, smallCount)
        .map(([a, b]) => Schema.makeFilterGroup([Schema.isMinLength(a), Schema.isMaxLength(b)])),
      fc.constant(Schema.makeFilter((value: { readonly length: number }) => value.length !== 2)),
      fc.constant(
        Schema.makeFilter(() => true, { arbitraryConstraint: { minLength: 3, maxLength: 0 } }),
      ),
    ),
    { maxLength: 2 },
  )

const sizeChecks: fc.Arbitrary<ReadonlyArray<SchemaAST.Check<{ readonly size: number }>>> =
  fc.array(
    fc.oneof(
      smallCount.map((n) => Schema.isMinSize(n)),
      smallCount.map((n) => Schema.isMaxSize(n)),
      fc.tuple(smallCount, smallCount).map(([a, b]) => Schema.isBetweenSize(a, b)),
      fc
        .tuple(smallCount, smallCount)
        .map(([a, b]) => Schema.makeFilterGroup([Schema.isMinSize(a), Schema.isMaxSize(b)])),
      // A length id on a size node must not be recognised.
      fc.constant(Schema.isNonEmpty() as never),
    ),
    { maxLength: 2 },
  )

function withChecks(schema: Schema.Top, checks: ReadonlyArray<SchemaAST.Check<never>>): Schema.Top {
  const [first, ...rest] = checks
  return first === undefined ? schema : schema.check(first as never, ...(rest as never[]))
}

const sequence = (frames: ReadonlyArray<fc.Arbitrary<number[]>>) =>
  frames.length === 0 ? fc.constant<number[]>([]) : fc.tuple(...frames).map((parts) => parts.flat())

const u8: Shape = {
  schema: Borsh.U8,
  frame: fc.nat(255).map((b) => [b]),
  items: () => 0,
  transformed: false,
}

/** A U8 key decoded to a string, so flipping a map over it decodes string wire keys to numbers. */
const stringifiedU8 = Borsh.U8.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({ decode: String, encode: (value) => Number(value) }),
  ),
)

/** Entries for "001", "01", "1" and "2", which decode to 1, 1, 1 and 2, so they can merge. */
const mergingEntries = fc
  .subarray(["001", "01", "1", "2"])
  .chain((keys) =>
    sequence(keys.map((key) => fc.nat(255).map((value) => [...str(key), value]))).map((entries) => [
      ...u32(keys.length),
      ...entries,
    ]),
  )

/** Maps whose size checks see merged keys, and flipped ones whose size checks see wire keys. */
const mergingMaps: ReadonlyArray<fc.Arbitrary<Shape>> = [
  sizeChecks.map((checks) => ({
    schema: withChecks(Schema.ReadonlyMap(Schema.FiniteFromString, Borsh.U8), checks),
    frame: mergingEntries,
    items: (raw) => (raw as ReadonlyMap<unknown, unknown>).size,
    transformed: true,
  })),
  sizeChecks.map((checks) => ({
    schema: Schema.flip(withChecks(Schema.ReadonlyMap(stringifiedU8, Borsh.U8), checks)),
    frame: mergingEntries,
    items: (raw) => (raw as ReadonlyMap<unknown, unknown>).size,
    transformed: true,
  })),
]

const leaves: ReadonlyArray<fc.Arbitrary<Shape>> = [
  fc.constant(u8),
  fc.constant<Shape>({
    schema: Schema.String,
    frame: fc.stringMatching(/^[a-c]{0,3}$/).map(str),
    items: () => 0,
    transformed: false,
  }),
  lengthChecks.map((checks) => ({
    schema: withChecks(Borsh.Bytes, checks),
    frame: fc.array(fc.nat(255), { maxLength: 4 }).map((bytes) => [...u32(bytes.length), ...bytes]),
    items: () => 0,
    transformed: false,
  })),
  sizeChecks.map((checks) => ({
    schema: withChecks(Schema.ReadonlySet(Borsh.U8), checks),
    frame: fc
      .uniqueArray(fc.nat(5), { maxLength: 4 })
      .map((keys) => [...u32(keys.length), ...keys.sort((a, b) => a - b)]),
    items: (raw) => (raw as ReadonlySet<unknown>).size,
    transformed: false,
  })),
  ...mergingMaps,
]

function vectorOf(item: Shape, checks: ReadonlyArray<SchemaAST.Check<never>>): Shape {
  return {
    schema: withChecks(Schema.Array(item.schema), checks),
    frame: smallCount.chain((n) =>
      sequence(Array.from({ length: n }, () => item.frame)).map((items) => [...u32(n), ...items]),
    ),
    items: (raw) => {
      const array = raw as ReadonlyArray<unknown>
      return array.reduce((sum: number, value) => sum + item.items(value), array.length)
    },
    transformed: item.transformed,
  }
}

const recoverEmpty = Schema.catchDecoding(() => Effect.succeedSome([]))

function taggedUnion(a: Shape, b: Shape): Shape {
  return {
    schema: Schema.TaggedUnion({ A: { value: a.schema }, B: { value: b.schema } }),
    frame: fc.oneof(
      a.frame.map((frame) => [0, ...frame]),
      b.frame.map((frame) => [1, ...frame]),
    ),
    items: (raw) => {
      const variant = raw as { readonly _tag: "A" | "B"; readonly value: unknown }
      return variant._tag === "A" ? a.items(variant.value) : b.items(variant.value)
    },
    transformed: a.transformed || b.transformed,
  }
}

/** Effect tries a member that recovers on every input, so it can stand in for the other member. */
function recoveringUnion(a: Shape): Shape {
  const fallback = Schema.TaggedStruct("Fallback", {}).pipe(
    Schema.catchDecoding(() => Effect.succeedSome({ _tag: "Fallback" as const })),
  )
  return {
    schema: Schema.Union([Schema.TaggedStruct("A", { value: a.schema }), fallback]),
    frame: fc.oneof(
      a.frame.map((frame) => [0, ...frame]),
      fc.constant<number[]>([1]),
    ),
    items: (raw) => {
      const variant = raw as { readonly _tag: "A" | "Fallback"; readonly value?: unknown }
      return variant._tag === "A" ? a.items(variant.value) : 0
    },
    transformed: true,
  }
}

const { shape } = fc.letrec<{ shape: Shape }>((tie) => ({
  shape: fc.oneof<Array<fc.Arbitrary<Shape>>>(
    { depthSize: "small", maxDepth: 3, withCrossShrink: true },
    ...leaves,
    fc.tuple(tie("shape"), lengthChecks).map(([item, checks]) => vectorOf(item, checks)),
    // A field's recovery never sees binary failures, so the checks beneath it must wait.
    fc.tuple(tie("shape"), lengthChecks).map(([item, checks]) => {
      const vector = vectorOf(item, checks)
      return {
        schema: Schema.Struct({ recovered: vector.schema.pipe(recoverEmpty as never) }),
        frame: vector.frame,
        items: (raw) => vector.items((raw as { readonly recovered: unknown }).recovered),
        transformed: true,
      }
    }),
    fc.tuple(tie("shape"), sizeChecks).map(([value, checks]) => ({
      schema: withChecks(Schema.ReadonlyMap(Borsh.U8, value.schema), checks),
      frame: fc
        .uniqueArray(fc.nat(5), { maxLength: 3 })
        .chain((keys) =>
          sequence(
            keys.sort((a, b) => a - b).map((key) => value.frame.map((frame) => [key, ...frame])),
          ).map((entries) => [...u32(keys.length), ...entries]),
        ),
      items: (raw) => {
        const map = raw as ReadonlyMap<unknown, unknown>
        let sum = map.size
        for (const entry of map.values()) {
          sum += value.items(entry)
        }
        return sum
      },
      transformed: value.transformed,
    })),
    fc.tuple(tie("shape"), fc.integer({ min: 0, max: 3 })).map(([item, length]) => ({
      schema: Schema.Array(item.schema).pipe(Borsh.fixedArray(length)),
      frame: sequence(Array.from({ length }, () => item.frame)),
      items: (raw) => {
        const array = raw as ReadonlyArray<unknown>
        return array.reduce((sum: number, value) => sum + item.items(value), array.length)
      },
      transformed: item.transformed,
    })),
    fc.tuple(tie("shape"), tie("shape")).map(([a, b]) => ({
      schema: Schema.Struct({ a: a.schema, b: b.schema }),
      frame: sequence([a.frame, b.frame]),
      items: (raw) => {
        const struct = raw as { readonly a: unknown; readonly b: unknown }
        return a.items(struct.a) + b.items(struct.b)
      },
      transformed: a.transformed || b.transformed,
    })),
    tie("shape").map((value) => ({
      schema: Schema.Option(value.schema),
      frame: fc.oneof(
        fc.constant<number[]>([0]),
        value.frame.map((frame) => [1, ...frame]),
      ),
      items: (raw) => {
        const option = raw as Option.Option<unknown>
        return Option.isSome(option) ? value.items(option.value) : 0
      },
      transformed: value.transformed,
    })),
    fc.tuple(tie("shape"), tie("shape")).map(([a, b]) => taggedUnion(a, b)),
    tie("shape").map(recoveringUnion),
    fc.tuple(tie("shape"), tie("shape")).map(([ok, err]) => ({
      schema: Schema.Result(ok.schema, err.schema),
      frame: fc.oneof(
        ok.frame.map((frame) => [1, ...frame]),
        err.frame.map((frame) => [0, ...frame]),
      ),
      items: (raw) => {
        const result = raw as Result.Result<unknown, unknown>
        return Result.isSuccess(result) ? ok.items(result.success) : err.items(result.failure)
      },
      transformed: ok.transformed || err.transformed,
    })),
    // Flipping moves checks into encodingChecks, which Effect runs on the encoded value.
    tie("shape").map((value) =>
      value.transformed ? value : { ...value, schema: Schema.flip(value.schema) },
    ),
    fc.tuple(tie("shape"), lengthChecks).map(([item, checks]) => ({
      schema: withChecks(Schema.Tuple([item.schema]), checks),
      frame: item.frame,
      items: (raw) => item.items((raw as ReadonlyArray<unknown>)[0]),
      transformed: item.transformed,
    })),
  ),
}))

/** A valid-looking frame, sometimes with one byte changed, a byte appended or the tail cut. */
function frames(source: fc.Arbitrary<number[]>): fc.Arbitrary<Uint8Array> {
  return source
    .chain((frame) =>
      fc.oneof(
        fc.constant(frame),
        fc
          .tuple(fc.nat(Math.max(0, frame.length - 1)), fc.nat(255))
          .map(([i, b]) => frame.map((value, j) => (i === j ? b : value))),
        fc.nat(255).map((b) => [...frame, b]),
        fc.nat(frame.length).map((end) => frame.slice(0, end)),
      ),
    )
    .map((frame) => Uint8Array.from(frame))
}

/** Decode with only the binary layer: no early checks, no schema pass, no transformation. */
function binaryOnly(schema: Schema.Codec<unknown, unknown>, bytes: Uint8Array) {
  const codec = Borsh.toCodec(Schema.toEncoded(schema))
  return Schema.decodeExit(codec, { disableChecks: true })(bytes)
}

/** Treats every check as deferred, so a layout compiled with it has no early checks at all. */
const deferEveryCheck = { has: () => true } as unknown as WeakSet<SchemaAST.Check<unknown>>

/**
 * The codec as it was before early checks: a layout without them, then the schema pass, composed
 * like toCodec so that middleware on the root wraps both. It reads with checks on, so it does not
 * rely on disableChecks skipping early checks.
 */
function uncheckedCodec(schema: Schema.Codec<unknown, unknown>) {
  const layout = compile(Schema.toEncoded(schema).ast, {
    countItems: false,
    mergingChecks: deferEveryCheck,
    recoverableChecks: deferEveryCheck,
  })
  return Schema.Uint8Array.pipe(
    Schema.decodeTo(
      schema,
      SchemaTransformation.transformEffect<unknown, Uint8Array>({
        decode: (bytes) =>
          Effect.try({
            try: () => {
              const reader = new Reader(bytes, {
                maxBytes: 16 * 1024 * 1024,
                maxItems: Infinity,
                checks: true,
              })
              const value = layout.read(reader)
              if (reader.offset !== bytes.byteLength) {
                throw new Error("Trailing bytes")
              }
              return value
            },
            catch: (error) => new SchemaIssue.InvalidValue({ message: String(error) }),
          }),
        encode: () => Effect.die("Decoding only"),
      }),
    ),
  )
}

/** Early checks must accept exactly what the binary layer plus the schema pass accept. */
function assertUnchangedAcceptance(shapes: fc.Arbitrary<Shape>, numRuns: number) {
  fc.assert(
    fc.property(
      shapes.chain((s) => fc.tuple(fc.constant(s), frames(s.frame))),
      ([s, bytes]) => {
        const schema = s.schema as Schema.Codec<unknown, unknown>
        const accepted = Exit.isSuccess(Schema.decodeExit(Borsh.toCodec(schema))(bytes))
        const expected = Exit.isSuccess(Schema.decodeExit(uncheckedCodec(schema))(bytes))
        expect(accepted).toBe(expected)
      },
    ),
    { numRuns },
  )
}

describe("acceptance", () => {
  it("is unchanged by early checks: they only make rejected input fail sooner", () => {
    assertUnchangedAcceptance(shape, 400)
  })

  it("is unchanged for maps whose keys merge when decoded", () => {
    assertUnchangedAcceptance(fc.oneof(...mergingMaps), 200)
  })

  it("is unchanged for unions with a member that recovers", () => {
    assertUnchangedAcceptance(shape.map(recoveringUnion), 200)
  })

  it("with maxItems k is the unlimited codec's acceptance plus at most k items", () => {
    fc.assert(
      fc.property(
        shape.chain((s) => fc.tuple(fc.constant(s), frames(s.frame), fc.nat(12))),
        ([s, bytes, maxItems]) => {
          const schema = s.schema as Schema.Codec<unknown, unknown>
          const limited = Borsh.toCodec(schema, { maxItems })
          const accepted = Exit.isSuccess(Schema.decodeExit(limited)(bytes))
          const unlimited = Schema.decodeExit(Borsh.toCodec(schema))(bytes)
          const raw = binaryOnly(schema, bytes)
          const expected =
            Exit.isSuccess(unlimited) && Exit.isSuccess(raw) && s.items(raw.value) <= maxItems
          expect(accepted).toBe(expected)
          if (!Exit.isSuccess(unlimited)) {
            return
          }
          const encoded = Schema.encodeExit(limited)(unlimited.value)
          // Re-encoding a decoded value never needs more items than its frame held.
          const fitsBudget = Exit.isSuccess(raw) && s.items(raw.value) <= maxItems
          const encodesUnlimited = Exit.isSuccess(
            Schema.encodeExit(Borsh.toCodec(schema))(unlimited.value),
          )
          if (fitsBudget && encodesUnlimited) {
            expect(Exit.isSuccess(encoded)).toBe(true)
          }
          // Whatever the limited codec encodes, it decodes.
          if (Exit.isSuccess(encoded)) {
            expect(Exit.isSuccess(Schema.decodeExit(limited)(encoded.value))).toBe(true)
          }
        },
      ),
      { numRuns: 400 },
    )
  })
})
