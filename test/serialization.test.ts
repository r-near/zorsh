import { describe, expect, test } from "vitest"
import { type Schema, b } from "../src/schema"

interface TestType<T> {
  schema: Schema<T>
  value: T
}

describe("primitive types", () => {
  test.each([
    { schema: b.u8(), value: 255 },
    { schema: b.u16(), value: 65535 },
    { schema: b.u32(), value: 4294967295 },
    { schema: b.u64(), value: BigInt("18446744073709551615") },
    {
      schema: b.u128(),
      value: BigInt("340282366920938463463374607431768211455"),
    },
    { schema: b.i8(), value: -128 },
    { schema: b.i16(), value: -32768 },
    { schema: b.i32(), value: -2147483648 },
    { schema: b.i64(), value: BigInt("-9223372036854775808") },
    {
      schema: b.i128(),
      value: BigInt("-170141183460469231731687303715884105728"),
    },
    { schema: b.f32(), value: 0.015625 },
    { schema: b.f64(), value: Math.PI },
  ])("numeric type $schema.type", ({ schema, value }: TestType<number | bigint>) => {
    const buffer = schema.serialize(value)
    expect(buffer).toMatchSnapshot()
    expect(schema.deserialize(buffer)).toEqual(value)
  })

  test.each([
    { schema: b.bool(), value: true },
    { schema: b.bool(), value: false },
  ])("bool", ({ schema, value }: TestType<boolean>) => {
    const buffer = schema.serialize(value)
    expect(buffer).toMatchSnapshot()
    expect(schema.deserialize(buffer)).toEqual(value)
  })

  test("string", () => {
    const schema = b.string()
    const value = "Hello, world! 👋"
    const buffer = schema.serialize(value)
    expect(buffer).toMatchSnapshot()
    expect(schema.deserialize(buffer)).toBe(value)
  })

  test("unit", () => {
    const schema = b.unit()
    const value = {}
    const buffer = schema.serialize(value)
    expect(buffer).toMatchSnapshot()
    expect(schema.deserialize(buffer)).toEqual(value)
  })
})

describe("complex types", () => {
  test("fixed array", () => {
    const schema = b.array(b.u16(), 3)
    const value = [1, 2, 3]
    const buffer = schema.serialize(value)
    expect(buffer).toMatchSnapshot()
    expect(schema.deserialize(buffer)).toEqual(value)

    // Should throw on wrong length
    expect(() => schema.serialize([1, 2])).toThrow()
  })

  test("dynamic vec", () => {
    const schema = b.vec(b.u8())
    const value = new Uint8Array([1, 2, 3, 4, 5])
    const buffer = schema.serialize(value)
    expect(buffer).toMatchSnapshot()
    expect(schema.deserialize(buffer)).toEqual(value)
  })

  test("option", () => {
    const schema = b.option(b.string())

    const someValue = "hello"
    const someBuffer = schema.serialize(someValue)
    expect(someBuffer).toMatchSnapshot("some value")
    expect(schema.deserialize(someBuffer)).toBe(someValue)

    const noneValue = null
    const noneBuffer = schema.serialize(noneValue)
    expect(noneBuffer).toMatchSnapshot("none value")
    expect(schema.deserialize(noneBuffer)).toBe(noneValue)
  })

  test("hashset", () => {
    const schema = b.hashSet(b.string())
    const value = new Set(["a", "b", "c"])
    const buffer = schema.serialize(value)
    expect(buffer).toMatchSnapshot()
    expect(schema.deserialize(buffer)).toEqual(value)
  })

  test("hashmap", () => {
    const schema = b.hashMap(b.string(), b.u32())
    const value = new Map([
      ["alice", 100],
      ["bob", 200],
    ])
    const buffer = schema.serialize(value)
    expect(buffer).toMatchSnapshot()
    expect(schema.deserialize(buffer)).toEqual(value)
  })

  test("struct", () => {
    const schema = b.struct({
      name: b.string(),
      age: b.u8(),
      scores: b.vec(b.u16()),
    })

    const value = {
      name: "alice",
      age: 25,
      scores: new Uint16Array([90, 95, 100]),
    }

    const buffer = schema.serialize(value)
    expect(buffer).toMatchSnapshot()
    expect(schema.deserialize(buffer)).toEqual(value)
  })

  test("enum", () => {
    // Simple enum
    const StatusSchema = b.enum({
      Pending: b.unit(),
      Fulfilled: b.unit(),
      Rejected: b.unit(),
    })

    const statusValue = { Pending: {} }
    const statusBuffer = StatusSchema.serialize(statusValue)
    expect(statusBuffer).toMatchSnapshot("simple enum")
    expect(StatusSchema.deserialize(statusBuffer)).toEqual(statusValue)

    // Complex enum
    const ResultSchema = b.enum({
      Ok: b.string(),
      Err: b.struct({
        code: b.u16(),
        message: b.string(),
      }),
    })

    const okValue = { Ok: "success" }
    const okBuffer = ResultSchema.serialize(okValue)
    expect(okBuffer).toMatchSnapshot("enum with data - ok")
    expect(ResultSchema.deserialize(okBuffer)).toEqual(okValue)

    const errValue = { Err: { code: 404, message: "Not found" } }
    const errBuffer = ResultSchema.serialize(errValue)
    expect(errBuffer).toMatchSnapshot("enum with data - err")
    expect(ResultSchema.deserialize(errBuffer)).toEqual(errValue)
  })
})

