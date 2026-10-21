import type { SchemaAST } from "effect"
import { descriptor, type LayoutDescriptor } from "./annotations.js"
import { hashMap, hashSet, readonlyMap, readonlySet } from "./collections.js"
import { compileArrays, compileObject, fixedArray, option, result } from "./containers.js"
import { compileEnum } from "./enums.js"
import type { Reader, Writer } from "./io.js"
import { boolean, bytes, float, integer, string } from "./primitives.js"

export interface Layout {
  readonly minBytes: number
  readonly isZeroSized: boolean
  readonly compare?: (left: unknown, right: unknown) => number
  read(reader: Reader): unknown
  write(writer: Writer, value: unknown): void
}

export type Compile = (ast: SchemaAST.AST, path: string) => Layout

/** Inspect visible nodes without evaluating Suspend thunks, including the type side. */
export function rejectSuspensions(ast: SchemaAST.AST): void {
  const seen = new Set<SchemaAST.AST>()
  const pending = [{ ast, path: "$" }]
  while (pending.length > 0) {
    const node = pending.pop()
    if (node === undefined || seen.has(node.ast)) continue
    seen.add(node.ast)
    const { ast, path } = node
    if (ast._tag === "Suspend")
      throw new Error(`${path}: Suspend/recursive schemas are unsupported`)
    ast.encoding?.forEach((link, i) =>
      pending.push({ ast: link.to, path: `${path}.encoding[${i}]` }),
    )
    switch (ast._tag) {
      case "Declaration":
        ast.typeParameters.forEach((ast, i) =>
          pending.push({ ast, path: `${path}.typeParameters[${i}]` }),
        )
        break
      case "Arrays":
        ast.elements.forEach((ast, i) => pending.push({ ast, path: `${path}[${i}]` }))
        ast.rest.forEach((ast, i) => pending.push({ ast, path: `${path}.rest[${i}]` }))
        break
      case "Objects":
        ast.propertySignatures.forEach((field) =>
          pending.push({ ast: field.type, path: `${path}.${String(field.name)}` }),
        )
        ast.indexSignatures.forEach((index, i) => {
          pending.push({ ast: index.parameter, path: `${path}.keys[${i}]` })
          pending.push({ ast: index.type, path: `${path}.values[${i}]` })
        })
        break
      case "Union":
        ast.types.forEach((ast, i) => pending.push({ ast, path: `${path}.union[${i}]` }))
        break
      case "TemplateLiteral":
        ast.parts.forEach((ast, i) => pending.push({ ast, path: `${path}.parts[${i}]` }))
        break
    }
  }
}

export function compile(ast: SchemaAST.AST): Layout {
  const memo = new Map<SchemaAST.AST, Layout>()
  const compile: Compile = (ast, path) => {
    const cached = memo.get(ast)
    if (cached !== undefined) return cached
    const layout = compileNode(ast, path, compile)
    memo.set(ast, layout)
    return layout
  }
  return compile(ast, "$")
}

/** An explicit layout annotation owns its node; natives and AST tags apply only without one. */
function compileNode(ast: SchemaAST.AST, path: string, compile: Compile): Layout {
  if (ast.context?.isOptional)
    throw new Error(
      `${path}: Optional properties and elements have no Borsh layout; use Schema.Option for a Rust Option`,
    )
  const layout = descriptor(ast, path)
  if (layout !== undefined) return compileDescriptor(ast, layout, path, compile)
  switch (ast._tag) {
    case "Declaration":
      return compileDeclaration(ast, path, compile)
    case "Union":
    case "Enum":
      return compileEnum(ast, undefined, path, compile)
    case "String":
      return string()
    case "Boolean":
      return boolean()
    case "Objects":
      return compileObject(ast, path, compile)
    case "Arrays":
      return compileArrays(ast, path, compile)
    case "Number":
    case "BigInt":
      throw new Error(
        `${path}: ${ast._tag} requires an explicit Borsh width; use a Borsh numeric schema`,
      )
    case "Literal":
      throw new Error(
        `${path}: Unsupported encoded schema Literal; use Schema.Literals or a tagged union for a Rust enum`,
      )
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
    case "integer":
      if (ast._tag !== (layout.bits > 32 ? "BigInt" : "Number"))
        throw new Error(`${path}: Integer layout does not match encoded schema`)
      return integer(layout.bits, layout.signed)
    case "float":
      if (ast._tag !== "Number")
        throw new Error(`${path}: Float layout does not match encoded schema`)
      return float(layout.bits)
    case "fixedBytes":
      if (ast._tag !== "Declaration" || representationId(ast) !== "effect/schema/Uint8Array")
        throw new Error(`${path}: Borsh layout does not match encoded ${ast._tag}`)
      return bytes(layout.length)
    case "fixedArray":
      return fixedArray(ast, layout.length, path, compile)
    case "enum":
      return compileEnum(ast, layout, path, compile)
  }
}

type Native = (ast: SchemaAST.Declaration, path: string, compile: Compile) => Layout

/** Effect declarations with a Borsh layout, keyed by their representation id. */
const natives: Readonly<Record<string, Native>> = {
  "effect/schema/Uint8Array": () => bytes(),
  "effect/schema/Option": option,
  "effect/schema/Result": result,
  "effect/schema/ReadonlyMap": readonlyMap,
  "effect/schema/ReadonlySet": readonlySet,
  "effect/schema/HashMap": hashMap,
  "effect/schema/HashSet": hashSet,
}

function compileDeclaration(ast: SchemaAST.Declaration, path: string, compile: Compile): Layout {
  const id = representationId(ast)
  const native = id !== undefined && Object.hasOwn(natives, id) ? natives[id] : undefined
  if (native === undefined)
    throw new Error(
      `${path}: ${id === undefined ? "Declaration" : `Declaration ${id}`} has no Borsh layout; decode it from a Borsh-encodable schema with Schema.decodeTo`,
    )
  return native(ast, path, compile)
}

function representationId(ast: SchemaAST.Declaration): string | undefined {
  const representation = ast.annotations?.representation
  return typeof representation === "object" &&
    representation !== null &&
    "id" in representation &&
    typeof representation.id === "string"
    ? representation.id
    : undefined
}
