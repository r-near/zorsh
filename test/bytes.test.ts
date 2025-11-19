import { describe, expect, test } from "vitest"
import { b } from "../src/schema"

describe("bytes helper", () => {
  test("dynamic bytes round-trip (Vec<u8>)", () => {
    const schema = b.bytes()
    const original = new Uint8Array([1, 2, 3, 255])

    const encoded = schema.serialize(original)
    const decoded = schema.deserialize(encoded)

    expect(decoded).toBeInstanceOf(Uint8Array)
    expect(Array.from(decoded)).toEqual(Array.from(original))

    const vecSchema = b.vec(b.u8())
    const vecEncoded = vecSchema.serialize(original)

    expect(encoded).toEqual(vecEncoded)
  })

  test("fixed bytes round-trip ([u8; N])", () => {
    const schema = b.bytes(3)
    const original = new Uint8Array([10, 20, 30])

    const encoded = schema.serialize(original)
    const decoded = schema.deserialize(encoded)

    expect(decoded).toBeInstanceOf(Uint8Array)
    expect(Array.from(decoded)).toEqual([10, 20, 30])

    const arraySchema = b.array(b.u8(), 3)
    const arrayEncoded = arraySchema.serialize([10, 20, 30])

    expect(encoded).toEqual(arrayEncoded)
  })

  test("fixed bytes length mismatch throws", () => {
    const schema = b.bytes(3)
    const bad = new Uint8Array([1, 2])

    expect(() => schema.serialize(bad)).toThrow()
  })

  test("type inference for bytes schemas", () => {
    const dynamic = b.bytes()
    const fixed = b.bytes(32)

    type Dynamic = b.infer<typeof dynamic>
    type Fixed = b.infer<typeof fixed>
    type Expected = Uint8Array

    // These assignments are type-level checks - if they compile, inference is correct
    // biome-ignore lint/correctness/noUnusedVariables: This is a type-level test
    const dynamicCheck: Expected = {} as Dynamic
    // biome-ignore lint/correctness/noUnusedVariables: This is a type-level test
    const fixedCheck: Expected = {} as Fixed
  })
})
