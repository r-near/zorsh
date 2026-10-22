import assert from "node:assert/strict"
import { Option, Result, Schema } from "effect"
import fc from "fast-check"
import { afterAll, beforeAll, describe, it } from "vite-plus/test"
import { Oracle, assertProperty } from "./oracle.js"
import { attempt, bytes, hex, stringArbitrary } from "./primitives.js"
const packageName = "@zorsh/effect"
const { Borsh }: typeof import("../../src/index.js") = await import(packageName)

let oracle: Oracle
beforeAll(() => {
  oracle = new Oracle()
})
afterAll(async () => {
  await oracle.close()
})
function spec<A>(
  id: string,
  schema: Schema.Codec<A>,
  arbitrary: fc.Arbitrary<A>,
  transport: (value: A) => unknown,
  name = id,
) {
  const codec = Borsh.toCodec(schema)
  const encode = Schema.encodeSync(codec)
  const decode = Schema.decodeSync(codec)
  return {
    id,
    name,
    arbitrary: arbitrary.map((value) => ({ raw: encode(value), transport: transport(value) })),
    decode: (raw: Uint8Array) => {
      const value = decode(raw)
      return { raw: encode(value), transport: transport(value) }
    },
  }
}
const option = <A>(arbitrary: fc.Arbitrary<A>) =>
  fc.option(arbitrary, { nil: undefined }).map(Option.fromUndefinedOr)
