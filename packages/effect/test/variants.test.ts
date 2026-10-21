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
const schema = Borsh.enumLayout(variants, { tag: "_tag", discriminants })
const codec = Borsh.toCodec(schema)

it("retains native union helpers, checks and discriminant narrowing", () => {
  expectTypeOf(schema).toEqualTypeOf<typeof variants>()
  const count = schema.cases.Count.make({ value: 513 })
  expectTypeOf(count._tag).toEqualTypeOf<"Count">()
  expect(
    schema.match(count, { Idle: () => 0, Count: (v) => v.value, Named: (v) => v.label.length }),
  ).toBe(513)
  const value = Schema.decodeSync(codec)(Uint8Array.of(17, 1, 2))
  expectTypeOf(value).toEqualTypeOf<typeof variants.Type>()
  if (value._tag === "Count") expectTypeOf(value.value).toEqualTypeOf<number>()
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
    for (let cut = 0; cut < bytes.length; cut++)
      expect(() => Schema.decodeSync(codec)(bytes.subarray(0, cut))).toThrow(Schema.SchemaError)
    expect(() => Schema.decodeSync(codec)(Uint8Array.of(...bytes, 0))).toThrow(/Trailing/)
  }
  for (let tag = 0; tag < 256; tag++) {
    if (tag === 3) expect(Schema.decodeSync(codec)(Uint8Array.of(tag))).toEqual({ _tag: "Idle" })
    else
      expect(() => Schema.decodeSync(codec)(Uint8Array.of(tag))).toThrow(
        tag === 17 || tag === 250 ? /Truncated/ : /Invalid enum tag/,
      )
  }
  expect(() => Schema.encodeUnknownSync(codec)({ _tag: "Other" })).toThrow(Schema.SchemaError)
})

it("uses exact maps independently of union order, tag key and unsafe labels", () => {
  const custom = Schema.Union([
    Schema.Struct({ kind: Schema.Literal("constructor"), value: Borsh.U8 }),
    Schema.Struct({ kind: Schema.Literal("__proto__") }),
    Schema.Struct({ kind: Schema.Literal("2") }),
  ])
  const mapped = Borsh.enumLayout(custom, {
    tag: "kind",
    discriminants: { "2": 255, ["__proto__"]: 0, constructor: 7 },
  })
  const c = Borsh.toCodec(mapped)
  for (const [value, bytes] of [
    [{ kind: "__proto__" }, [0]],
    [{ kind: "constructor", value: 8 }, [7, 8]],
    [{ kind: "2" }, [255]],
  ] as const) {
    expect(Schema.encodeSync(c)(value)).toEqual(Uint8Array.from(bytes))
    expect(Schema.decodeSync(c)(Uint8Array.from(bytes))).toEqual(value)
  }
  const reordered = Borsh.enumLayout(mapped, {
    tag: "kind",
    discriminants: { constructor: 7, ["__proto__"]: 0, "2": 255 },
  })
  expect(Schema.encodeSync(Borsh.toCodec(reordered))({ kind: "2" })).toEqual(Uint8Array.of(255))
  const copied = { ...discriminants }
  const frozen = Borsh.enumLayout(variants, { tag: "_tag", discriminants: copied })
  copied.Idle = 9
  expect(Schema.encodeSync(Borsh.toCodec(frozen))({ _tag: "Idle" })).toEqual(Uint8Array.of(3))
  const metadata = Schema.toEncoded(frozen).ast.annotations?.[key]
  expect(Object.isFrozen(metadata)).toBe(true)
  expect(metadata?.kind === "enum" && Object.isFrozen(metadata.discriminants)).toBe(true)
})

it("rejects malformed enums and descriptors", () => {
  for (const invalidMap of [
    { Idle: 3, Count: 17 },
    { ...discriminants, Extra: 9 },
    { ...discriminants, Count: 3 },
    { ...discriminants, Count: -1 },
    { ...discriminants, Count: 256 },
    { ...discriminants, Count: 1.5 },
    { ...discriminants, Count: NaN },
  ])
    expect(() =>
      Borsh.toCodec(Borsh.enumLayout(variants, { tag: "_tag", discriminants: invalidMap })),
    ).toThrow(/enum/i)
  for (const invalid of [
    Schema.TaggedUnion({ Idle: {} }),
    Schema.Union([Schema.String, Schema.TaggedStruct("Idle", {})]),
    Schema.Union([Schema.Struct({}), Schema.TaggedStruct("Idle", {})]),
    Schema.Union([Schema.Struct({ _tag: Schema.String }), Schema.TaggedStruct("Idle", {})]),
    Schema.Union([
      Schema.Struct({ _tag: Schema.optionalKey(Schema.Literal("Count")) }),
      Schema.TaggedStruct("Idle", {}),
    ]),
    Schema.Union([
      Schema.TaggedStruct("Idle", { value: Borsh.U8 }),
      Schema.TaggedStruct("Idle", {}),
    ]),
  ])
    expect(() => Borsh.toCodec(Borsh.enumLayout(invalid, { tag: "_tag", discriminants }))).toThrow(
      /enum/i,
    )
  for (const raw of [
    { version: 1, kind: "enum" },
    { version: 1, kind: "enum", tag: "_tag", discriminants: [] },
    { version: 1, kind: "enum", tag: "_tag", discriminants: { Idle: "3" } },
  ])
    expect(() => Borsh.toCodec(variants.annotate({ [key]: raw } as never))).toThrow(/Borsh/)
  expect(() => Borsh.toCodec(variants)).toThrow(/Unsupported encoded schema Union/)
  expect(() => Borsh.toCodec(Schema.NullOr(Borsh.U8))).toThrow(/Union/)
  expect(() =>
    Borsh.toCodec(
      Borsh.Bytes.annotate({ [key]: { version: 1, kind: "enum", tag: "_tag", discriminants } }),
    ),
  ).toThrow(/Enum layout/)
})

