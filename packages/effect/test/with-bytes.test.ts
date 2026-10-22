import {
  Arbitrary,
  Context,
  Effect,
  Option,
  Result,
  Schema,
  SchemaAST,
  SchemaIssue,
  SchemaRepresentation,
  SchemaTransformation,
} from "effect"
import { describe, expect, it } from "vite-plus/test"
import { Borsh } from "../src/index.js"
import { compile } from "../src/internal/compiler.js"
import { Writer } from "../src/internal/io.js"
import { noLimits } from "../src/internal/limits.js"

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

function encoder(schema: Schema.Top, options?: Borsh.Options) {
  return Schema.encodeUnknownSync(Borsh.toCodec(schema as Schema.Codec<unknown, unknown>, options))
}

function decoder<S extends Schema.Codec<unknown, unknown>>(schema: S, options?: Borsh.Options) {
  return Schema.decodeSync(Borsh.toCodec(schema, options))
}

const Transaction = Schema.Struct({
  signerId: Schema.String,
  nonce: Borsh.U64,
  actions: Schema.Array(Schema.TaggedUnion({ Noop: {}, Transfer: { deposit: Borsh.U128 } })),
})
const transaction: typeof Transaction.Type = {
  signerId: "alice.near",
  nonce: 7n,
  actions: [{ _tag: "Transfer", deposit: 10n }, { _tag: "Noop" }],
}
const SignedTransaction = Schema.Struct({
  transaction: Borsh.withBytes(Transaction),
  signature: Borsh.fixedBytes(4),
})
const transactionBytes = encoder(Transaction)(transaction)
const signedBytes = Uint8Array.of(...transactionBytes, 9, 8, 7, 6)

/** A lossy u8: every nonzero byte decodes to true, which encodes back to 1. */
const LossyFlag = Borsh.U8.pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transform({ decode: (n) => n !== 0, encode: (flag) => (flag ? 1 : 0) }),
  ),
)

