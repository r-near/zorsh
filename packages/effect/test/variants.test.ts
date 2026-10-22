import { Context, Effect, Option, Schema, SchemaAST, SchemaTransformation } from "effect"
import { expect, expectTypeOf, it } from "vite-plus/test"
import { Borsh } from "../src/index.js"
import { compile } from "../src/internal/compiler.js"
import { Reader, Writer } from "../src/internal/io.js"

const key = "@zorsh/effect/borsh/layout"
const variants = Schema.TaggedUnion({
  Idle: {},
  Count: { value: Borsh.U16 },
  Named: { label: Schema.String, enabled: Schema.Boolean },
})
const discriminants = { Idle: 3, Count: 17, Named: 250 }
const schema = variants.pipe(Borsh.discriminants(discriminants))
const codec = Borsh.toCodec(schema)
/** Bypass the exhaustive map type to reach runtime validation. */
const unchecked = <S extends Schema.Top>(
  schema: S,
  map: Readonly<Record<string, number>>,
  tag?: string,
): S["Rebuild"] => Borsh.discriminants(map, { tag })(schema as never)

it("retains native union helpers, checks and discriminant narrowing", () => {
  expectTypeOf(schema).toEqualTypeOf<typeof variants>()
  const count = schema.cases.Count.make({ value: 513 })
  expectTypeOf(count._tag).toEqualTypeOf<"Count">()
  expect(
    schema.match(count, { Idle: () => 0, Count: (v) => v.value, Named: (v) => v.label.length }),
  ).toBe(513)
  const value = Schema.decodeSync(codec)(Uint8Array.of(17, 1, 2))
  expectTypeOf(value).toEqualTypeOf<typeof variants.Type>()
  if (value._tag === "Count") {
    expectTypeOf(value.value).toEqualTypeOf<number>()
  }
  const checked = Borsh.toCodec(
    schema.check(Schema.makeFilter((v) => v._tag !== "Count" || v.value > 0)),
  )
  expect(() => Schema.decodeSync(checked)(Uint8Array.of(17, 0, 0))).toThrow(Schema.SchemaError)
})

it("writes explicit Rust enum tags and only the selected payload", () => {
  for (const [value, raw] of [
    [{ _tag: "Idle" }, [3]],
    [{ _tag: "Count", value: 513 }, [17, 1, 2]],
    [{ _tag: "Named", label: "x", enabled: true }, [250, 1, 0, 0, 0, 120, 1]],
  ] as const) {
    const bytes = Uint8Array.from(raw)
    expect(Schema.encodeSync(codec)(value)).toEqual(bytes)
    expect(Schema.decodeSync(codec)(bytes)).toEqual(value)
    for (let cut = 0; cut < bytes.length; cut++) {
      expect(() => Schema.decodeSync(codec)(bytes.subarray(0, cut))).toThrow(Schema.SchemaError)
    }
    expect(() => Schema.decodeSync(codec)(Uint8Array.of(...bytes, 0))).toThrow(/Trailing/)
  }
  for (let tag = 0; tag < 256; tag++) {
    if (tag === 3) {
      expect(Schema.decodeSync(codec)(Uint8Array.of(tag))).toEqual({ _tag: "Idle" })
    } else {
      expect(() => Schema.decodeSync(codec)(Uint8Array.of(tag))).toThrow(
        tag === 17 || tag === 250 ? /Truncated/ : /Invalid enum tag/,
      )
    }
  }
  expect(() => Schema.encodeUnknownSync(codec)({ _tag: "Other" })).toThrow(Schema.SchemaError)
})

it("uses exact maps independently of union order, tag key and unsafe labels", () => {
  const custom = Schema.Union([
    Schema.Struct({ kind: Schema.Literal("constructor"), value: Borsh.U8 }),
    Schema.Struct({ kind: Schema.Literal("__proto__") }),
    Schema.Struct({ kind: Schema.Literal("2") }),
  ])
  const mapped = custom.pipe(
    Borsh.discriminants({ "2": 255, ["__proto__"]: 0, constructor: 7 }, { tag: "kind" }),
  )
  const c = Borsh.toCodec(mapped)
  for (const [value, bytes] of [
    [{ kind: "__proto__" }, [0]],
    [{ kind: "constructor", value: 8 }, [7, 8]],
    [{ kind: "2" }, [255]],
  ] as const) {
    expect(Schema.encodeSync(c)(value)).toEqual(Uint8Array.from(bytes))
    expect(Schema.decodeSync(c)(Uint8Array.from(bytes))).toEqual(value)
  }
  const reordered = mapped.pipe(
    Borsh.discriminants({ constructor: 7, ["__proto__"]: 0, "2": 255 }, { tag: "kind" }),
  )
  expect(Schema.encodeSync(Borsh.toCodec(reordered))({ kind: "2" })).toEqual(Uint8Array.of(255))
  const copied = { ...discriminants }
  const assign = Borsh.discriminants(copied)
  copied.Idle = 9
  const frozen = variants.pipe(assign)
  expect(Schema.encodeSync(Borsh.toCodec(frozen))({ _tag: "Idle" })).toEqual(Uint8Array.of(3))
  const metadata = Schema.toEncoded(frozen).ast.annotations?.[key]
  expect(Object.isFrozen(metadata)).toBe(true)
  expect(metadata?.kind === "enum" && Object.isFrozen(metadata.discriminants)).toBe(true)
})

class Created extends Schema.TaggedClass<Created, { readonly brand: unique symbol }>()("Created", {
  id: Borsh.U8,
}) {}
class Closed extends Schema.TaggedClass<Closed, { readonly brand: unique symbol }>()(
  "Closed",
  {},
) {}
enum Numeric {
  Up,
  Down,
}
enum Text {
  Pending = "pending",
  Done = "done",
}