function optionTransport<A>(value: Option.Option<A>, inner: (value: A) => unknown): unknown {
  return Option.isNone(value) ? { tag: "None" } : { tag: "Some", value: inner(value.value) }
}
const ExplicitEnum = Schema.TaggedUnion({
  Idle: {},
  Count: { value: Borsh.U16 },
  Named: { label: Schema.String, enabled: Schema.Boolean },
}).pipe(Borsh.discriminants({ Idle: 3, Count: 17, Named: 250 }))
const Status = Schema.Literals(["Pending", "Active", "Done"])
enum StatusEnum {
  Pending = "pending",
  Active = "active",
  Done = "done",
}
const statusNames = { pending: "Pending", active: "Active", done: "Done" } as const
enum NumericStatus {
  Pending,
  Active,
  Done,
}
enum SparseStatus {
  Pending = 1,
  Done = 5,
}
const sparseStatuses = [
  Schema.Literals(["Pending", "Done"]).pipe(Borsh.discriminants({ Pending: 1, Done: 5 })),
  Schema.Enum(SparseStatus).pipe(Borsh.discriminants({ Pending: 1, Done: 5 })),
] as const
const Shape = Schema.TaggedUnion({
  Empty: {},
  Square: { value: Borsh.U32 },
  Rect: { width: Borsh.U16, height: Borsh.U16 },
})
const u16 = fc.integer({ min: 0, max: 65535 })
const u128 = fc.bigInt({ min: 0n, max: (1n << 128n) - 1n })
const entries = [
  spec(
    "array_u16_3",
    Schema.Array(Borsh.U16).pipe(Borsh.fixedArray(3)),
    fc.array(fc.integer({ min: 0, max: 65535 }), { minLength: 3, maxLength: 3 }),
    (values) => values.map(String),
  ),
  spec(
    "result_u16_string",
    Schema.Result(Borsh.U16, Schema.String),
    fc.oneof(
      fc.integer({ min: 0, max: 65535 }).map(Result.succeed),
      stringArbitrary.map(Result.fail),
    ),
    (value) =>
      Result.isSuccess(value)
        ? { tag: "Ok", value: String(value.success) }
        : { tag: "Err", value: value.failure },
  ),
  spec(
    "result_option_u8_unit",
    Schema.Result(Schema.Option(Borsh.U8), Borsh.Unit),
    fc.oneof(
      option(fc.integer({ min: 0, max: 255 })).map(Result.succeed),
      fc.constant(Result.fail([] as const)),
    ),
    (value) =>
      Result.isSuccess(value)
        ? { tag: "Ok", value: optionTransport(value.success, String) }
        : { tag: "Err", value: null },
  ),
  spec(
    "explicit_enum",
    ExplicitEnum,
    fc.oneof(
      fc.constant({ _tag: "Idle" } as const),
      fc.record({ _tag: fc.constant("Count" as const), value: fc.integer({ min: 0, max: 65535 }) }),
      fc.record({
        _tag: fc.constant("Named" as const),
        label: stringArbitrary,
        enabled: fc.boolean(),
      }),
    ),
    (value) => ({
      variant: value._tag,
      value:
        value._tag === "Idle"
          ? null
          : value._tag === "Count"
            ? String(value.value)
            : { label: value.label, enabled: value.enabled },
    }),
  ),
  spec(
    "status",
    Status,
    fc.constantFrom(...Status.literals),
    (value) => ({ variant: value, value: null }),
    "status Schema.Literals",
  ),
  spec(
    "status",
    Schema.Enum(StatusEnum),
    fc.constantFrom(...Object.values(StatusEnum)),
    (value) => ({ variant: statusNames[value], value: null }),
    "status Schema.Enum",
  ),
  spec(
    "status",
    Schema.Enum(NumericStatus),
    fc.constantFrom(NumericStatus.Pending, NumericStatus.Active, NumericStatus.Done),
    (value) => ({ variant: NumericStatus[value], value: null }),
    "status numeric Schema.Enum",
  ),
  spec(
    "sparse_status",
    sparseStatuses[0],
    fc.constantFrom("Pending" as const, "Done" as const),
    (value) => ({ variant: value, value: null }),
    "sparse_status Schema.Literals",
  ),
  spec(
    "sparse_status",
    sparseStatuses[1],
    fc.constantFrom(SparseStatus.Pending, SparseStatus.Done),
    (value) => ({ variant: SparseStatus[value], value: null }),
    "sparse_status Schema.Enum",
  ),
  spec(
    "shape",
    Shape,
    fc.oneof(
      fc.constant({ _tag: "Empty" } as const),
      fc.record({ _tag: fc.constant("Square" as const), value: fc.nat({ max: 0xffff_ffff }) }),
      fc.record({ _tag: fc.constant("Rect" as const), width: u16, height: u16 }),
    ),
    (value) => ({
      variant: value._tag,
      value:
        value._tag === "Empty"
          ? null
          : value._tag === "Square"
            ? String(value.value)
            : { width: String(value.width), height: String(value.height) },
    }),
  ),
  spec("option_u128", Schema.Option(Borsh.U128), option(u128), (value) =>
    optionTransport(value, String),
  ),
  spec(
    "option_option_u8",
    Schema.Option(Schema.Option(Borsh.U8)),
    option(option(fc.integer({ min: 0, max: 255 }))),
    (value) => optionTransport(value, (value) => optionTransport(value, String)),
  ),
  spec("option_unit", Schema.Option(Borsh.Unit), option(fc.constant([] as const)), (value) =>
    optionTransport(value, () => null),
  ),
  spec(
    "vec_option_unit",
    Schema.Array(Schema.Option(Borsh.Unit)),
    fc.array(option(fc.constant([] as const)), { maxLength: 48 }),
    (values) => values.map((value) => optionTransport(value, () => null)),
  ),
  spec(
    "storage_deposit",
    Schema.Struct({
      token_id: Schema.String,
      account_id: Schema.String,
      storage_deposit_amount: Schema.Option(Borsh.U128),
    }),
    fc.record({
      token_id: stringArbitrary,
      account_id: stringArbitrary,
      storage_deposit_amount: option(u128),
    }),
    (value) => ({
      ...value,
      storage_deposit_amount: optionTransport(value.storage_deposit_amount, String),
    }),
  ),
  spec(
    "transfer",
    Schema.Struct({ receiver: Schema.String, amount: Borsh.U128 }),
    fc.record({
      receiver: stringArbitrary,
      amount: fc.bigInt({ min: 0n, max: (1n << 128n) - 1n }),
    }),
    ({ receiver, amount }) => ({ receiver, amount: String(amount) }),
  ),
  spec(
    "tuple_u8_u128",
    Schema.Tuple([Borsh.U8, Borsh.U128]),
    fc.tuple(fc.integer({ min: 0, max: 255 }), fc.bigInt({ min: 0n, max: (1n << 128n) - 1n })),
    ([a, b]) => [String(a), String(b)],
  ),
  spec(
    "vec_u16",
    Schema.Array(Borsh.U16),
    fc.array(fc.integer({ min: 0, max: 65535 }), { maxLength: 48 }),
    (value) => value.map(String),
  ),
]

