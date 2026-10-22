import {
  Context,
  Effect,
  Exit,
  HashMap,
  HashSet,
  Option,
  Result,
  Schema,
  SchemaAST,
  SchemaTransformation,
} from "effect"
import { expect, expectTypeOf, it } from "vite-plus/test"
import { Borsh } from "../src/index.js"
import { compile } from "../src/internal/compiler.js"
import { Writer } from "../src/internal/io.js"
import { noLimits } from "../src/internal/limits.js"

const mapSchemas = [
  Schema.ReadonlyMap(Borsh.U16, Schema.String),
  Schema.HashMap(Borsh.U16, Schema.String),
]
const setSchemas = [Schema.ReadonlySet(Schema.String), Schema.HashSet(Schema.String)]

it("sorts copied native collections numerically and by Unicode scalar, retaining their native shape", () => {
  const entries: [number, string][] = [
    [65535, "z"],
    [256, "b"],
    [1, "a"],
    [257, "c"],
    [255, "d"],
  ]
  const items = ["\u{10000}", "\ue000", "aa", "a", "", "\u{10001}", "\u{10000}a"]
  for (const schema of mapSchemas) {
    const codec = Borsh.toCodec(schema)
    const value = schema === mapSchemas[0] ? new Map(entries) : HashMap.fromIterable(entries)
    const before = Array.from(value)
    const raw = Schema.encodeUnknownSync(codec)(value)
    expect(raw.subarray(4, 6)).toEqual(Uint8Array.of(1, 0))
    const decoded = Schema.decodeSync(codec)(raw)
    expect(decoded instanceof Map || HashMap.isHashMap(decoded)).toBe(true)
    expect(new Map(decoded)).toEqual(new Map(entries))
    expect(Array.from(value)).toEqual(before)
    expect(
      Schema.encodeUnknownSync(codec)(
        schema === mapSchemas[0]
          ? new Map([...entries].reverse())
          : HashMap.fromIterable([...entries].reverse()),
      ),
    ).toEqual(raw)
  }
  for (const schema of setSchemas) {
    const codec = Borsh.toCodec(schema)
    const value = schema === setSchemas[0] ? new Set(items) : HashSet.fromIterable(items)
    const before = Array.from(value)
    const raw = Schema.encodeUnknownSync(codec)(value)
    const decoded = Schema.decodeSync(codec)(raw)
    expect(decoded instanceof Set || HashSet.isHashSet(decoded)).toBe(true)
    expect(new Set(decoded)).toEqual(new Set(items))
    expect(Array.from(value)).toEqual(before)
    expect(Schema.decodeSync(Borsh.toCodec(Schema.Array(Schema.String)))(raw)).toEqual([
      "",
      "a",
      "aa",
      "\ue000",
      "\u{10000}",
      "\u{10000}a",
      "\u{10001}",
    ])
  }
})

it("rejects duplicate and descending wire keys before native construction", () => {
  for (const schema of [
    Schema.ReadonlyMap(Borsh.U16, Borsh.Unit),
    Schema.HashMap(Borsh.U16, Borsh.Unit),
    Schema.ReadonlySet(Borsh.U16),
    Schema.HashSet(Borsh.U16),
  ]) {
    const codec = Borsh.toCodec(Schema.Struct({ entries: schema }))
    for (const raw of [
      Uint8Array.of(2, 0, 0, 0, 1, 0, 1, 0),
      Uint8Array.of(2, 0, 0, 0, 0, 1, 1, 0),
    ]) {
      expect(() => Schema.decodeSync(codec)(raw)).toThrow(
        /Collection keys must be strictly increasing at byte 6\n {2}at \["entries"\]\[1\]\["key"\]$/,
      )
    }
    expect(() => Schema.decodeSync(codec)(Uint8Array.of(255, 255, 255, 255))).toThrow(
      /Truncated collection payload/,
    )
  }
})