it("derives Rust discriminants from native declaration order", () => {
  for (const [union, value, raw] of [
    [variants, { _tag: "Named", label: "x", enabled: true }, [2, 1, 0, 0, 0, 120, 1]],
    [
      Schema.Union([Schema.TaggedStruct("B", {}), Schema.TaggedStruct("A", { v: Borsh.U8 })]),
      { _tag: "A", v: 9 },
      [1, 9],
    ],
    [Schema.Literals(["Pending", "Done"]), "Done", [1]],
    [Schema.Enum(Text), Text.Done, [1]],
    [Schema.Enum(Numeric), Numeric.Down, [1]],
  ] as const) {
    const c = Borsh.toCodec(union as Schema.Codec<unknown>)
    expect(Schema.encodeSync(c)(value)).toEqual(Uint8Array.from(raw))
    expect(Schema.decodeSync(c)(Uint8Array.from(raw))).toEqual(value)
  }
  const swapped = Borsh.toCodec(Schema.Literals(["Done", "Pending"]))
  expect(Schema.encodeSync(swapped)("Done")).toEqual(Uint8Array.of(0))
  const classes = Borsh.toCodec(Schema.Union([Created, Closed]))
  const created = Schema.decodeSync(classes)(Uint8Array.of(0, 7))
  expect(created).toBeInstanceOf(Created)
  expect(created).toEqual(new Created({ id: 7 }))
  expect(Schema.encodeSync(classes)(new Closed({}))).toEqual(Uint8Array.of(1))
})

it("checks every tag byte for value enums and rejects unknown values", () => {
  const literals = Borsh.toCodec(Schema.Literals(["A", "B", "C"]))
  const numeric = Borsh.toCodec(Schema.Enum(Numeric))
  for (let tag = 0; tag < 256; tag++) {
    if (tag < 3) {
      expect(Schema.decodeSync(literals)(Uint8Array.of(tag))).toBe("ABC"[tag])
    } else {
      expect(() => Schema.decodeSync(literals)(Uint8Array.of(tag))).toThrow(/Invalid enum tag/)
    }
    if (tag < 2) {
      expect(Schema.decodeSync(numeric)(Uint8Array.of(tag))).toBe(tag)
    } else {
      expect(() => Schema.decodeSync(numeric)(Uint8Array.of(tag))).toThrow(/Invalid enum tag/)
    }
  }
  expect(() => Schema.decodeSync(literals)(new Uint8Array())).toThrow(/Truncated/)
  expect(() => Schema.decodeSync(literals)(Uint8Array.of(0, 0))).toThrow(/Trailing/)
  const layout = compile(Schema.Literals(["A", "B"]).ast)
  for (const value of ["C", 0, null, Numeric.Up]) {
    expect(() => layout.write(new Writer(4), value)).toThrow(/Invalid enum value/)
  }
  expect(layout.minBytes).toBe(1)
})

it("supports single-variant enums of every native form", () => {
  for (const [single, value, raw] of [
    [Schema.TaggedUnion({ Only: { v: Borsh.U8 } }), { _tag: "Only", v: 4 }, [0, 4]],
    [Schema.TaggedUnion({ Unit: {} }), { _tag: "Unit" }, [0]],
    [Schema.Literals(["Only"]), "Only", [0]],
    [Schema.Enum({ Only: 0 }), 0, [0]],
  ] as const) {
    const c = Borsh.toCodec(single as Schema.Codec<unknown>)
    expect(Schema.encodeSync(c)(value)).toEqual(Uint8Array.from(raw))
    expect(Schema.decodeSync(c)(Uint8Array.from(raw))).toEqual(value)
    expect(() => Schema.decodeSync(c)(Uint8Array.of(1, ...raw.slice(1)))).toThrow(
      /Invalid enum tag 1/,
    )
  }
})

it("treats single dataless default enums as Rust zero-sized types", () => {
  for (const single of [
    Schema.Literals(["Only"]),
    Schema.Enum({ Only: 0 }),
    Schema.TaggedUnion({ Only: {} }),
    Schema.TaggedUnion({ Only: { value: Borsh.Unit } }),
    Schema.Struct({ only: Schema.Literals(["Only"]) }),
  ]) {
    const vector = Borsh.toCodec(Schema.Array(single as Schema.Codec<unknown>))
    expect(() => Schema.encodeSync(vector)([])).toThrow(/zero-sized/)
    expect(() => Schema.decodeSync(vector)(Uint8Array.of(0, 0, 0, 0))).toThrow(/zero-sized/)
  }
  for (const sized of [
    Schema.Literals(["Only"]).pipe(Borsh.discriminants({ Only: 3 })),
    Schema.TaggedUnion({ Only: { value: Borsh.U8 } }),
    Schema.Literals(["A", "B"]),
  ]) {
    const vector = Borsh.toCodec(Schema.Array(sized as Schema.Codec<unknown>))
    expect(Schema.decodeSync(vector)(Uint8Array.of(0, 0, 0, 0))).toEqual([])
  }
  const repr = Borsh.toCodec(
    Schema.Array(Schema.Literals(["Only"]).pipe(Borsh.discriminants({ Only: 3 }))),
  )
  expect(Schema.encodeSync(repr)(["Only"])).toEqual(Uint8Array.of(1, 0, 0, 0, 3))
})