for (const entry of entries) {
  describe(`borsh-rs ${entry.name}`, () => {
    it("generated values agree, reject prefixes and consume the whole frame", async () => {
      await assertProperty(
        entry.arbitrary,
        async ({ raw, transport }) => {
          const encoded = await oracle.request(entry.id, "encode", { value: transport })
          assert.ok(encoded.ok)
          assert.equal(encoded.hex, hex(raw))
          assert.deepEqual(encoded.value, transport)
          const decoded = await oracle.request(entry.id, "decode", { hex: hex(raw) })
          assert.ok(decoded.ok)
          assert.deepEqual(decoded.value, transport)
          assert.deepEqual(entry.decode(bytes(encoded.hex)).transport, transport)
          for (const malformed of [raw.subarray(0, raw.length - 1), Uint8Array.of(...raw, 0)]) {
            assert.equal(attempt(() => entry.decode(malformed)).ok, false)
            assert.deepEqual(await oracle.request(entry.id, "decode", { hex: hex(malformed) }), {
              ok: false,
            })
          }
        },
        { numRuns: 300, seed: 20261020 },
      )
    })
    it("generated raw frames and mutated canonical frames agree with Rust", async () => {
      await assertProperty(
        fc.oneof(
          fc.uint8Array({ maxLength: 96 }),
          entry.arbitrary.map(({ raw }) => raw),
          fc
            .tuple(entry.arbitrary, fc.nat(), fc.integer({ min: 0, max: 255 }))
            .map(([{ raw }, position, value]) => {
              const changed = raw.slice()
              changed[position % changed.length] = value
              return changed
            }),
        ),
        async (raw) => {
          const ts = attempt(() => entry.decode(raw))
          const rust = await oracle.request(entry.id, "decode", { hex: hex(raw) })
          assert.equal(ts.ok, rust.ok)
          if (ts.ok && rust.ok) {
            assert.deepEqual(ts.value.transport, rust.value)
            assert.equal(hex(ts.value.raw), hex(raw))
          }
        },
        { numRuns: 300, seed: 20261020 },
      )
    })
  })
}

it("matches Rust zero-sized visitation and malicious vector counts", async () => {
  for (const [id, schema, values, raws] of [
    [
      "array_unit_0",
      Schema.Array(Borsh.Unit).pipe(Borsh.fixedArray(0)),
      [[]],
      [new Uint8Array(), Uint8Array.of(0)],
    ],
    [
      "array_unit_1",
      Schema.Array(Borsh.Unit).pipe(Borsh.fixedArray(1)),
      [[[]]],
      [new Uint8Array(), Uint8Array.of(0)],
    ],
    [
      "array_vec_unit_0",
      Schema.Array(Schema.Array(Borsh.Unit)).pipe(Borsh.fixedArray(0)),
      [[]],
      [new Uint8Array(), Uint8Array.of(0)],
    ],
    [
      "array_vec_unit_1",
      Schema.Array(Schema.Array(Borsh.Unit)).pipe(Borsh.fixedArray(1)),
      [[[]]],
      [new Uint8Array(), Uint8Array.of(0, 0, 0, 0)],
    ],
    ["empty", Schema.Struct({}), [{}], [new Uint8Array(), Uint8Array.of(0)]],
    ["tuple_unit", Schema.Tuple([Borsh.Unit]), [[[]]], [new Uint8Array(), Uint8Array.of(0)]],
    ["vec_unit", Schema.Array(Borsh.Unit), [[], [[]]], [Uint8Array.of(0, 0, 0, 0)]],
    [
      "only",
      Schema.Literals(["Only"]),
      ["Only"],
      [Uint8Array.of(0), Uint8Array.of(1), new Uint8Array()],
    ],
    [
      "vec_only",
      Schema.Array(Schema.TaggedUnion({ Only: {} })),
      [[], [{ _tag: "Only" }]],
      [Uint8Array.of(0, 0, 0, 0), Uint8Array.of(1, 0, 0, 0, 0)],
    ],
    ["vec_empty", Schema.Array(Schema.Struct({})), [[], [{}]], [Uint8Array.of(0, 0, 0, 0)]],
    [
      "vec_bytes0",
      Schema.Array(Borsh.fixedBytes(0)),
      [[], [new Uint8Array()]],
      [Uint8Array.of(0, 0, 0, 0)],
    ],
    [
      "vec_vec_unit",
      Schema.Array(Schema.Array(Borsh.Unit)),
      [[], [[]]],
      [Uint8Array.of(0, 0, 0, 0), Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0)],
    ],
    [
      "vec_u16",
      Schema.Array(Borsh.U16),
      [[]],
      [Uint8Array.of(255, 255, 255, 255), Uint8Array.of(2, 0, 0, 0, 1, 0)],
    ],
  ] as const) {
    const codec = Borsh.toCodec(schema)
    for (const value of values) {
      let transport: unknown = value
      if (id === "tuple_unit" || id === "array_unit_1") {
        transport = [null]
      }
      if (id === "only") {
        transport = { variant: "Only", value: null }
      }
      if (id === "vec_only" && Array.isArray(value)) {
        transport = value.map(() => ({ variant: "Only", value: null }))
      }
      if (id === "vec_unit" || id === "vec_bytes0") {
        assert.ok(Array.isArray(value))
        transport = value.map(() => (id === "vec_unit" ? null : ""))
      }
      const ts = attempt(() => Schema.encodeUnknownSync(codec)(value))
      const rust = await oracle.request(id, "encode", { value: transport })
      assert.equal(ts.ok, rust.ok)
      if (ts.ok && rust.ok) {
        assert.equal(hex(ts.value), rust.hex)
      }
    }
    for (const raw of raws) {
      const ts = attempt(() => Schema.decodeSync(codec)(raw))
      const rust = await oracle.request(id, "decode", { hex: hex(raw) })
      assert.equal(ts.ok, rust.ok)
    }
  }
})