it("rejects unsupported key orderings at construction, including empty collections", () => {
  for (const key of [
    Borsh.F32,
    Borsh.F64,
    Borsh.Unit,
    Borsh.Bytes,
    Schema.Struct({ n: Borsh.U8 }),
    Schema.Option(Borsh.U8),
    Schema.Array(Borsh.U8),
  ]) {
    for (const [schema, name] of [
      [Schema.ReadonlyMap(key, Borsh.U8), "ReadonlyMap"],
      [Schema.HashMap(key, Borsh.U8), "HashMap"],
      [Schema.ReadonlySet(key), "ReadonlySet"],
      [Schema.HashSet(key), "HashSet"],
    ] as const) {
      expect(() => Borsh.toCodec(schema)).toThrow(
        new Error(`$: ${name} keys require Boolean, integer or String Rust ordering`),
      )
    }
  }
})

it("validates collection arities and native binary shapes", () => {
  const names = ["ReadonlyMap", "HashMap", "ReadonlySet", "HashSet"]
  for (const [i, schema] of [...mapSchemas, ...setSchemas].entries()) {
    const ast = Schema.toEncoded(schema).ast
    expect(ast._tag).toBe("Declaration")
    if (ast._tag !== "Declaration") {
      throw new Error("Expected Declaration")
    }
    const arity = i < 2 ? "2 encoded type parameters" : "1 encoded type parameter"
    const message = new Error(`$: ${names[i]} requires exactly ${arity}`)
    expect(() =>
      compile(new SchemaAST.Declaration([], ast.run, ast.annotations), noLimits),
    ).toThrow(message)
    // Sparse hand-built parameters fail the same check: an empty set key or map value slot.
    const sparse = ast.typeParameters.slice(0, i < 2 ? 1 : 0)
    sparse.length = ast.typeParameters.length
    expect(() =>
      compile(new SchemaAST.Declaration(sparse, ast.run, ast.annotations), noLimits),
    ).toThrow(message)
    const layout = compile(ast, noLimits)
    for (const value of [null, [], {}, 1]) {
      expect(() => layout.write(new Writer(64), value)).toThrow(/Expected native collection/)
    }
    expect(() => Schema.encodeUnknownSync(Borsh.toCodec(schema))([])).toThrow(Schema.SchemaError)
    const empty = [new Map(), HashMap.empty(), new Set(), HashSet.empty()][i]
    expect(Schema.encodeUnknownSync(Borsh.toCodec(schema))(empty)).toEqual(new Uint8Array(4))
    expect(() => Schema.encodeUnknownSync(Borsh.toCodec(schema, { maxBytes: 3 }))(empty)).toThrow(
      /maxBytes/,
    )
    expect(() =>
      Schema.decodeSync(Borsh.toCodec(schema, { maxBytes: 3 }))(new Uint8Array(4)),
    ).toThrow(/maxBytes/)
  }
})