it("requires explicit discriminants for numeric and non-string enums", () => {
  enum Sparse {
    A = 1,
    B = 5,
  }
  enum Swapped {
    A = 1,
    B = 0,
  }
  for (const enums of [Sparse, Swapped]) {
    expect(() => Borsh.toCodec(Schema.Enum(enums))).toThrow(
      /\$: Numeric enum values must be 0..n-1 in declaration order; pass the Rust wire discriminants \(declaration indices unless #\[borsh\(use_discriminant = true\)\]\) to Borsh.discriminants/,
    )
  }
  const sparse = Borsh.toCodec(Schema.Enum(Sparse).pipe(Borsh.discriminants({ A: 1, B: 5 })))
  expect(Schema.encodeSync(sparse)(Sparse.B)).toEqual(Uint8Array.of(5))
  expect(Schema.decodeSync(sparse)(Uint8Array.of(1))).toBe(Sparse.A)
  expect(() => Schema.decodeSync(sparse)(Uint8Array.of(0))).toThrow(/Invalid enum tag 0/)
  const text = Borsh.toCodec(Schema.Enum(Text).pipe(Borsh.discriminants({ Pending: 7, Done: 2 })))
  expect(Schema.encodeSync(text)(Text.Pending)).toEqual(Uint8Array.of(7))
  const branded = Schema.Enum(Sparse).pipe(
    Schema.brand("Sparse"),
    Borsh.discriminants({ A: 1, B: 5 }),
  )
  expect(Schema.encodeSync(Borsh.toCodec(branded))(Sparse.B as typeof branded.Type)).toEqual(
    Uint8Array.of(5),
  )
  const named = Schema.Enum(Text).pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transform({
        decode: (v) => v.toUpperCase(),
        encode: (v) => (v === "DONE" ? Text.Done : Text.Pending),
      }),
    ),
    Schema.brand("Named"),
    Borsh.discriminants({ Pending: 7, Done: 2 }),
  )
  expect(Schema.decodeSync(Borsh.toCodec(named))(Uint8Array.of(2))).toBe("DONE")
  for (const wrapped of [
    Schema.Enum(Sparse).pipe(Schema.refine((v): v is Sparse => v !== undefined)),
    Schema.toEncoded(Schema.Enum(Sparse)),
    Schema.flip(Schema.Enum(Sparse)),
  ]) {
    expect(
      Schema.encodeSync(Borsh.toCodec(wrapped.pipe(Borsh.discriminants({ A: 1, B: 5 }))))(Sparse.B),
    ).toEqual(Uint8Array.of(5))
  }
  const typed = Schema.toType(
    Schema.String.pipe(
      Schema.decodeTo(
        Schema.Enum(Sparse),
        SchemaTransformation.transform({ decode: () => Sparse.B, encode: String }),
      ),
    ),
  )
  for (const wrapped of [typed, Schema.flip(typed)]) {
    expect(
      Schema.encodeSync(Borsh.toCodec(wrapped.pipe(Borsh.discriminants({ A: 1, B: 5 }))))(Sparse.B),
    ).toEqual(Uint8Array.of(5))
  }
  const integerKeys = Schema.Enum({ 0: "zero", 1: "one" } as const)
  expect(
    Schema.encodeSync(Borsh.toCodec(integerKeys.pipe(Borsh.discriminants({ 0: 1, 1: 5 }))))("one"),
  ).toEqual(Uint8Array.of(5))
  enum Mixed {
    A = 0,
    B = "b",
  }
  expect(() => Borsh.toCodec(Schema.Enum(Mixed))).toThrow(
    /Mixed string and numeric enums are unsupported/,
  )
  expect(() => Schema.Enum(Mixed).pipe(Borsh.discriminants({ A: 0, B: 1 }))).toThrow(/Mixed/)
  expect(() => Borsh.toCodec(Schema.Enum({ A: 0, B: 0 }))).toThrow(
    /Duplicate enum values have no Borsh layout/,
  )
  for (const literals of [
    Schema.Literals([1, 5]),
    Schema.Literals(["A", true]),
    Schema.Literals([2n]),
  ]) {
    expect(() => Borsh.toCodec(literals)).toThrow(
      /Non-string literal enums have no Rust variant order; pass the Rust wire discriminants/,
    )
  }
  const numbers = Borsh.toCodec(Schema.Literals([1, 5]).pipe(Borsh.discriminants({ 1: 4, 5: 9 })))
  expect(Schema.encodeSync(numbers)(5)).toEqual(Uint8Array.of(9))
  expect(Schema.decodeSync(numbers)(Uint8Array.of(4))).toBe(1)
  const mixed = Schema.Literals(["A", true, 2n]).pipe(Borsh.discriminants({ A: 0, true: 1, 2: 2 }))
  expect(Schema.decodeSync(Borsh.toCodec(mixed))(Uint8Array.of(2))).toBe(2n)
})

it("validates explicit maps eagerly and keeps tag keys for object variants", () => {
  expect(() => Borsh.discriminants({ A: 0, B: 0 })).toThrow(/unique integers/)
  const assign = Borsh.discriminants({ Pending: 0, Done: 1 })
  expect(() => unchecked(Schema.Literals(["Pending"]), { Pending: 0, Done: 1 })).toThrow(
    /Unknown enum discriminants Done/,
  )
  expect(Schema.Literals(["Done", "Pending"]).pipe(assign)).toBeDefined()
  for (const [value, map] of [
    [Schema.Literals(["A"]), { A: 0 }],
    [Schema.Enum(Text), { Pending: 0, Done: 1 }],
  ] as const) {
    expect(() => unchecked(value, map, "kind")).toThrow(/Only object enum variants have a tag key/)
  }
  const kinds = Schema.Union([
    Schema.Struct({ kind: Schema.Literal("A") }),
    Schema.Struct({ kind: Schema.Literal("B"), v: Borsh.U8 }),
  ])
  expect(() => Borsh.toCodec(kinds)).toThrow(/Enum tag "_tag"/)
  const tagged = kinds.pipe(
    Borsh.discriminants({ A: 0, B: 1 }, { tag: "kind" }),
    Schema.toTaggedUnion("kind"),
  )
  expect(tagged.match({ kind: "B", v: 1 }, { A: () => 0, B: (b) => b.v })).toBe(1)
  expect(Schema.encodeSync(Borsh.toCodec(tagged))({ kind: "B", v: 3 })).toEqual(Uint8Array.of(1, 3))
})

