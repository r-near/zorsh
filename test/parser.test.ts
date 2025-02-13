import { describe, expect, test } from "vitest"
import { TypeParser } from "../src/generator/parser"

describe("TypeParser", () => {
  const parser = new TypeParser()

  const testCases = [
    {
      input: "String",
      expected: "b.string()",
    },
    {
      input: "u32",
      expected: "b.u32()",
    },
    {
      input: "Vec<String>",
      expected: "b.vec(b.string())",
    },
    {
      input: "HashMap<String, u32>",
      expected: "b.hashMap(b.string(), b.u32())",
    },
    {
      input: "Option<Vec<String>>",
      expected: "b.option(b.vec(b.string()))",
    },
    {
      input: "(u16, f32)",
      expected: "b.tuple([b.u16(), b.f32()])",
    },
    {
      input: "HashMap<String, (u16, f32)>",
      expected: "b.hashMap(b.string(), b.tuple([b.u16(), b.f32()]))",
    },
    {
      input: "Vec<(u64, Location, String)>",
      expected: "b.vec(b.tuple([b.u64(), LocationSchema, b.string()]))",
    },
  ]

  test.each(testCases)("parses and generates code for $input", ({ input, expected }) => {
    const ast = parser.parse(input)
    const generated = parser.generateZorshCode(ast)
    expect(generated).toBe(expected)
  })

  test("handles nested complex types", () => {
    const input = "HashMap<String, Vec<Option<(u32, String)>>>"
    const expected = "b.hashMap(b.string(), b.vec(b.option(b.tuple([b.u32(), b.string()]))))"

    const ast = parser.parse(input)
    const generated = parser.generateZorshCode(ast)
    expect(generated).toBe(expected)
  })
})