it("preflights collection bytes before copying entries and preserves precise payload failures", () => {
  const schema = Schema.ReadonlyMap(Borsh.U16, Schema.Boolean)
  const layout = compile(Schema.toEncoded(schema).ast, noLimits)
  const huge = new Map([[1, true]])
  Object.defineProperty(huge, "size", { value: 0x1_0000_0000, configurable: true })
  expect(() => layout.write(new Writer(32), huge)).toThrow(/u32 length/)
  Object.defineProperty(huge, "size", { value: 100, configurable: true })
  Object.defineProperty(huge, Symbol.iterator, {
    value: () => {
      throw new Error("copied")
    },
  })
  expect(() => layout.write(new Writer(8), huge)).toThrow(/maxBytes/)
  const codec = Borsh.toCodec(schema)
  expect(() => Schema.decodeSync(codec)(Uint8Array.of(1, 0, 0, 0, 1, 0, 2))).toThrow(
    /Invalid bool tag 2 at byte 6\n {2}at \[0\]\["value"\]$/,
  )
  expect(() => Schema.decodeSync(codec)(Uint8Array.of(1, 0, 0, 0, 1, 0))).toThrow(
    /Truncated collection payload/,
  )
  expect(() => Schema.decodeSync(codec)(Uint8Array.of(0, 0, 0, 0, 0))).toThrow(/Trailing/)
  const strings = Borsh.toCodec(Schema.ReadonlySet(Schema.String))
  expect(() => Schema.decodeSync(strings)(Uint8Array.of(1, 0, 0, 0, 2, 0, 0, 0, 97))).toThrow(
    /Truncated input: need 2 bytes at byte 8\n {2}at \[0\]\["key"\]$/,
  )
  expect(() => Schema.decodeSync(strings)(Uint8Array.of(1, 0, 0, 0, 1, 0, 0, 0, 255))).toThrow(
    /Invalid UTF-8/,
  )
  expect(() => Schema.encodeSync(strings)(new Set(["\ud800"]))).toThrow(/Lone UTF-16 surrogate/)
})

it("composes map values with arrays, Options, Results, structs, enums and owned bytes", () => {
  const action = Schema.TaggedUnion({ Idle: {}, Data: { bytes: Borsh.Bytes } }).pipe(
    Borsh.discriminants({ Idle: 0, Data: 7 }),
  )
  const schema = Schema.Array(
    Schema.ReadonlyMap(
      Schema.Boolean,
      Schema.Struct({ outcomes: Schema.Array(Schema.Result(Schema.Option(action), Borsh.U16)) }),
    ),
  )
  const codec = Borsh.toCodec(schema)
  const payload = Uint8Array.of(1, 2)
  const value = [
    new Map([
      [
        true,
        {
          outcomes: [
            Result.succeed(Option.some({ _tag: "Data" as const, bytes: payload })),
            Result.fail(7),
          ],
        },
      ],
    ]),
  ]
  const raw = Schema.encodeSync(codec)(value)
  const decoded = Schema.decodeSync(codec)(raw)
  expect(decoded).toEqual(value)
  raw.fill(0)
  expect(decoded).toEqual(value)
  payload.fill(9)
  expect(decoded).not.toEqual(value)
})

class Decode extends Context.Service<Decode, { readonly prefix: string }>()("CollectionsDecode") {}
class Encode extends Context.Service<Encode, { readonly prefix: string }>()("CollectionsEncode") {}
it("retains inner transforms, directional services, checks, brands and defects", async () => {
  const key = Borsh.U16.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformEffect({
        decode: (n) => Effect.map(Decode, ({ prefix }) => prefix + n),
        encode: (s) => Effect.map(Encode, ({ prefix }) => Number(s.slice(prefix.length))),
      }),
    ),
  )
  const schema = Schema.ReadonlyMap(key, Borsh.U8)
    .check(Schema.makeFilter((map) => map.size > 0))
    .pipe(Schema.brand("NonemptyMap"))
  const codec = Borsh.toCodec(schema)
  expectTypeOf(codec).toEqualTypeOf<Schema.Codec<typeof schema.Type, Uint8Array, Decode, Encode>>()
  const raw = Uint8Array.of(1, 0, 0, 0, 1, 0, 7)
  const value = await Effect.runPromise(
    Schema.decodeEffect(codec)(raw).pipe(Effect.provideService(Decode, { prefix: "v" })),
  )
  expect(new Map(value)).toEqual(new Map([["v1", 7]]))
  expect(
    await Effect.runPromise(
      Schema.encodeEffect(codec)(value).pipe(Effect.provideService(Encode, { prefix: "v" })),
    ),
  ).toEqual(raw)
  expect(() =>
    Schema.decodeSync(
      Borsh.toCodec(Schema.ReadonlySet(Borsh.U8).check(Schema.makeFilter((set) => set.size > 0))),
    )(new Uint8Array(4)),
  ).toThrow(Schema.SchemaError)
  const defect = new Error("collection defect")
  const defective = Borsh.toCodec(
    Schema.ReadonlyMap(Borsh.U16, Borsh.U8).check(
      Schema.makeFilter(() => {
        throw defect
      }),
    ),
  )
  expect(Exit.hasDies(await Effect.runPromiseExit(Schema.decodeEffect(defective)(raw)))).toBe(true)
  expect(Schema.decodeSync(Borsh.toCodec(Schema.ReadonlyMap(Borsh.U16, Borsh.U8)))(raw)).toEqual(
    new Map([[1, 7]]),
  )
})