it("treats variant reordering as a wire change, as in Rust", () => {
  const before = Borsh.toCodec(Schema.TaggedUnion({ Idle: {}, Count: { value: Borsh.U8 } }))
  const after = Borsh.toCodec(Schema.TaggedUnion({ Count: { value: Borsh.U8 }, Idle: {} }))
  expect(Schema.encodeSync(before)({ _tag: "Idle" })).toEqual(Uint8Array.of(0))
  expect(Schema.encodeSync(after)({ _tag: "Idle" })).toEqual(Uint8Array.of(1))
  const pinned = Schema.TaggedUnion({ Count: { value: Borsh.U8 }, Idle: {} }).pipe(
    Borsh.discriminants({ Idle: 0, Count: 1 }),
  )
  expect(Schema.encodeSync(Borsh.toCodec(pinned))({ _tag: "Idle" })).toEqual(Uint8Array.of(0))
})

it("rejects malformed enums and descriptors", () => {
  for (const invalidMap of [
    { ...discriminants, Count: 3 },
    { ...discriminants, Count: -1 },
    { ...discriminants, Count: 256 },
    { ...discriminants, Count: 1.5 },
    { ...discriminants, Count: NaN },
    { ...discriminants, Count: "17" },
  ]) {
    expect(() => Borsh.discriminants(invalidMap as never)).toThrow(
      /discriminants must be unique integers from 0 to 255/,
    )
  }
  for (const [map, message] of [
    [{ Idle: 3, Count: 17 }, /Missing enum discriminant for Named/],
    [{ ...discriminants, Extra: 9, Other: 8 }, /Unknown enum discriminants Extra, Other/],
  ] as const) {
    expect(() => unchecked(variants, map)).toThrow(message)
    expect(() =>
      Borsh.toCodec(
        variants.annotate({ [key]: { version: 1, kind: "enum", tag: "_tag", discriminants: map } }),
      ),
    ).toThrow(message)
  }
  expect(() => Borsh.discriminants(discriminants, { tag: 7 as never })).toThrow(/Invalid Borsh/)
  for (const raw of [
    { version: 1, kind: "enum" },
    { version: 1, kind: "enum", tag: "_tag", discriminants: [] },
    { version: 1, kind: "enum", tag: "_tag", discriminants: { Idle: "3" } },
  ]) {
    expect(() => Borsh.toCodec(variants.annotate({ [key]: raw } as never))).toThrow(/Borsh/)
  }
  expect(() => unchecked(Borsh.Bytes, { Idle: 0 })).toThrow(/Enum layout requires/)
  expect(() =>
    Borsh.toCodec(
      Borsh.Bytes.annotate({ [key]: { version: 1, kind: "enum", tag: "_tag", discriminants } }),
    ),
  ).toThrow(/Enum layout requires a tagged union, literal union or Schema.Enum/)
})

it("keeps enum metadata fixed when options have extra structural keys", () => {
  for (const version of [1, 99]) {
    const options = { tag: "_tag", version, kind: "integer", bits: 8, signed: false } as const
    expect(() => Borsh.discriminants(discriminants, options)(Schema.Finite as never)).toThrow(
      /Enum layout requires/,
    )
    const mapped = variants.pipe(Borsh.discriminants(discriminants, options))
    expect(Schema.toEncoded(mapped).ast.annotations?.[key]).toEqual({
      version: 1,
      kind: "enum",
      tag: "_tag",
      discriminants,
    })
    expect(Schema.encodeSync(Borsh.toCodec(mapped))({ _tag: "Count", value: 513 })).toEqual(
      Uint8Array.of(17, 1, 2),
    )
  }
})

it("rejects duplicate enum labels independently of map coverage", () => {
  const duplicate = Schema.Union([
    Schema.TaggedStruct("Idle", { value: Borsh.U8 }),
    Schema.TaggedStruct("Idle", {}),
  ])
  expect(() => Borsh.toCodec(duplicate)).toThrow(/Duplicate enum label Idle/)
  expect(() => unchecked(duplicate, { Idle: 0 })).toThrow(/Duplicate enum label Idle/)
  for (const literals of [Schema.Literals(["A", "A"]), Schema.Literals([1, "1"])]) {
    expect(() => unchecked(literals, { A: 0, "1": 1 })).toThrow(/Duplicate enum label/)
  }
})

it("rejects optional enum tags independently of map coverage", () => {
  const optional = Schema.Union([
    Schema.Struct({ _tag: Schema.optionalKey(Schema.Literal("Count")) }),
    Schema.TaggedStruct("Idle", {}),
  ])
  expect(() => Borsh.toCodec(optional)).toThrow(/Enum tag "_tag" must be a required string literal/)
  expect(() => unchecked(optional, { Count: 1, Idle: 0 })).toThrow(
    /Enum tag "_tag" must be a required string literal/,
  )
})

