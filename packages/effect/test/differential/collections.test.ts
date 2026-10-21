import assert from "node:assert/strict"
import { HashMap, HashSet, Schema } from "effect"
import fc from "fast-check"
import { afterAll, beforeAll, it } from "vite-plus/test"
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

function mutations(raw: Uint8Array, entries: readonly Uint8Array[], keyOffset = 4) {
  const first = entries[0]
  const second = entries[1]
  assert.ok(first !== undefined && second !== undefined)
  const frame = (parts: readonly Uint8Array[], count = parts.length) => {
    const output = new Uint8Array(4 + parts.reduce((sum, part) => sum + part.length, 0))
    new DataView(output.buffer).setUint32(0, count, true)
    let offset = 4
    for (const part of parts) {
      output.set(part, offset)
      offset += part.length
    }
    return output
  }
  const changed = raw.slice()
  changed[keyOffset] = (changed[keyOffset] ?? 0) ^ 0x80
  return [
    raw,
    frame([second, first, ...entries.slice(2)]),
    frame([first, first, ...entries.slice(2)]),
    frame(entries, entries.length + 1),
    frame(entries, entries.length - 1),
    changed,
  ]
}

function spec<A>(
  id: string,
  schema: Schema.Codec<A>,
  make: (entries: readonly [number, string][]) => A,
  entries: fc.Arbitrary<[number, string][]>,
) {
  const codec = Borsh.toCodec(schema)
  return {
    id,
    encode: (value: [number, string][]) => Schema.encodeSync(codec)(make(value)),
    decode: (raw: Uint8Array) => Schema.decodeSync(codec)(raw),
    arbitrary: entries,
  }
}
const mapEntries = fc.uniqueArray(fc.tuple(fc.integer({ min: 0, max: 65535 }), stringArbitrary), {
  selector: ([key]) => key,
  maxLength: 12,
})
for (const entry of [
  spec(
    "map_u16_string",
    Schema.ReadonlyMap(Borsh.U16, Schema.String),
    (entries) => new Map(entries),
    mapEntries,
  ),
  spec(
    "map_u16_string",
    Schema.HashMap(Borsh.U16, Schema.String),
    HashMap.fromIterable,
    mapEntries,
  ),
])
  it(`matches concrete Rust ${entry.id} for native maps`, async () => {
    for (const value of [
      [],
      [1, 255, 256, 257, 65535].reverse().map((key): [number, string] => [key, String(key)]),
    ])
      await check(value)
    await assertProperty(entry.arbitrary, check, { numRuns: 200, seed: 20261020 })
    const pairs = Borsh.toCodec(Schema.Array(Schema.Tuple([Borsh.U16, Schema.String])))
    const pair = Borsh.toCodec(Schema.Tuple([Borsh.U16, Schema.String]))
    await assertProperty(
      mapEntries.filter((entries) => entries.length >= 2),
      async (value) => {
        const raw = entry.encode(value)
        const parts = Schema.decodeSync(pairs)(raw).map((value) => Schema.encodeSync(pair)(value))
        for (const [index, mutated] of mutations(raw, parts).entries()) {
          const ts = attempt(() => entry.decode(mutated))
          const rust = await oracle.request(entry.id, "decode", { hex: hex(mutated) })
          assert.equal(ts.ok, rust.ok)
          if (index < 5) assert.equal(rust.ok, index === 0)
          if (ts.ok && rust.ok) {
            assert.deepEqual(
              Array.from(ts.value)
                .sort(([a], [b]) => a - b)
                .map(([key, value]) => [String(key), value]),
              rust.value,
            )
            assert.equal(hex(entry.encode(Array.from(ts.value))), hex(mutated))
          }
        }
      },
      { numRuns: 200, seed: 20261020 },
    )
    async function check(value: [number, string][]) {
      const transport = value.map(([key, value]) => [String(key), value])
      const rust = await oracle.request(entry.id, "encode", { value: transport })
      assert.ok(rust.ok)
      const raw = entry.encode(value)
      assert.equal(hex(raw), rust.hex)
      assert.equal(hex(entry.encode([...value].reverse())), rust.hex)
      const decoded = entry.decode(raw)
      assert.deepEqual(new Map(decoded), new Map(value))
      assert.deepEqual(await oracle.request(entry.id, "decode", { hex: hex(raw) }), rust)
      for (const malformed of [raw.subarray(0, raw.length - 1), Uint8Array.of(...raw, 0)]) {
        assert.equal(attempt(() => entry.decode(malformed)).ok, false)
        assert.deepEqual(await oracle.request(entry.id, "decode", { hex: hex(malformed) }), {
          ok: false,
        })
      }
    }
  })

