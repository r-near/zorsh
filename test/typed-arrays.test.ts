import { describe, expect, test } from "vitest"
import { b } from "../src/schema"

describe("Vec with TypedArrays", () => {
  test("u8 vec returns Uint8Array", () => {
    const schema = b.vec(b.u8())
    const value = new Uint8Array([1, 2, 3, 4, 5])

    // Type checking
    type Expected = Uint8Array
    type Actual = b.infer<typeof schema>
    // biome-ignore lint/correctness/noUnusedVariables: This is a test
    const typecheck: Expected = {} as Actual // Should compile

    // Runtime test
    const buffer = schema.serialize(value)
    const decoded = schema.deserialize(buffer)
    expect(decoded).toBeInstanceOf(Uint8Array)
    expect(decoded).toEqual(value)
  })

  test("u16 vec returns Uint16Array", () => {
    const schema = b.vec(b.u16())
    const value = new Uint16Array([1, 2, 3, 4, 5])

    // Type checking
    type Expected = Uint16Array
    type Actual = b.infer<typeof schema>
    // biome-ignore lint/correctness/noUnusedVariables: This is a test
    const typecheck: Expected = {} as Actual // Should compile

    const buffer = schema.serialize(value)
    const decoded = schema.deserialize(buffer)
    expect(decoded).toBeInstanceOf(Uint16Array)
    expect(decoded).toEqual(value)
  })

  test("i64 vec returns BigInt64Array", () => {
    const schema = b.vec(b.i64())
    const value = new BigInt64Array([1n, 2n, 3n])

    // Type checking
    type Expected = BigInt64Array
    type Actual = b.infer<typeof schema>
    // biome-ignore lint/correctness/noUnusedVariables: This is a test
    const typecheck: Expected = {} as Actual // Should compile

    const buffer = schema.serialize(value)
    const decoded = schema.deserialize(buffer)
    expect(decoded).toBeInstanceOf(BigInt64Array)
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

  test("TypedArrays in complex structures", () => {
    const PlayerSchema = b.struct({
      name: b.string(),
      position: b.vec(b.f32()), // Should be Float32Array
      inventory: b.vec(b.u8()), // Should be Uint8Array
      scores: b.vec(b.u16()), // Should be Uint16Array
    })

    const value = {
      name: "Alice",
      position: new Float32Array([1.1, 2.2, 3.3]),
      inventory: new Uint8Array([1, 2, 3]),
      scores: new Uint16Array([100, 200, 300]),
    }

    // Type checking
    type Player = b.infer<typeof PlayerSchema>
    type Expected = {
      name: string
      position: Float32Array
      inventory: Uint8Array
      scores: Uint16Array
    }
    // biome-ignore lint/correctness/noUnusedVariables: This is a test
    const typecheck: Expected = {} as Player // Should compile

    const buffer = PlayerSchema.serialize(value)
    const decoded = PlayerSchema.deserialize(buffer)

    expect(decoded.position).toBeInstanceOf(Float32Array)
    expect(decoded.inventory).toBeInstanceOf(Uint8Array)
    expect(decoded.scores).toBeInstanceOf(Uint16Array)
    expect(decoded).toEqual(value)
  })
})