it("requires unannotated, required enum members and rejects mixed unions", () => {
  for (const member of [
    Schema.optionalKey(Schema.TaggedStruct("Count", {})),
    Schema.TaggedStruct("Count", {}).annotate({
      [key]: { version: 1, kind: "fixedBytes", length: 0 },
    }),
  ]) {
    const invalid = Schema.Union([member, Schema.TaggedStruct("Idle", {})])
    expect(() => Borsh.toCodec(invalid)).toThrow(
      /Enum variants must be required and have no layout annotations/,
    )
  }
  const annotated = Schema.Literal("A").annotate({
    [key]: { version: 1, kind: "fixedBytes", length: 0 },
  })
  expect(() => Borsh.toCodec(Schema.Union([annotated, Schema.Literal("B")]))).toThrow(
    /Enum variants must be required/,
  )
  const mixed = Schema.Union([Schema.String, Schema.TaggedStruct("Idle", {})])
  expect(() => unchecked(mixed, { Idle: 0 })).toThrow(/Enum layout requires/)
  for (const union of [
    mixed,
    Schema.NullOr(Borsh.U8),
    Schema.UndefinedOr(Borsh.U8),
    Schema.Union([Schema.Literal("A"), Schema.TaggedStruct("B", {})]),
  ]) {
    expect(() => Borsh.toCodec(union)).toThrow(
      /\$: Union has no Borsh layout; use Schema.Option for nullable values, or a tagged union, Schema.Literals or Schema.Enum for Rust enums/,
    )
  }
  expect(() => Borsh.toCodec(Schema.Struct({ value: Schema.NullOr(Borsh.U8) }))).toThrow(
    /\$\["value"\]: Union has no Borsh layout/,
  )
})

it("requires a single string literal enum tag and points to custom tag keys", () => {
  for (const member of [
    Schema.Struct({}),
    Schema.Struct({ _tag: Schema.String }),
    Schema.Struct({ _tag: Schema.Literal(7) }),
  ]) {
    const invalid = Schema.Union([member, Schema.TaggedStruct("Idle", {})])
    expect(() => unchecked(invalid, { "7": 1, Idle: 0 })).toThrow(
      /Enum tag "_tag" must be a required string literal; set another key with Borsh.discriminants\(map, \{ tag \}\)/,
    )
  }
})

it("rejects an inappropriate layout on a native Option declaration", () => {
  const invalid = Schema.Option(Borsh.U8).annotate({
    [key]: { version: 1, kind: "fixedBytes", length: 0 },
  })
  expect(() => Borsh.toCodec(invalid)).toThrow(
    new Error("$: Fixed bytes layout requires an encoded Uint8Array"),
  )
})

it("requires an own enum tag at the binary writer boundary", () => {
  const inherited = Object.setPrototypeOf({}, { _tag: "Idle" })
  expect(() => compile(Schema.toEncoded(schema).ast).write(new Writer(20), inherited)).toThrow(
    /Invalid enum label/,
  )
})

it("finds enum metadata in final checks and nested groups and rejects conflicts", () => {
  const layout = { version: 1, kind: "enum", tag: "_tag", discriminants } as const
  const check = Schema.makeFilter((_: typeof variants.Type) => true).annotate({ [key]: layout })
  const checked = variants.check(
    Schema.makeFilter(() => true),
    check.and(Schema.makeFilter(() => true)).and(Schema.makeFilter(() => true)),
  )
  expect(Schema.encodeSync(Borsh.toCodec(checked))({ _tag: "Idle" })).toEqual(Uint8Array.of(3))
  expect(() => checked.pipe(Borsh.discriminants({ ...discriminants, Idle: 4 }))).toThrow(
    /Conflicting/,
  )
  expect(() =>
    Borsh.toCodec(
      schema.check(
        check.annotate({ [key]: { ...layout, discriminants: { ...discriminants, Idle: 4 } } }),
      ),
    ),
  ).toThrow(/Conflicting/)
})

it("does not force visible suspensions while adding enum metadata", () => {
  let forced = false
  const suspended = Schema.suspend(() => {
    forced = true
    return Borsh.U8
  })
  const schema = Schema.TaggedUnion({ Idle: {}, Count: { value: suspended } }).pipe(
    Borsh.discriminants({ Idle: 0, Count: 1 }),
  )
  expect(() => Borsh.toCodec(schema)).toThrow(
    new Error('$["value"]: Suspend/recursive schemas are unsupported'),
  )
  expect(forced).toBe(false)
})

it("preserves native Option values and distinguishes every nested state", () => {
  const c = Borsh.toCodec(Schema.Option(Schema.Option(Borsh.U8)))
  for (const [value, raw] of [
    [Option.none(), [0]],
    [Option.some(Option.none()), [1, 0]],
    [Option.some(Option.some(7)), [1, 1, 7]],
  ] as const) {
    const bytes = Uint8Array.from(raw)
    expect(Schema.encodeSync(c)(value)).toEqual(bytes)
    expect(Schema.decodeSync(c)(bytes)).toEqual(value)
    expect(Option.isOption(Schema.decodeSync(c)(bytes))).toBe(true)
    for (let cut = 0; cut < bytes.length; cut++) {
      expect(() => Schema.decodeSync(c)(bytes.subarray(0, cut))).toThrow(/Truncated/)
    }
    expect(() => Schema.decodeSync(c)(Uint8Array.of(...bytes, 0))).toThrow(/Trailing/)
  }
  for (let tag = 2; tag < 256; tag++) {
    expect(() => Schema.decodeSync(c)(Uint8Array.of(tag))).toThrow(/Invalid Option tag/)
  }
  expect(() => Schema.encodeUnknownSync(c)({ _tag: "None" })).toThrow(Schema.SchemaError)
})