function sets<A>(
  id: string,
  item: Schema.Codec<A>,
  arbitrary: fc.Arbitrary<A>,
  examples: A[],
  transport: (value: A) => unknown,
) {
  for (const [schema, make] of [
    [Schema.ReadonlySet(item), (values: A[]) => new Set(values)],
    [Schema.HashSet(item), (values: A[]) => HashSet.fromIterable(values)],
  ] as const)
    it(`matches concrete Rust ${id} for native sets`, async () => {
      const codec = Borsh.toCodec(schema)
      const encode = Schema.encodeUnknownSync(codec)
      const decode = Schema.decodeSync(codec)
      async function check(values: A[]) {
        const unique = [...new Set(values)]
        const rust = await oracle.request(id, "encode", { value: unique.map(transport) })
        assert.ok(rust.ok)
        const raw = encode(make(unique))
        assert.equal(hex(raw), rust.hex)
        assert.equal(hex(encode(make([...unique].reverse()))), rust.hex)
        assert.deepEqual(new Set(decode(raw)), new Set(unique))
        assert.deepEqual(await oracle.request(id, "decode", { hex: hex(raw) }), rust)
      }
      await check([])
      await check(examples)
      await assertProperty(fc.array(arbitrary, { maxLength: 12 }), check, {
        numRuns: 200,
        seed: 20261020,
      })
      const vector = Borsh.toCodec(Schema.Array(item))
      const itemCodec = Borsh.toCodec(item)
      await assertProperty(
        fc.uniqueArray(arbitrary, { minLength: 2, maxLength: id === "set_bool" ? 2 : 12 }),
        async (values) => {
          const raw = encode(make(values))
          const parts = Schema.decodeSync(vector)(raw).map((value) =>
            Schema.encodeSync(itemCodec)(value),
          )
          for (const [index, mutated] of mutations(
            raw,
            parts,
            id === "set_string" ? 8 + (parts[0]?.length ?? 0) : 4,
          ).entries()) {
            const ts = attempt(() => decode(mutated))
            const rust = await oracle.request(id, "decode", { hex: hex(mutated) })
            assert.equal(ts.ok, rust.ok)
            if (index < 5) assert.equal(rust.ok, index === 0)
            if (ts.ok && rust.ok) {
              assert.ok(Array.isArray(rust.value))
              assert.deepEqual(new Set(Array.from(ts.value, transport)), new Set(rust.value))
              assert.equal(hex(encode(ts.value)), hex(mutated))
            }
          }
        },
        { numRuns: 200, seed: 20261020 },
      )
    })
}
sets(
  "set_string",
  Schema.String,
  stringArbitrary,
  ["\u{10000}", "\ue000", "aa", "a", "", "\u{10001}"],
  (v) => v,
)
sets(
  "set_i16",
  Borsh.I16,
  fc.integer({ min: -32768, max: 32767 }),
  [-32768, -256, -1, 0, 1, 255, 256, 32767],
  String,
)
sets(
  "set_i128",
  Borsh.I128,
  fc.bigInt({ min: -(1n << 127n), max: (1n << 127n) - 1n }),
  [-(1n << 127n), -1n, 0n, 1n, (1n << 127n) - 1n],
  String,
)
sets(
  "set_u128",
  Borsh.U128,
  fc.bigInt({ min: 0n, max: (1n << 128n) - 1n }),
  [0n, 1n, 255n, 256n, (1n << 128n) - 1n],
  String,
)
sets("set_bool", Schema.Boolean, fc.boolean(), [true, false], (v) => v)

it("rejects strict duplicate/descending map and set frames and malformed lengths/flags like Rust", async () => {
  for (const [id, schemas, frames] of [
    [
      "map_u16_string",
      [Schema.ReadonlyMap(Borsh.U16, Schema.String), Schema.HashMap(Borsh.U16, Schema.String)],
      [
        "020000000001010000006201000100000061",
        "020000000100010000006101000100000062",
        "010000000100ffffffff",
        "ffffffff",
        "01000000010001000000ff",
      ],
    ],
    [
      "set_string",
      [Schema.ReadonlySet(Schema.String), Schema.HashSet(Schema.String)],
      [
        "0200000001000000620100000061",
        "0200000001000000610100000061",
        "ffffffff",
        "01000000ffffffff",
        "0100000001000000ff",
      ],
    ],
    [
      "set_bool",
      [Schema.ReadonlySet(Schema.Boolean), Schema.HashSet(Schema.Boolean)],
      ["020000000101", "020000000100", "0100000002"],
    ],
  ] as const)
    for (const raw of frames) {
      assert.deepEqual(
        await oracle.request(id, "decode", { hex: raw }),
        { ok: false },
        `${id}: ${raw}`,
      )
      for (const schema of schemas)
        assert.equal(
          attempt(() => Schema.decodeSync(Borsh.toCodec(schema))(bytes(raw))).ok,
          false,
          `${id}: ${raw}`,
        )
    }
})
