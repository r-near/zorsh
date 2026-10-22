import type { SchemaAST } from "effect"
import { descriptor, type LayoutDescriptor, maxLengthOf, rejectMaxLength } from "./annotations.js"
import { compileArrays, compileObject, fixedArray, homogeneousItem } from "./containers.js"
import { compileEnum } from "./enums.js"
import type { Reader, Writer } from "./io.js"
import { compileDeclaration, isLengthPrefixed, isUint8Array } from "./natives.js"
import { boolean, fixedBytes, float, integer, string } from "./primitives.js"

export interface Layout {
  readonly minBytes: number
  readonly isZeroSized: boolean
  readonly compare?: (left: unknown, right: unknown) => number
  read(reader: Reader): unknown
  write(writer: Writer, value: unknown): void
}

export type Compile = (ast: SchemaAST.AST, path: string) => Layout

/** Every u32 length fits, so a layout without Borsh.maxLength never fails its comparison. */
const unbounded = 0xffff_ffff

export function compile(root: SchemaAST.AST): Layout {
  // A node reused across the schema compiles once.
  const memo = new Map<SchemaAST.AST, Layout>()
  const compileCached: Compile = (ast, path) => {
    const cached = memo.get(ast)
    if (cached !== undefined) {
      return cached
    }
    const layout = compileNode(ast, path, compileCached)
    memo.set(ast, layout)
    return layout
  }
  return compileCached(root, "$")
}

/** An explicit layout annotation owns its node; natives and AST tags apply only without one. */
function compileNode(ast: SchemaAST.AST, path: string, compile: Compile): Layout {
  if (ast.context?.isOptional) {
    throw new Error(
      `${path}: Optional properties and elements have no Borsh layout on the encoded side; use Schema.Option for a Rust Option`,
    )
  }
  const layout = descriptor(ast, path)
  if (layout !== undefined || !hasLengthPrefix(ast)) {
    rejectMaxLength(ast, path)
  }
  if (layout !== undefined) {
    return compileDescriptor(ast, layout, path, compile)
  }
  const bound = maxLengthOf(ast) ?? unbounded
  switch (ast._tag) {
    case "Declaration":
      return compileDeclaration(ast, path, compile, bound)
    case "Union":
    case "Enum":
      return compileEnum(ast, undefined, path, compile)
    case "String":
      return string(bound)
    case "Boolean":
      return boolean()
    case "Objects":
      return compileObject(ast, path, compile)
    case "Arrays":
      return compileArrays(ast, path, compile, bound)
    case "Number":
    case "BigInt":
      throw new Error(
        `${path}: ${ast._tag} requires an explicit Borsh width; use a Borsh numeric schema`,
      )
    case "Literal":
      throw new Error(
        `${path}: Unsupported encoded schema Literal; use Schema.Literals or a tagged union for a Rust enum`,
      )
    case "Suspend":
      // Compiling the thunk's schema would recurse forever on a recursive one, so never call it.
      throw new Error(`${path}: Suspend/recursive schemas are unsupported`)
  }
  throw new Error(`${path}: Unsupported encoded schema ${ast._tag}`)
}

function compileDescriptor(
  ast: SchemaAST.AST,
  layout: LayoutDescriptor,
  path: string,
  compile: Compile,
): Layout {
  switch (layout.kind) {
    case "integer": {
      // Integers up to 32 bits are numbers; u64 and wider can exceed 2^53, so they are bigints.
      const encoded = layout.bits > 32 ? "BigInt" : "Number"
      if (ast._tag !== encoded) {
        throw new Error(`${path}: Integer layout does not match encoded ${ast._tag}`)
      }
      return integer(layout.bits, layout.signed)
    }
    case "float":
      if (ast._tag !== "Number") {
        throw new Error(`${path}: Float layout does not match encoded ${ast._tag}`)
      }
      return float(layout.bits)
    case "fixedBytes":
      if (!isUint8Array(ast)) {
        throw new Error(`${path}: Fixed bytes layout requires an encoded Uint8Array`)
      }
      return fixedBytes(layout.length)
    case "fixedArray":
      return fixedArray(ast, layout.length, path, compile)
    case "enum":
      return compileEnum(ast, layout, path, compile)
  }
}

/** Whether ast's layout starts with a u32 length that Borsh.maxLength can bound. */
function hasLengthPrefix(ast: SchemaAST.AST): boolean {
  switch (ast._tag) {
    case "String":
      return true
    case "Arrays":
      return homogeneousItem(ast) !== undefined
    case "Declaration":
      return isLengthPrefixed(ast)
  }
  return false
}