describe("complex nested structures", () => {
  test("game state example", () => {
    const PlayerSchema = b.struct({
      name: b.string(),
      health: b.u8(),
      inventory: b.hashMap(b.string(), b.u16()),
      achievements: b.hashSet(b.string()),
      guild: b.option(b.string()),
      recentScores: b.vec(b.u16()),
    })

    const GameStateSchema = b.struct({
      players: b.hashMap(b.string(), PlayerSchema),
      currentRound: b.u32(),
      nextRoundStart: b.option(b.u32()),
    })

    const value = {
      players: new Map([
        [
          "player1",
          {
            name: "Alice",
            health: 100,
            inventory: new Map([
              ["sword", 1],
              ["potion", 5],
            ]),
            achievements: new Set(["first_kill", "speedrun"]),
            guild: "Warriors",
            recentScores: new Uint16Array([100, 95, 98]),
          },
        ],
      ]),
      currentRound: 5,
      nextRoundStart: 1234567890,
    }

    const buffer = GameStateSchema.serialize(value)
    expect(buffer).toMatchSnapshot()
    expect(GameStateSchema.deserialize(buffer)).toEqual(value)
  })
})

describe("type inference", () => {
  test("type inference matches runtime values", () => {
    const UserSchema = b.struct({
      name: b.string(),
      age: b.u8(),
      scores: b.vec(b.u16()),
      metadata: b.option(
        b.struct({
          joinDate: b.u64(),
          rank: b.string(),
        }),
      ),
    })

    type User = b.infer<typeof UserSchema>

    // This is a type-level test - if it compiles, it passes
    const user: User = {
      name: "Alice",
      age: 25,
      scores: new Uint16Array([100, 95, 98]),
      metadata: {
        joinDate: BigInt(Date.now()),
        rank: "Gold",
      },
    }

    // These should fail type checking:
    // @ts-expect-error - wrong age type
    // biome-ignore lint/correctness/noUnusedVariables: This is a test
    const user1: User = { ...user, age: "25" }

    // @ts-expect-error - missing field
    // biome-ignore lint/correctness/noUnusedVariables: This is a test
    const user2: User = { name: "Bob", age: 30 }

    // @ts-expect-error - wrong metadata structure
    // biome-ignore lint/correctness/noUnusedVariables: This is a test
    const user3: User = { ...user, metadata: { rank: "Silver" } }

    // Runtime test
    const buffer = UserSchema.serialize(user)
    const decoded = UserSchema.deserialize(buffer)
    expect(decoded).toEqual(user)
  })
})