describe("decoding", () => {
  it("keeps the exact bytes of a nested struct next to its value", () => {
    const signed = decoder(SignedTransaction)(signedBytes)
    expect(signed.transaction.value).toEqual(transaction)
    expect(signed.transaction.bytes).toEqual(transactionBytes)
    expect(signed.signature).toEqual(Uint8Array.of(9, 8, 7, 6))
  })

  it("copies the span, so reusing the input buffer leaves bytes unchanged", () => {
    const input = Uint8Array.from(signedBytes)
    const signed = decoder(SignedTransaction)(input)
    input.fill(0)
    expect(signed.transaction.bytes).toEqual(transactionBytes)
    expect(signed.transaction.bytes.buffer).not.toBe(input.buffer)
    expect(signed.transaction.bytes.byteOffset).toBe(0)
    expect(signed.transaction.bytes.buffer.byteLength).toBe(transactionBytes.byteLength)
  })

  it("copies a span from a Buffer subarray as a plain Uint8Array", () => {
    const backing = Buffer.from([0xff, 0xff, ...signedBytes, 0xff])
    const input = backing.subarray(2, 2 + signedBytes.byteLength)
    const signed = decoder(SignedTransaction)(input)
    backing.fill(0)
    expect(signed.transaction.bytes).toEqual(transactionBytes)
    expect(Buffer.isBuffer(signed.transaction.bytes)).toBe(false)
  })

  it("gives each position its own span", () => {
    const Item = Borsh.withBytes(Schema.Struct({ id: Borsh.U8, name: Schema.String }))
    const Message = Schema.Struct({
      version: Borsh.U8,
      items: Schema.Array(Item),
      pair: Schema.Tuple([Item, Item]),
      fixed: Schema.Array(Borsh.withBytes(Borsh.U16)).pipe(Borsh.fixedArray(2)),
      byName: Schema.ReadonlyMap(Schema.String, Borsh.withBytes(Borsh.U32)),
    })
    const plain = encoder(Schema.Struct({ id: Borsh.U8, name: Schema.String }))
    const a = plain({ id: 1, name: "a" })
    const bc = plain({ id: 2, name: "bc" })
    const input = Uint8Array.of(
      3,
      2,
      0,
      0,
      0,
      ...a,
      ...bc,
      ...bc,
      ...a,
      1,
      2,
      3,
      4,
      1,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0x6b,
      5,
      0,
      0,
      0,
    )
    const message = decoder(Message)(input)
    expect(message.items.map((item) => item.bytes)).toEqual([a, bc])
    expect(message.pair.map((item) => item.value.name)).toEqual(["bc", "a"])
    expect(message.pair.map((item) => item.bytes)).toEqual([bc, a])
    expect(message.fixed).toEqual([
      { value: 0x0201, bytes: Uint8Array.of(1, 2) },
      { value: 0x0403, bytes: Uint8Array.of(3, 4) },
    ])
    expect(message.byName.get("k")).toEqual({ value: 5, bytes: Uint8Array.of(5, 0, 0, 0) })
    expect(encoder(Message)(message)).toEqual(input)
  })

  it("leaves out an Option tag around it and includes one inside it", () => {
    const outside = decoder(Schema.Option(Borsh.withBytes(Borsh.U16)))(Uint8Array.of(1, 2, 0))
    expect(outside).toEqual(Option.some({ value: 2, bytes: Uint8Array.of(2, 0) }))
    const inside = decoder(Borsh.withBytes(Schema.Option(Borsh.U16)))(Uint8Array.of(1, 2, 0))
    expect(inside).toEqual({ value: Option.some(2), bytes: Uint8Array.of(1, 2, 0) })
    const none = decoder(Borsh.withBytes(Schema.Option(Borsh.U16)))(Uint8Array.of(0))
    expect(none).toEqual({ value: Option.none(), bytes: Uint8Array.of(0) })
  })

  it("includes an enum discriminant around it and leaves it out inside a variant", () => {
    const Shape = Schema.TaggedUnion({
      Empty: {},
      Square: { side: Borsh.withBytes(Borsh.U32) },
    }).pipe(Borsh.discriminants({ Empty: 4, Square: 9 }))
    expect(decoder(Shape)(Uint8Array.of(9, 3, 0, 0, 0))).toEqual({
      _tag: "Square",
      side: { value: 3, bytes: Uint8Array.of(3, 0, 0, 0) },
    })
    expect(decoder(Borsh.withBytes(Shape))(Uint8Array.of(9, 3, 0, 0, 0))).toEqual({
      value: { _tag: "Square", side: { value: 3, bytes: Uint8Array.of(3, 0, 0, 0) } },
      bytes: Uint8Array.of(9, 3, 0, 0, 0),
    })
    const Outcome = Schema.Result(Borsh.withBytes(Borsh.U8), Borsh.withBytes(Schema.String))
    expect(decoder(Outcome)(Uint8Array.of(0, 1, 0, 0, 0, 0x78))).toEqual(
      Result.fail({ value: "x", bytes: Uint8Array.of(1, 0, 0, 0, 0x78) }),
    )
  })

  it("nests inside itself, each level keeping its own span", () => {
    const Nested = Borsh.withBytes(Schema.Tuple([Borsh.U8, Borsh.withBytes(Borsh.U8)]))
    expect(decoder(Nested)(Uint8Array.of(1, 2))).toEqual({
      value: [1, { value: 2, bytes: Uint8Array.of(2) }],
      bytes: Uint8Array.of(1, 2),
    })
  })

  it("keeps an empty copy for zero-sized values and stays zero-sized itself", () => {
    const Empty = Schema.Struct({ a: Borsh.U8, unit: Borsh.withBytes(Borsh.Unit), b: Borsh.U8 })
    const empty = decoder(Empty)(Uint8Array.of(1, 2))
    expect(empty.unit).toEqual({ value: [], bytes: new Uint8Array(0) })
    const other = decoder(Empty)(Uint8Array.of(1, 2))
    expect(other.unit.bytes).not.toBe(empty.unit.bytes)
    expect(encoder(Empty)(empty)).toEqual(Uint8Array.of(1, 2))
    expect(decoder(Borsh.withBytes(Borsh.Unit))(new Uint8Array(0)).bytes).toEqual(new Uint8Array(0))
    const units = Schema.Array(Borsh.withBytes(Borsh.Unit))
    expect(failure(() => decoder(units)(Uint8Array.of(0, 0, 0, 0))).message).toBe(
      "Borsh forbids vectors of zero-sized values at byte 0",
    )
  })

  it("reports binary failures inside it under value", () => {
    const Flags = Schema.Struct({ inner: Borsh.withBytes(Schema.Struct({ flag: Schema.Boolean })) })
    expect(failure(() => decoder(Flags)(Uint8Array.of(2))).message).toBe(
      'Invalid bool tag 2 at byte 0\n  at ["inner"]["value"]["flag"]',
    )
    expect(failure(() => decoder(Flags)(new Uint8Array(0))).message).toBe(
      'Truncated input: need 1 bytes at byte 0\n  at ["inner"]["value"]["flag"]',
    )
  })

  it("runs the schema's checks and transformations on value", () => {
    const Wrapped = Borsh.withBytes(LossyFlag)
    expect(decoder(Wrapped)(Uint8Array.of(5))).toEqual({ value: true, bytes: Uint8Array.of(5) })
    const Even = Borsh.withBytes(
      Borsh.U8.check(Schema.makeFilter((n) => n % 2 === 0, { expected: "an even number" })),
    )
    expect(failure(() => decoder(Even)(Uint8Array.of(3))).message).toBe(
      'Expected an even number\n  at ["value"]',
    )
  })

  it("enforces early length checks and maxItems inside it", () => {
    const check = Schema.isMaxLength(1)
    const Short = Borsh.withBytes(Schema.Array(Borsh.U8).check(check))
    const error = failure(() => decoder(Short)(Uint8Array.of(2, 0, 0, 0, 1, 2)))
    expect(error.message).toBe(
      'Expected a value with a length of at most 1, got 2 items at byte 0\n  at ["value"]',
    )
    expect(filters(error.issue).map((issue) => issue.filter)).toEqual([check])
    const Items = Borsh.withBytes(Schema.Array(Borsh.U8))
    const input = Uint8Array.of(2, 0, 0, 0, 1, 2)
    expect(decoder(Items, { maxItems: 2 })(input).bytes).toEqual(input)
    expect(failure(() => decoder(Items, { maxItems: 1 })(input)).message).toBe(
      'Input exceeds maxItems (1) at byte 0\n  at ["value"]',
    )
  })

  it("cannot be a map key or set member, which needs a Rust ordering", () => {
    expect(() => Borsh.toCodec(Schema.ReadonlySet(Borsh.withBytes(Borsh.U8)))).toThrow(
      "$: ReadonlySet keys require Boolean, integer or String Rust ordering",
    )
  })

  it("rejects a hand-built declaration with the wrong arity", () => {
    const wrapped = Borsh.withBytes(Borsh.U8)
    const declaration = wrapped.ast
    const forged = Schema.make<Schema.Top>(
      new SchemaAST.Declaration([], declaration.run, declaration.annotations),
    )
    expect(() => Borsh.toCodec(forged)).toThrow(
      "$: withBytes requires exactly 1 encoded type parameter",
    )
  })
})

