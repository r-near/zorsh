import type { SchemaAST } from "effect"
import {
  type LayoutAnnotation,
  layoutAnnotation,
  maxLengthOf,
  rejectMaxLength,
} from "./annotations.js"
import { compileArrays, compileObject, fixedArray, homogeneousItem } from "./containers.js"
import { compileEnum } from "./enums.js"
import type { Reader, Writer } from "./io.js"
import { compileDeclaration, isLengthPrefixed } from "./natives.js"
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
  const layout = layoutAnnotation(ast, path)
  if (layout !== undefined || !hasLengthPrefix(ast)) {
    rejectMaxLength(ast, path)
  }
  if (layout !== undefined) {
    return compileLayout(ast, layout, path, compile)
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

/** Only this package's constructors write layout annotations, each onto the AST it lays out. */
function compileLayout(
  ast: SchemaAST.AST,
  layout: LayoutAnnotation,
  path: string,
  compile: Compile,
): Layout {
  switch (layout.kind) {
    case "integer":
      return integer(layout.bits, layout.signed)
    case "float":
      return float(layout.bits)
    case "fixedBytes":
      return fixedBytes(layout.length)
    case "fixedArray":
      return fixedArray(ast as SchemaAST.Arrays, layout.length, path, compile)
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