it("checks every enum discriminant and Option flag against Rust", async () => {
  const enumCodec = Borsh.toCodec(ExplicitEnum)
  const statusCodecs = [
    Borsh.toCodec(Status),
    Borsh.toCodec(Schema.Enum(StatusEnum)),
    Borsh.toCodec(Schema.Enum(NumericStatus)),
  ]
  const sparseCodecs = sparseStatuses.map((schema) => Borsh.toCodec(schema))
  const shapeCodec = Borsh.toCodec(Shape)
  const optionCodec = Borsh.toCodec(Schema.Option(Borsh.U128))
  const resultCodec = Borsh.toCodec(Schema.Result(Borsh.U16, Schema.String))
  for (let tag = 0; tag < 256; tag++) {
    const enumRaw =
      tag === 17
        ? Uint8Array.of(tag, 1, 2)
        : tag === 250
          ? Uint8Array.of(tag, 1, 0, 0, 0, 120, 1)
          : Uint8Array.of(tag)
    const optionRaw = tag === 1 ? Uint8Array.of(tag, ...new Uint8Array(16)) : Uint8Array.of(tag)
    const shapeRaw =
      tag === 1
        ? Uint8Array.of(tag, 5, 0, 0, 0)
        : tag === 2
          ? Uint8Array.of(tag, 1, 2, 3, 4)
          : Uint8Array.of(tag)
    for (const [id, codec, raw] of [
      ["explicit_enum", enumCodec, enumRaw],
      ...statusCodecs.map((codec) => ["status", codec, Uint8Array.of(tag)] as const),
      ...sparseCodecs.map((codec) => ["sparse_status", codec, Uint8Array.of(tag)] as const),
      ["shape", shapeCodec, shapeRaw],
      ["option_u128", optionCodec, optionRaw],
      [
        "result_u16_string",
        resultCodec,
        tag === 0
          ? Uint8Array.of(0, 0, 0, 0, 0)
          : tag === 1
            ? Uint8Array.of(1, 1, 2)
            : Uint8Array.of(tag),
      ],
    ] as const) {
      const ts = attempt(() => Schema.decodeSync(codec)(raw))
      const rust = await oracle.request(id, "decode", { hex: hex(raw) })
      assert.equal(ts.ok, rust.ok, `${id} tag ${tag}`)
      if (rust.ok) {
        assert.equal(rust.hex, hex(raw))
      }
    }
  }
})

it("matches Rust Result inactive branch visitation", async () => {
  const codec = Borsh.toCodec(Schema.Result(Borsh.Unit, Schema.Array(Borsh.Unit)))
  for (const [value, transport] of [
    [Result.succeed([]), { tag: "Ok", value: null }],
    [Result.fail([]), { tag: "Err", value: [] }],
  ] as const) {
    const ts = attempt(() => Schema.encodeUnknownSync(codec)(value))
    const rust = await oracle.request("result_unit_vec_unit", "encode", { value: transport })
    assert.equal(ts.ok, rust.ok)
    if (ts.ok && rust.ok) {
      assert.equal(hex(ts.value), rust.hex)
    }
  }
  for (const raw of [Uint8Array.of(1), Uint8Array.of(0, 0, 0, 0, 0)]) {
    const ts = attempt(() => Schema.decodeSync(codec)(raw))
    const rust = await oracle.request("result_unit_vec_unit", "decode", { hex: hex(raw) })
    assert.equal(ts.ok, rust.ok)
  }
})