it("finds enum metadata in final checks and nested groups and rejects conflicts", () => {
  const layout = { version: 1, kind: "enum", tag: "_tag", discriminants } as const
  const check = Schema.makeFilter((_: typeof variants.Type) => true).annotate({ [key]: layout })
  const checked = variants.check(
    Schema.makeFilter(() => true),
    check.and(Schema.makeFilter(() => true)).and(Schema.makeFilter(() => true)),
  )
  expect(Schema.encodeSync(Borsh.toCodec(checked))({ _tag: "Idle" })).toEqual(Uint8Array.of(3))
  expect(() =>
    Borsh.enumLayout(checked, { tag: "_tag", discriminants: { ...discriminants, Idle: 4 } }),
  ).toThrow(/Conflicting/)
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
  expect(() =>
    Borsh.enumLayout(Schema.TaggedUnion({ Idle: {}, Count: { value: suspended } }), {
      tag: "_tag",
      discriminants: { Idle: 0, Count: 1 },
    }),
  ).toThrow(/Suspend/)
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
    for (let cut = 0; cut < bytes.length; cut++)
      expect(() => Schema.decodeSync(c)(bytes.subarray(0, cut))).toThrow(/Truncated/)
    expect(() => Schema.decodeSync(c)(Uint8Array.of(...bytes, 0))).toThrow(/Trailing/)
  }
  for (let tag = 2; tag < 256; tag++)
    expect(() => Schema.decodeSync(c)(Uint8Array.of(tag))).toThrow(/Invalid Option tag/)
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
  ).toThrow(/\$\["actions"\]\[1\]\["value"\]\["enabled"\] at byte 11/)
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

it("visits only present Option payloads and treats Option<Unit> as nonzero sized", () => {
  const c = Borsh.toCodec(Schema.Option(Schema.Array(Borsh.Unit)))
  expect(Schema.encodeSync(c)(Option.none())).toEqual(Uint8Array.of(0))
  expect(Schema.decodeSync(c)(Uint8Array.of(0))).toEqual(Option.none())
  expect(() => Schema.encodeSync(c)(Option.some([]))).toThrow(/value.*zero-sized/)
  expect(() => Schema.decodeSync(c)(Uint8Array.of(1, 0, 0, 0, 0))).toThrow(/value.*zero-sized/)
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
  const action = Borsh.enumLayout(
    Schema.TaggedUnion({ Idle: {}, Set: { value: Schema.Option(text) } }),
    { tag: "_tag", discriminants: { Idle: 0, Set: 1 } },
  )
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
  ])
    expect(() => Borsh.toCodec(Schema.Struct(fields))).toThrow(/Unsupported encoded schema Literal/)
  const shared = Borsh.toCodec(Schema.Struct({ first: schema, second: schema }))
  expect(() => Schema.decodeSync(shared)(Uint8Array.of(3, 250, 0, 0, 0, 0, 2))).toThrow(
    /\$\["second"\]\["enabled"\]/,
  )
})

