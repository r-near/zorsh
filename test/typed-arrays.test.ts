import { describe, expect, test } from "vitest"
import { b } from "../src/schema"

describe("Vec returns plain arrays", () => {
  test("u8 vec returns number[]", () => {
    const schema = b.vec(b.u8())
    const value = [1, 2, 3, 4, 5]

    // Type checking
    type Expected = number[]
    type Actual = b.infer<typeof schema>
    // biome-ignore lint/correctness/noUnusedVariables: This is a test
    const typecheck: Expected = {} as Actual // Should compile

    // Runtime test
    const buffer = schema.serialize(value)
    const decoded = schema.deserialize(buffer)
    expect(Array.isArray(decoded)).toBe(true)
    expect(decoded).toEqual(value)
  })

  test("u16 vec returns number[]", () => {
    const schema = b.vec(b.u16())
    const value = [1, 2, 3, 4, 5]

    // Type checking
    type Expected = number[]
    type Actual = b.infer<typeof schema>
    // biome-ignore lint/correctness/noUnusedVariables: This is a test
    const typecheck: Expected = {} as Actual // Should compile

    const buffer = schema.serialize(value)
    const decoded = schema.deserialize(buffer)
    expect(Array.isArray(decoded)).toBe(true)
    expect(decoded).toEqual(value)
  })

  test("i64 vec returns bigint[]", () => {
    const schema = b.vec(b.i64())
    const value = [1n, 2n, 3n]

    // Type checking
    type Expected = bigint[]
    type Actual = b.infer<typeof schema>
    // biome-ignore lint/correctness/noUnusedVariables: This is a test
    const typecheck: Expected = {} as Actual // Should compile

    const buffer = schema.serialize(value)
    const decoded = schema.deserialize(buffer)
    expect(Array.isArray(decoded)).toBe(true)
    expect(decoded).toEqual(value)
  })

  test("string vec returns regular array", () => {
    const schema = b.vec(b.string())
    const value = ["hello", "world"]

    // Type checking
    type Expected = string[]
    type Actual = b.infer<typeof schema>
    // biome-ignore lint/correctness/noUnusedVariables: This is a test
    const typecheck: Expected = {} as Actual // Should compile

    const buffer = schema.serialize(value)
    const decoded = schema.deserialize(buffer)
    expect(Array.isArray(decoded)).toBe(true)
    expect(decoded).toEqual(value)
  })

  test("plain arrays in complex structures", () => {
    const PlayerSchema = b.struct({
      name: b.string(),
      position: b.vec(b.f32()), // Should be number[]
      inventory: b.vec(b.u8()), // Should be number[]
      scores: b.vec(b.u16()), // Should be number[]
    })

    const value = {
      name: "Alice",
      position: [1.1, 2.2, 3.3].map((v) => new Float32Array([v])[0]),
      inventory: [1, 2, 3],
      scores: [100, 200, 300],
    }

    // Type checking
    type Player = b.infer<typeof PlayerSchema>
    type Expected = {
      name: string
      position: number[]
      inventory: number[]
      scores: number[]
    }
    // biome-ignore lint/correctness/noUnusedVariables: This is a test
    const typecheck: Expected = {} as Player // Should compile

    const buffer = PlayerSchema.serialize(value)
    const decoded = PlayerSchema.deserialize(buffer)

    expect(Array.isArray(decoded.position)).toBe(true)
    expect(Array.isArray(decoded.inventory)).toBe(true)
    expect(Array.isArray(decoded.scores)).toBe(true)
    expect(decoded).toEqual(value)
  })
})