describe("encoding", () => {
  it("writes the value of a decoded message back to the same bytes", () => {
    const signed = decoder(SignedTransaction)(signedBytes)
    expect(encoder(SignedTransaction)(signed)).toEqual(signedBytes)
  })

  it("writes value, not bytes, and fails at the first byte that differs", () => {
    const signed = decoder(SignedTransaction)(signedBytes)
    const changed = {
      ...signed,
      transaction: { ...signed.transaction, value: { ...transaction, nonce: 8n } },
    }
    // The nonce starts after the u32 length and 10 bytes of the signer id.
    expect(failure(() => encoder(SignedTransaction)(changed)).message).toBe(
      'Bytes do not match the encoded value at byte 14\n  at ["transaction"]["bytes"]',
    )
  })

  it("reports where the shorter side ends when the lengths differ", () => {
    const Field = Schema.Struct({ head: Borsh.U8, value: Borsh.withBytes(Borsh.U16) })
    const encode = encoder(Field)
    expect(
      failure(() => encode({ head: 1, value: { value: 2, bytes: Uint8Array.of(2) } })).message,
    ).toBe('Bytes do not match the encoded value at byte 2\n  at ["value"]["bytes"]')
    expect(
      failure(() => encode({ head: 1, value: { value: 2, bytes: Uint8Array.of(2, 0, 0) } }))
        .message,
    ).toBe('Bytes do not match the encoded value at byte 3\n  at ["value"]["bytes"]')
    expect(encode({ head: 1, value: { value: 2, bytes: Uint8Array.of(2, 0) } })).toEqual(
      Uint8Array.of(1, 2, 0),
    )
  })

  it("compares against the output even after the buffer grows", () => {
    const Large = Borsh.withBytes(Borsh.Bytes)
    const value = Uint8Array.from({ length: 1000 }, (_, i) => i & 255)
    const bytes = encoder(Borsh.Bytes)(value)
    expect(encoder(Large)({ value, bytes })).toEqual(bytes)
  })

  it("fails a lossy transformation that cannot reproduce the bytes it read", () => {
    const Wrapped = Borsh.withBytes(LossyFlag)
    const flag = decoder(Wrapped)(Uint8Array.of(5))
    expect(failure(() => encoder(Wrapped)(flag)).message).toBe(
      'Bytes do not match the encoded value at byte 0\n  at ["bytes"]',
    )
    expect(encoder(Wrapped)(decoder(Wrapped)(Uint8Array.of(1)))).toEqual(Uint8Array.of(1))
  })

  it("builds new values with the plain schema, which writes the same bytes", () => {
    const bytes = encoder(Transaction)(transaction)
    expect(encoder(Borsh.withBytes(Transaction))({ value: transaction, bytes })).toEqual(bytes)
  })

  it("reports failures inside value under value", () => {
    const encode = encoder(Borsh.withBytes(Borsh.U32), { maxBytes: 2 })
    expect(failure(() => encode({ value: 1, bytes: Uint8Array.of(1, 0, 0, 0) })).message).toBe(
      'Output exceeds maxBytes (2) at byte 0\n  at ["value"]',
    )
  })

  it("rejects other shapes in the schema pass and in the binary layer", () => {
    const encode = encoder(Borsh.withBytes(Borsh.U8))
    for (const input of [
      null,
      1,
      { value: 1 },
      { value: 1, bytes: [1] },
      { bytes: new Uint8Array(1) },
      // An inherited field is not the value's own, as for any struct field.
      Object.assign(Object.create({ bytes: new Uint8Array(1) }), { value: 1 }),
    ]) {
      expect(failure(() => encode(input)).message).toBe("Expected a value with its Borsh bytes")
    }
    // The schema pass rejects these first, so only a layout used on its own sees them.
    const layout = compile(Schema.toEncoded(Borsh.withBytes(Borsh.U8)).ast, noLimits)
    expect(() => layout.write(new Writer(16), { bytes: new Uint8Array(0) })).toThrow(
      "Expected value with bytes at byte 0",
    )
  })
})