it("composes nested enums, options and arrays with relative paths and byte limits", () => {
  const nested = Borsh.toCodec(Schema.Struct({ actions: Schema.Array(Schema.Option(schema)) }))
  const value = { actions: [Option.none(), Option.some({ _tag: "Count", value: 513 } as const)] }
  const raw = Uint8Array.of(2, 0, 0, 0, 0, 1, 17, 1, 2)
  expect(Schema.encodeSync(nested)(value)).toEqual(raw)
  expect(Schema.decodeSync(nested)(raw)).toEqual(value)
  expect(() =>
    Schema.decodeSync(nested)(Uint8Array.of(2, 0, 0, 0, 0, 1, 250, 0, 0, 0, 0, 2)),
  ).toThrow(/ at byte 11\n {2}at \["actions"\]\[1\]\["value"\]\["enabled"\]$/)
  expect(() => Schema.decodeSync(nested)(Uint8Array.of(255, 255, 255, 255))).toThrow(
    /Truncated vector/,
  )
  const bounded = Borsh.toCodec(Schema.Option(schema), { maxBytes: 3 })
  expect(Schema.encodeSync(bounded)(Option.some({ _tag: "Idle" }))).toEqual(Uint8Array.of(1, 3))
  expect(() => Schema.encodeSync(bounded)(Option.some({ _tag: "Count", value: 513 }))).toThrow(
    /maxBytes/,
  )
  expect(() => Schema.decodeSync(bounded)(Uint8Array.of(1, 17, 1, 2))).toThrow(/maxBytes/)
})

it("reports enum tag, value and variant field failures at native paths and offsets", () => {
  const decode = (s: Schema.Top, raw: ReadonlyArray<number>) => () =>
    Schema.decodeSync(Borsh.toCodec(s as Schema.Codec<unknown>))(Uint8Array.from(raw))
  expect(decode(Schema.Struct({ actions: Schema.Array(schema) }), [2, 0, 0, 0, 3, 9])).toThrow(
    /^Invalid enum tag 9 at byte 5\n {2}at \["actions"\]\[1\]$/,
  )
  expect(decode(Schema.Tuple([Borsh.U8, schema]), [7])).toThrow(
    /^Truncated input: need 1 bytes at byte 1\n {2}at \[1\]$/,
  )
  expect(decode(Schema.ReadonlyMap(Borsh.U8, schema), [1, 0, 0, 0, 4, 250, 0, 0, 0, 0, 2])).toThrow(
    /^Invalid bool tag 2 at byte 10\n {2}at \[0\]\["value"\]\["enabled"\]$/,
  )
  expect(decode(Schema.Struct({ status: Schema.Literals(["A", "B"]) }), [2])).toThrow(
    /^Invalid enum tag 2 at byte 0\n {2}at \["status"\]$/,
  )
  expect(decode(Schema.Array(Schema.Enum(Text)), [2, 0, 0, 0, 1, 2])).toThrow(
    /^Invalid enum tag 2 at byte 5\n {2}at \[1\]$/,
  )
  expect(decode(Schema.Option(schema), [1, 9])).toThrow(
    /^Invalid enum tag 9 at byte 1\n {2}at \["value"\]$/,
  )
  expect(decode(schema, [])).toThrow(/^Truncated input: need 1 bytes at byte 0$/)

  const write = (s: Schema.Top, value: unknown) => () =>
    compile(Schema.toEncoded(s).ast).write(new Writer(64), value)
  const failure = (message: string, path: ReadonlyArray<PropertyKey>) =>
    expect.objectContaining({ message, path })
  const actions = Schema.Array(schema)
  expect(write(actions, [{ _tag: "Idle" }, { _tag: "Nope" }])).toThrow(
    failure("Invalid enum label at byte 5", [1, "_tag"]),
  )
  expect(write(actions, [{ _tag: "Count", value: 70_000 }])).toThrow(
    failure("Integer outside u16 range at byte 5", [0, "value"]),
  )
  const kinds = Schema.Union([
    Schema.Struct({ kind: Schema.Literal("A") }),
    Schema.Struct({ kind: Schema.Literal("B"), v: Borsh.U8 }),
  ]).pipe(Borsh.discriminants({ A: 0, B: 1 }, { tag: "kind" }))
  expect(write(Schema.Array(kinds), [{ kind: "B", v: 1 }, { kind: "C" }])).toThrow(
    failure("Invalid enum label at byte 6", [1, "kind"]),
  )
  expect(decode(Schema.Array(kinds), [1, 0, 0, 0, 1])).toThrow(
    /^Truncated input: need 1 bytes at byte 5\n {2}at \[0\]\["v"\]$/,
  )
  expect(write(Schema.Struct({ status: Schema.Literals(["A", "B"]) }), { status: "C" })).toThrow(
    failure("Invalid enum value at byte 0", ["status"]),
  )
  expect(write(Schema.Array(Schema.Enum(Numeric)), [0, 7])).toThrow(
    failure("Invalid enum value at byte 5", [1]),
  )
})

it("visits only present Option payloads and treats Option<Unit> as nonzero sized", () => {
  const c = Borsh.toCodec(Schema.Option(Schema.Array(Borsh.Unit)))
  expect(Schema.encodeSync(c)(Option.none())).toEqual(Uint8Array.of(0))
  expect(Schema.decodeSync(c)(Uint8Array.of(0))).toEqual(Option.none())
  expect(() => Schema.encodeSync(c)(Option.some([]))).toThrow(
    /zero-sized values at byte 1\n {2}at \["value"\]$/,
  )
  expect(() => Schema.decodeSync(c)(Uint8Array.of(1, 0, 0, 0, 0))).toThrow(
    /zero-sized values at byte 1\n {2}at \["value"\]$/,
  )
  const units = Borsh.toCodec(Schema.Array(Schema.Option(Borsh.Unit)))
  const value = [Option.none(), Option.some([] as const)] as const
  expect(Schema.encodeSync(units)(value)).toEqual(Uint8Array.of(2, 0, 0, 0, 0, 1))
  expect(Schema.decodeSync(units)(Uint8Array.of(2, 0, 0, 0, 0, 1))).toEqual(value)
})