it("preserves native key transformation order and collision semantics", () => {
  const negative = Borsh.U8.pipe(
    Schema.decodeTo(
      Schema.Finite,
      SchemaTransformation.transform({ decode: (n) => -n, encode: (n) => -n }),
    ),
  )
  const reverse = Borsh.toCodec(Schema.ReadonlySet(negative))
  expect(Schema.encodeSync(reverse)(new Set([-2, -1]))).toEqual(Uint8Array.of(2, 0, 0, 0, 1, 2))
  const key = Borsh.U8.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transform({ decode: String, encode: Number }),
    ),
  )
  for (const [schema, input] of [
    [Schema.ReadonlySet(key), new Set(["01", "1"])],
    [Schema.HashSet(key), HashSet.fromIterable(["01", "1"])],
  ] as const) {
    const encoded = Schema.encodeUnknownSync(schema)(input)
    const codec = Borsh.toCodec(schema)
    expect(Schema.encodeUnknownSync(codec)(input)).toEqual(Uint8Array.of(1, 0, 0, 0, 1))
    expect(Schema.decodeSync(codec)(Uint8Array.of(1, 0, 0, 0, 1))).toEqual(
      Schema.decodeSync(schema)(encoded),
    )
  }
  const checked = Borsh.toCodec(Schema.ReadonlySet(Borsh.U8.check(Schema.isGreaterThan(0))))
  expect(() => Schema.decodeSync(checked)(Uint8Array.of(1, 0, 0, 0, 0))).toThrow(Schema.SchemaError)
})

it("treats maps as nonzero-sized and only visits present value layouts", () => {
  const units = Borsh.toCodec(Schema.Array(Schema.ReadonlyMap(Borsh.U16, Borsh.Unit)))
  const value = [
    new Map<number, readonly []>(),
    new Map([
      [1, [] as const],
      [256, [] as const],
    ]),
  ]
  expect(Schema.decodeSync(units)(Schema.encodeSync(units)(value))).toEqual(value)
  const vectors = Borsh.toCodec(Schema.ReadonlyMap(Borsh.U16, Schema.Array(Borsh.Unit)))
  expect(Schema.encodeSync(vectors)(new Map())).toEqual(new Uint8Array(4))
  expect(() => Schema.encodeSync(vectors)(new Map([[1, []]]))).toThrow(/zero-sized/)
  const fixed = Borsh.toCodec(
    Schema.ReadonlyMap(Borsh.U16, Borsh.fixedArray(Schema.Array(Borsh.Unit), 0)),
  )
  expect(Schema.decodeSync(fixed)(Schema.encodeSync(fixed)(new Map([[1, []]])))).toEqual(
    new Map([[1, []]]),
  )
})