describe("schema", () => {
  const Inner = Schema.Struct({ flag: LossyFlag, count: Borsh.U16 })
  const Wrapped = Borsh.withBytes(Inner)

  it("exposes its schema, also after annotations and checks", () => {
    expect(Wrapped.schema).toBe(Inner)
    expect(Wrapped.annotate({ title: "Signed" }).schema).toBe(Inner)
  })

  it("decodes value with the schema and passes bytes through in the schema pass", () => {
    const bytes = Uint8Array.of(9)
    const decoded = Schema.decodeSync(Wrapped)({ value: { flag: 3, count: 1 }, bytes })
    expect(decoded).toEqual({ value: { flag: true, count: 1 }, bytes })
    expect(decoded.bytes).toBe(bytes)
    expect(Schema.encodeSync(Wrapped)(decoded)).toEqual({ value: { flag: 1, count: 1 }, bytes })
    expect(
      failure(() => Schema.decodeSync(Wrapped)({ value: { flag: 1, count: -1 }, bytes })).message,
    ).toBe('Expected a value between 0 and 65535\n  at ["value"]["count"]')
    expect(Schema.is(Wrapped)({ value: { flag: true, count: 1 }, bytes })).toBe(true)
    expect(Schema.is(Wrapped)({ value: { flag: true, count: 1 }, bytes: "AQ==" })).toBe(false)
  })

  it("compares value and bytes for equivalence", () => {
    const equivalent = Schema.toEquivalence(Wrapped)
    const value = { flag: true, count: 1 }
    const self = { value, bytes: Uint8Array.of(1, 1, 0) }
    expect(equivalent(self, { value: { ...value }, bytes: Uint8Array.of(1, 1, 0) })).toBe(true)
    expect(equivalent(self, { value, bytes: Uint8Array.of(1, 1, 1) })).toBe(false)
    expect(equivalent(self, { value, bytes: Uint8Array.of(1, 1) })).toBe(false)
    expect(equivalent(self, { value: { ...value, count: 2 }, bytes: self.bytes })).toBe(false)
  })

  it("derives its Iso from the schema's own", () => {
    const iso = Schema.toCodecIso(Borsh.withBytes(Schema.Option(Borsh.U8)))
    const bytes = Uint8Array.of(1, 1)
    expect(Schema.encodeSync(iso)({ value: Option.some(1), bytes })).toEqual({
      value: { _tag: "Some", value: 1 },
      bytes,
    })
  })

  it("formats value with the schema's formatter, then bytes", () => {
    const format = Schema.toFormatter(Borsh.withBytes(Schema.Option(Borsh.U8)))
    expect(format({ value: Option.some(1), bytes: Uint8Array.of(1, 1) })).toBe(
      '{ "value": some(1), "bytes": Uint8Array([1,1]) }',
    )
  })

  it("derives JSON Schema and a JSON codec as a struct with base64 bytes", () => {
    expect(Schema.toJsonSchemaDocument(Wrapped).schema).toEqual({
      type: "object",
      properties: {
        value: {
          type: "object",
          properties: {
            flag: { type: "integer", minimum: 0, maximum: 255 },
            count: { type: "integer", minimum: 0, maximum: 65535 },
          },
          required: ["flag", "count"],
          additionalProperties: true,
        },
        bytes: { type: "string", format: "byte", contentEncoding: "base64" },
      },
      required: ["value", "bytes"],
      additionalProperties: true,
    })
    const json = Schema.toCodecJson(Wrapped)
    const value = { value: { flag: true, count: 513 }, bytes: Uint8Array.of(1, 1, 2) }
    expect(Schema.encodeSync(json)(value)).toEqual({
      value: { flag: 1, count: 513 },
      bytes: "AQEC",
    })
    expect(Schema.decodeSync(json)(Schema.encodeSync(json)(value))).toEqual(value)
  })

  it("generates code that rebuilds it", () => {
    const document = SchemaRepresentation.toCodeDocument(
      SchemaRepresentation.toMultiDocument(Schema.toRepresentation(Borsh.withBytes(Schema.String))),
    )
    const [code] = document.codes
    expect(code?.runtime).toMatch(/^Borsh\.withBytes\(Schema\.String\)/)
    expect(code?.Type).toBe("{ readonly value: string; readonly bytes: Uint8Array }")
    expect(document.artifacts).toContainEqual({
      _tag: "Import",
      importDeclaration: 'import { Borsh } from "@zorsh/effect"',
    })
  })
})