it("keeps encoded payload transforms, brands and directional services", () => {
  class Decode extends Context.Service<Decode, { readonly prefix: string }>()("Decode") {}
  class Encode extends Context.Service<Encode, { readonly prefix: string }>()("Encode") {}
  const text = Borsh.U8.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformEffect({
        decode: (n) => Effect.map(Decode, (s) => s.prefix + n),
        encode: (value) => Effect.map(Encode, (s) => Number(value.slice(s.prefix.length))),
      }),
    ),
  )
  const action = Schema.TaggedUnion({ Idle: {}, Set: { value: Schema.Option(text) } })
  const c = Borsh.toCodec(action)
  expectTypeOf(c).toEqualTypeOf<Schema.Codec<typeof action.Type, Uint8Array, Decode, Encode>>()
  const raw = Uint8Array.of(1, 1, 7)
  expect(
    Effect.runSync(
      Schema.decodeEffect(c)(raw).pipe(Effect.provideService(Decode, { prefix: "v" })),
    ),
  ).toEqual({ _tag: "Set", value: Option.some("v7") })
  expect(
    Effect.runSync(
      Schema.encodeEffect(c)({ _tag: "Set", value: Option.some("v7") }).pipe(
        Effect.provideService(Encode, { prefix: "v" }),
      ),
    ),
  ).toEqual(raw)
  const positive = Borsh.U8.check(Schema.isGreaterThan(0)).pipe(Schema.brand("Positive"))
  const branded = Borsh.toCodec(Schema.Option(positive))
  expectTypeOf(branded.Type).toEqualTypeOf<Option.Option<typeof positive.Type>>()
  expect(() => Schema.decodeSync(branded)(Uint8Array.of(1, 0))).toThrow(Schema.SchemaError)
})

it("does not share struct layouts that omit an enum tag", () => {
  for (const fields of [
    { action: schema, plain: schema.cases.Count },
    { plain: schema.cases.Count, action: schema },
  ]) {
    expect(() => Borsh.toCodec(Schema.Struct(fields))).toThrow(
      /Unsupported encoded schema Literal; use Schema.Literals or a tagged union for a Rust enum/,
    )
  }
  const shared = Borsh.toCodec(Schema.Struct({ first: schema, second: schema }))
  expect(() => Schema.decodeSync(shared)(Uint8Array.of(3, 250, 0, 0, 0, 0, 2))).toThrow(
    /\n {2}at \["second"\]\["enabled"\]$/,
  )
})

it("checks malformed Option declarations and binary encoder inputs", () => {
  const ast = Schema.Option(Borsh.U8).ast
  const hole: SchemaAST.AST[] = []
  hole.length = 1
  for (const parameters of [[], [Borsh.U8.ast, Borsh.U8.ast], hole]) {
    const invalid = new SchemaAST.Declaration(parameters, ast.run, ast.annotations)
    expect(() => compile(invalid)).toThrow(/^\$: Option requires exactly 1 encoded type parameter$/)
  }
  expect(() => compile(ast).write(new Writer(20), {})).toThrow(/Expected Option/)
  const layout = compile(Schema.toEncoded(schema).ast)
  for (const value of [null, 1]) {
    expect(() => layout.write(new Writer(20), value)).toThrow(
      expect.objectContaining({ message: "Expected enum object at byte 0", path: [] }),
    )
  }
  for (const value of [{}, { _tag: "toString" }, { _tag: 3 }]) {
    expect(() => layout.write(new Writer(20), value)).toThrow(
      expect.objectContaining({ message: "Invalid enum label at byte 0", path: ["_tag"] }),
    )
  }
  const reader = new Reader(Uint8Array.of(1), { maxBytes: 20, maxItems: Infinity })
  expect(() => compile(Schema.Option(Borsh.U8).ast).read(reader)).toThrow(
    expect.objectContaining({
      message: "Truncated input: need 1 bytes at byte 1",
      path: ["value"],
    }),
  )
})

it("maps literal wire tags before native application tag transformations", () => {
  const tag = Schema.Literal("WireCount").pipe(
    Schema.decodeTo(
      Schema.Literal("Count"),
      SchemaTransformation.transform({
        decode: () => "Count" as const,
        encode: () => "WireCount" as const,
      }),
    ),
  )
  const union = Schema.Union([
    Schema.Struct({ kind: tag, value: Borsh.U8 }),
    Schema.Struct({ kind: Schema.Literal("Idle") }),
  ])
  const mapped = union.pipe(Borsh.discriminants({ WireCount: 17, Idle: 3 }, { tag: "kind" }))
  const c = Borsh.toCodec(mapped)
  expect(Schema.encodeSync(c)({ kind: "Count", value: 7 })).toEqual(Uint8Array.of(17, 7))
  expect(Schema.decodeSync(c)(Uint8Array.of(17, 7))).toEqual({ kind: "Count", value: 7 })
  expect(() => unchecked(union, { Count: 17, Idle: 3 }, "kind")).toThrow(
    /Unknown enum discriminants Count/,
  )
  const numeric = Schema.Union([
    Schema.Struct({
      kind: Borsh.U8.pipe(
        Schema.decodeTo(
          Schema.Literal("Count"),
          SchemaTransformation.transform({ decode: () => "Count" as const, encode: () => 17 }),
        ),
      ),
    }),
    Schema.Struct({ kind: Schema.Literal("Idle") }),
  ])
  expect(() => unchecked(numeric, { Count: 17, Idle: 3 }, "kind")).toThrow(
    /Enum tag "kind" must be a required string literal/,
  )
})