it("checks encoded iterator duplicates and invalid primitive comparison inputs", () => {
  const layout = compile(Schema.toEncoded(Schema.ReadonlyMap(Borsh.U16, Borsh.Unit)).ast, noLimits)
  const duplicate = new Map([[1, []]])
  Object.defineProperty(duplicate, Symbol.iterator, {
    value: function* () {
      yield [1, []]
      yield [1, []]
    },
  })
  expect(() => layout.write(new Writer(64), duplicate)).toThrow(
    expect.objectContaining({
      message: "Collection keys must be strictly increasing at byte 6",
      path: [1, "key"],
    }),
  )
  expect(() =>
    layout.write(
      new Writer(64),
      new Map([
        [{}, []],
        [{}, []],
      ]),
    ),
  ).toThrow(/Expected ordered primitive/)
  const strings = compile(Schema.toEncoded(Schema.ReadonlySet(Schema.String)).ast, noLimits)
  expect(() => strings.write(new Writer(64), new Set([1, 2]))).toThrow(/Expected string key/)
})

it("encodes empty native maps when a shared value layout overflows its minimum size", () => {
  let value: Schema.Codec<unknown> = Borsh.fixedArray(Borsh.U8, 0xffff_ffff)
  for (let i = 0; i < 500; i++) {
    value = Schema.Struct({ a: value, b: value, c: value, d: value })
  }
  expect(compile(Schema.toEncoded(value).ast, noLimits).minBytes).toBe(Infinity)
  for (const [schema, empty] of [
    [Schema.ReadonlyMap(Borsh.U8, value), new Map()],
    [Schema.HashMap(Borsh.U8, value), HashMap.empty()],
  ] as const) {
    const codec = Borsh.toCodec(schema, { maxBytes: 4 })
    const raw = new Uint8Array(4)
    expect(Schema.decodeSync(codec)(raw)).toEqual(empty)
    expect(Schema.encodeUnknownSync(codec)(empty)).toEqual(raw)
  }
})

it("rejects lone surrogates in multi-entry sets without conflating distinct keys", () => {
  for (const [schema, value] of [
    [Schema.ReadonlySet(Schema.String), new Set(["\u2400\u0000", "\ud800\u0000"])],
    [Schema.HashSet(Schema.String), HashSet.fromIterable(["\u2400\u0000", "\ud800\u0000"])],
  ] as const) {
    expect(() => Schema.encodeUnknownSync(Borsh.toCodec(schema))(value)).toThrow(
      /Lone UTF-16 surrogate/,
    )
  }
})

it("preserves native decoding collisions while rejecting duplicate encoded keys", () => {
  const item = Schema.String.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transform({
        decode: (value) => value.toLowerCase(),
        encode: (value) => value,
      }),
    ),
  )
  const encode = Schema.encodeSync(Borsh.toCodec(Schema.Array(Schema.String)))
  for (const [schema, encoded] of [
    [Schema.ReadonlySet(item), new Set(["A", "a"])],
    [Schema.HashSet(item), HashSet.fromIterable(["A", "a"])],
  ] as const) {
    const codec = Borsh.toCodec(schema)
    expect(Schema.decodeSync(codec)(encode(["A", "a"]))).toEqual(Schema.decodeSync(schema)(encoded))
    expect(new Set(Schema.decodeSync(codec)(encode(["A", "a"])))).toEqual(new Set(["a"]))
    expect(() => Schema.decodeSync(codec)(encode(["a", "a"]))).toThrow(/strictly increasing/)
  }
})

it("orders native boolean and signed bigint sets by primitive value", () => {
  for (const [item, values] of [
    [Schema.Boolean, [false, true]],
    [Borsh.I128, [-(1n << 127n), -1n, 0n, (1n << 127n) - 1n]],
  ] as const) {
    const expected = Schema.encodeUnknownSync(Borsh.toCodec(Schema.Array(item)))(values)
    for (const [schema, value] of [
      [Schema.ReadonlySet(item), new Set([...values].reverse())],
      [Schema.HashSet(item), HashSet.fromIterable([...values].reverse())],
    ] as const) {
      const codec = Borsh.toCodec(schema)
      expect(Schema.encodeUnknownSync(codec)(value)).toEqual(expected)
      expect(new Set(Schema.decodeSync(codec)(expected))).toEqual(new Set<boolean | bigint>(values))
    }
  }
})