it("checks malformed Option declarations and binary encoder inputs", () => {
  const ast = Schema.Option(Borsh.U8).ast
  for (const parameters of [[], [Borsh.U8.ast, Borsh.U8.ast]]) {
    const invalid = new SchemaAST.Declaration(parameters, ast.run, ast.annotations)
    expect(() => compile(invalid)).toThrow(/exactly one/)
  }
  expect(() => compile(ast).write(new Writer(20), {})).toThrow(/Expected Option/)
  const layout = compile(Schema.toEncoded(schema).ast)
  for (const value of [null, 1, {}, { _tag: "toString" }, { _tag: 3 }])
    expect(() => layout.write(new Writer(20), value)).toThrow(/enum/i)
  expect(() => compile(Schema.Option(Borsh.U8).ast).read(new Reader(Uint8Array.of(1), 20))).toThrow(
    /value.*Truncated/,
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
  const mapped = Borsh.enumLayout(union, { tag: "kind", discriminants: { WireCount: 17, Idle: 3 } })
  const c = Borsh.toCodec(mapped)
  expect(Schema.encodeSync(c)({ kind: "Count", value: 7 })).toEqual(Uint8Array.of(17, 7))
  expect(Schema.decodeSync(c)(Uint8Array.of(17, 7))).toEqual({ kind: "Count", value: 7 })
  expect(() =>
    Borsh.toCodec(Borsh.enumLayout(union, { tag: "kind", discriminants: { Count: 17, Idle: 3 } })),
  ).toThrow(/Missing enum discriminant for WireCount/)
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
  expect(() =>
    Borsh.toCodec(
      Borsh.enumLayout(numeric, { tag: "kind", discriminants: { Count: 17, Idle: 3 } }),
    ),
  ).toThrow(/required string literal/)
})

it("handles all 256 variants and rejects larger enums", () => {
  const members = Array.from({ length: 256 }, (_, i) => Schema.TaggedStruct(String(i), {}))
  const discriminants = Object.fromEntries(members.map((_, i) => [String(i), 255 - i]))
  const c = Borsh.toCodec(Borsh.enumLayout(Schema.Union(members), { tag: "_tag", discriminants }))
  for (let i = 0; i < 256; i++) {
    expect(Schema.encodeSync(c)({ _tag: String(i) })).toEqual(Uint8Array.of(255 - i))
    expect(Schema.decodeSync(c)(Uint8Array.of(255 - i))).toEqual({ _tag: String(i) })
  }
  expect(() =>
    Borsh.toCodec(
      Borsh.enumLayout(Schema.Union([...members, Schema.TaggedStruct("extra", {})]), {
        tag: "_tag",
        discriminants,
      }),
    ),
  ).toThrow(/2..256/)
})

it("runs the README enum and Option examples", () => {
  const Status = Borsh.enumLayout(
    Schema.TaggedUnion({ Pending: {}, Complete: { receiptId: Borsh.U64 } }),
    { tag: "_tag", discriminants: { Pending: 0, Complete: 1 } },
  )
  const status = Schema.encodeSync(Borsh.toCodec(Status))({ _tag: "Pending" })
  expect(status).toEqual(Uint8Array.of(0))
  const Deposit = Schema.Option(Borsh.U128)
  const deposit = Schema.encodeSync(Borsh.toCodec(Deposit))(Option.some(1_000_000n))
  expect(deposit).toEqual(Uint8Array.of(1, 64, 66, 15, ...new Uint8Array(13)))
})

it("supports unsafe tag property names and nested enum payloads", () => {
  const inner = Borsh.enumLayout(
    Schema.Union([
      Schema.Struct({ ["__proto__"]: Schema.Literal("A"), constructor: Borsh.U8 }),
      Schema.Struct({ ["__proto__"]: Schema.Literal("B") }),
    ]),
    { tag: "__proto__", discriminants: { A: 9, B: 10 } },
  )
  const outer = Borsh.enumLayout(Schema.TaggedUnion({ Wrap: { action: inner }, Skip: {} }), {
    tag: "_tag",
    discriminants: { Wrap: 1, Skip: 0 },
  })
  const c = Borsh.toCodec(outer)
  const value = { _tag: "Wrap", action: { ["__proto__"]: "A", constructor: 7 } } as const
  const raw = Uint8Array.of(1, 9, 7)
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
        decode: (value) =>
          value._tag === "Idle"
            ? "idle"
            : value._tag === "Count"
              ? String(value.value)
              : value.label,
        encode: (text) =>
          text === "idle"
            ? { _tag: "Idle" as const }
            : { _tag: "Count" as const, value: Number(text) },
      }),
    ),
  )
  const mapped = Borsh.enumLayout(transformed, { tag: "_tag", discriminants })
  const c = Borsh.toCodec(mapped)
  expectTypeOf(c).toEqualTypeOf<Schema.Codec<string, Uint8Array>>()
  expect(Schema.encodeSync(c)("513")).toEqual(Uint8Array.of(17, 1, 2))
  expect(Schema.decodeSync(c)(Uint8Array.of(17, 1, 2))).toBe("513")
})

it("uses enum payload minimums without treating unit variants as zero sized", () => {
  const value = Borsh.enumLayout(
    Schema.TaggedUnion({ Small: { value: Borsh.U16 }, Large: { value: Borsh.U32 } }),
    { tag: "_tag", discriminants: { Small: 0, Large: 1 } },
  )
  expect(compile(Schema.toEncoded(value).ast).minBytes).toBe(3)
  const c = Borsh.toCodec(Schema.Array(value))
  expect(Schema.decodeSync(c)(Uint8Array.of(1, 0, 0, 0, 0, 1, 2))).toEqual([
    { _tag: "Small", value: 513 },
  ])
  expect(() => Schema.decodeSync(c)(Uint8Array.of(2, 0, 0, 0, 0, 1, 2))).toThrow(/Truncated vector/)
  const units = Borsh.enumLayout(Schema.TaggedUnion({ A: {}, B: {} }), {
    tag: "_tag",
    discriminants: { A: 0, B: 1 },
  })
  expect(
    Schema.encodeSync(Borsh.toCodec(Schema.Array(units)))([{ _tag: "A" }, { _tag: "B" }]),
  ).toEqual(Uint8Array.of(2, 0, 0, 0, 0, 1))
})