it("handles all 256 variants and rejects larger enums", () => {
  const members = Array.from({ length: 256 }, (_, i) => Schema.TaggedStruct(`V${i}`, {}))
  const reversed = Object.fromEntries(members.map((_, i) => [`V${i}`, 255 - i]))
  const positional = Borsh.toCodec(Schema.Union(members))
  const mapped = Borsh.toCodec(unchecked(Schema.Union(members), reversed))
  for (let i = 0; i < 256; i++) {
    expect(Schema.encodeSync(positional)({ _tag: `V${i}` })).toEqual(Uint8Array.of(i))
    expect(Schema.decodeSync(positional)(Uint8Array.of(i))).toEqual({ _tag: `V${i}` })
    expect(Schema.encodeSync(mapped)({ _tag: `V${i}` })).toEqual(Uint8Array.of(255 - i))
    expect(Schema.decodeSync(mapped)(Uint8Array.of(255 - i))).toEqual({ _tag: `V${i}` })
  }
  const labels = members.map((_, i) => `V${i}`)
  const literals = Borsh.toCodec(Schema.Literals(labels))
  for (let i = 0; i < 256; i++) {
    expect(Schema.decodeSync(literals)(Schema.encodeSync(literals)(`V${i}`))).toBe(`V${i}`)
  }
  for (const larger of [
    Schema.Union([...members, Schema.TaggedStruct("extra", {})]),
    Schema.Literals([...labels, "extra"]),
    Schema.Enum(Object.fromEntries([...labels, "extra"].map((label) => [label, label]))),
  ]) {
    expect(() => Borsh.toCodec(larger)).toThrow(/Enums require 1 through 256 variants/)
  }
  for (const empty of [Schema.Literals([]), Schema.Enum({})]) {
    expect(() => Borsh.toCodec(empty)).toThrow(/Enums require 1 through 256 variants/)
  }
})

it("runs the README enum and Option examples", () => {
  const Shape = Schema.TaggedUnion({
    Empty: {},
    Square: { value: Borsh.U32 },
    Rect: { width: Borsh.U16, height: Borsh.U16 },
  })
  const shape = Schema.encodeSync(Borsh.toCodec(Shape))({ _tag: "Square", value: 5 })
  expect(shape).toEqual(Uint8Array.of(1, 5, 0, 0, 0))
  const Status = Schema.Literals(["Pending", "Done"])
  expect(Schema.encodeSync(Borsh.toCodec(Status))("Done")).toEqual(Uint8Array.of(1))
  const Flag = Schema.TaggedUnion({ Off: {}, On: {} }).pipe(Borsh.discriminants({ Off: 1, On: 5 }))
  expect(Schema.encodeSync(Borsh.toCodec(Flag))({ _tag: "On" })).toEqual(Uint8Array.of(5))
  const Deposit = Schema.Option(Borsh.U128)
  const deposit = Schema.encodeSync(Borsh.toCodec(Deposit))(Option.some(1_000_000n))
  expect(deposit).toEqual(Uint8Array.of(1, 64, 66, 15, ...new Uint8Array(13)))
})

it("supports unsafe tag property names and nested enum payloads", () => {
  const inner = Schema.Union([
    Schema.Struct({ ["__proto__"]: Schema.Literal("A"), constructor: Borsh.U8 }),
    Schema.Struct({ ["__proto__"]: Schema.Literal("B") }),
  ]).pipe(Borsh.discriminants({ A: 9, B: 10 }, { tag: "__proto__" }))
  const outer = Schema.TaggedUnion({ Wrap: { action: inner }, Skip: {} })
  const c = Borsh.toCodec(outer)
  const value = { _tag: "Wrap", action: { ["__proto__"]: "A", constructor: 7 } } as const
  const raw = Uint8Array.of(0, 9, 7)
  expect(Schema.encodeSync(c)(value)).toEqual(raw)
  const decoded = Schema.decodeSync(c)(raw)
  expect(decoded).toEqual(value)
  if (decoded._tag === "Wrap") {
    expect(Object.getPrototypeOf(decoded.action)).toBe(Object.prototype)
    expect(Object.hasOwn(decoded.action, "__proto__")).toBe(true)
  }
})

it("preserves application transformations over a whole encoded enum", () => {
  const transformed = variants.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transform({
        decode: (value) => {
          switch (value._tag) {
            case "Idle":
              return "idle"
            case "Count":
              return String(value.value)
            default:
              return value.label
          }
        },
        encode: (text) =>
          text === "idle"
            ? { _tag: "Idle" as const }
            : { _tag: "Count" as const, value: Number(text) },
      }),
    ),
  )
  const mapped = transformed.pipe(Borsh.discriminants(discriminants))
  const c = Borsh.toCodec(mapped)
  expectTypeOf(c).toEqualTypeOf<Schema.Codec<string, Uint8Array>>()
  expect(Schema.encodeSync(c)("513")).toEqual(Uint8Array.of(17, 1, 2))
  expect(Schema.decodeSync(c)(Uint8Array.of(17, 1, 2))).toBe("513")
})

it("uses enum payload minimums without treating unit variants as zero sized", () => {
  const value = Schema.TaggedUnion({ Small: { value: Borsh.U16 }, Large: { value: Borsh.U32 } })
  expect(compile(Schema.toEncoded(value).ast).minBytes).toBe(3)
  const c = Borsh.toCodec(Schema.Array(value))
  expect(Schema.decodeSync(c)(Uint8Array.of(1, 0, 0, 0, 0, 1, 2))).toEqual([
    { _tag: "Small", value: 513 },
  ])
  expect(() => Schema.decodeSync(c)(Uint8Array.of(2, 0, 0, 0, 0, 1, 2))).toThrow(/Truncated vector/)
  const units = Schema.TaggedUnion({ A: {}, B: {} })
  expect(
    Schema.encodeSync(Borsh.toCodec(Schema.Array(units)))([{ _tag: "A" }, { _tag: "B" }]),
  ).toEqual(Uint8Array.of(2, 0, 0, 0, 0, 1))
})