describe("Arbitrary", () => {
  function sample<S extends Schema.Codec<unknown, unknown>>(schema: S, count = 50) {
    return Effect.runSync(Arbitrary.sampleEffect(Arbitrary.schema(schema), { count, seed: 42 }))
  }

  it("samples values with the bytes they encode to, which round-trip", () => {
    const Message = Schema.Struct({
      tx: Borsh.withBytes(Transaction),
      flags: Schema.Array(Borsh.withBytes(Schema.Struct({ flag: LossyFlag, count: Borsh.U16 }))),
    })
    const encodeTransaction = encoder(Transaction)
    const codec = Borsh.toCodec(Message)
    for (const message of sample(Message)) {
      expect(message.tx.bytes).toEqual(encodeTransaction(message.tx.value))
      const bytes = Schema.encodeSync(codec)(message)
      expect(Schema.decodeSync(codec)(bytes)).toEqual(message)
    }
  })

  /** A u8 sent as its decimal string, so its type and wire layouts write different bytes. */
  const Digits = Schema.String.pipe(
    Schema.decodeTo(Borsh.U8, SchemaTransformation.transform({ decode: Number, encode: String })),
  )

  it("encodes samples with the schema itself, not its type side", () => {
    const encode = encoder(Digits)
    const codec = Borsh.toCodec(Borsh.withBytes(Digits))
    for (const sampled of sample(Borsh.withBytes(Digits))) {
      expect(sampled.bytes).toEqual(encode(sampled.value))
      expect(sampled.bytes).toHaveLength(4 + String(sampled.value).length)
      expect(Schema.decodeSync(codec)(Schema.encodeSync(codec)(sampled))).toEqual(sampled)
    }
  })

  it("still describes the schema itself when sampled through toType, toEncoded or flip", () => {
    // The hook sees only a type side, so these cannot be told apart from the original.
    const typeSide = Schema.toType(Borsh.withBytes(Digits))
    const [sampled] = sample(typeSide, 1)
    expect(failure(() => Schema.encodeSync(Borsh.toCodec(typeSide))(sampled!)).message).toBe(
      'Bytes do not match the encoded value at byte 0\n  at ["bytes"]',
    )
    // A transformation between equal wire schemas makes even the parameter identical.
    const Reversed = Borsh.U8.pipe(
      Schema.decodeTo(
        Borsh.U8,
        SchemaTransformation.transform({ decode: (n) => 255 - n, encode: (n) => 255 - n }),
      ),
    )
    const encodedSide = Schema.toEncoded(Borsh.withBytes(Reversed))
    const reversed = sample(encodedSide).find(({ value }) => value !== 127)
    expect(failure(() => Schema.encodeSync(Borsh.toCodec(encodedSide))(reversed!)).message).toBe(
      'Bytes do not match the encoded value at byte 0\n  at ["bytes"]',
    )
    // Without a transformation every side is the same schema, so its samples encode.
    const plainSide = Schema.toEncoded(Borsh.withBytes(Transaction))
    const codec = Borsh.toCodec(plainSide)
    for (const sampled of sample(plainSide, 10)) {
      expect(Schema.encodeSync(codec)(sampled)).toEqual(sampled.bytes)
    }
  })

  it("discards samples that cannot be encoded and dies on missing services", async () => {
    const Byte = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))
    // Every Byte is a valid decoded value, but only even ones pass the encoded side's check.
    const Even = Borsh.U8.check(
      Schema.makeFilter((n) => n % 2 === 0, { expected: "an even byte" }),
    ).pipe(Schema.decodeTo(Byte))
    const evens = sample(Borsh.withBytes(Even))
    expect(evens).toHaveLength(50)
    expect(evens.every(({ value, bytes }) => value % 2 === 0 && bytes[0] === value)).toBe(true)

    const Delayed = Borsh.U8.pipe(
      Schema.decodeTo(
        Byte,
        SchemaTransformation.transformEffect({
          decode: Effect.succeed,
          encode: (n) => Effect.as(Effect.yieldNow, n),
        }),
      ),
    )
    const delayed = await Effect.runPromise(
      Arbitrary.sampleEffect(Arbitrary.schema(Borsh.withBytes(Delayed)), { count: 5, seed: 42 }),
    )
    expect(delayed.every(({ value, bytes }) => bytes[0] === value)).toBe(true)

    class Prefix extends Context.Service<Prefix, { readonly offset: number }>()("Prefix") {}
    const NeedsService = Borsh.U8.pipe(
      Schema.decodeTo(
        Byte,
        SchemaTransformation.transformEffect({
          decode: Effect.succeed,
          encode: (n) => Effect.map(Prefix, ({ offset }) => n - offset),
        }),
      ),
    )
    const unsampleable = Borsh.withBytes(NeedsService) as Schema.Top as Schema.Codec<unknown>
    expect(() => sample(unsampleable)).toThrow("Prefix")
  })
})
