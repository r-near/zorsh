import { Function, type SchemaAST } from "effect"
import { descriptor, type LayoutDescriptor } from "./annotations.js"
import { compileArrays, compileObject, fixedArray } from "./containers.js"
import { compileEnum } from "./enums.js"
import type { Reader, Writer } from "./io.js"
import { type DeferredChecks, filters, type Limits } from "./limits.js"
import { compileDeclaration, isUint8Array, mergingKeyChecks } from "./natives.js"
import { boolean, bytes, float, integer, string } from "./primitives.js"

export interface Layout {
  readonly minBytes: number
  readonly isZeroSized: boolean
  readonly compare?: (left: unknown, right: unknown) => number
  read(reader: Reader): unknown
  write(writer: Writer, value: unknown): void
}

export type Compile = (ast: SchemaAST.AST, path: string) => Layout

/**
 * Walks the original schema, before `toEncoded` drops its type side. Recursive schemas are
 * unsupported, so any Suspend on the encoded or type side fails here with its path, without calling
 * its thunk. Returns the checks the binary layer must leave to the schema pass.
 */
export function prepare(root: SchemaAST.AST): DeferredChecks {
  const mergingChecks = new WeakSet<SchemaAST.Check<unknown>>()
  const recoverableChecks = new WeakSet<SchemaAST.Check<unknown>>()
  // A node shared inside and outside decoding middleware is visited once in each state.
  const seen = { plain: new Set<SchemaAST.AST>(), recoverable: new Set<SchemaAST.AST>() }
  const pending = [{ ast: root, path: "$", recoverable: false }]
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const { ast, path, recoverable } = node
    const visited = recoverable ? seen.recoverable : seen.plain
    if (visited.has(ast)) {
      continue
    }
    visited.add(ast)
    if (ast._tag === "Suspend") {
      throw new Error(`${path}: Suspend/recursive schemas are unsupported`)
    }
    if (recoverable) {
      // Flipped nodes keep their wire-side checks in encodingChecks.
      const encodingChecks = "encodingChecks" in ast ? ast.encodingChecks : undefined
      for (const check of filters([...(ast.checks ?? []), ...(encodingChecks ?? [])])) {
        recoverableChecks.add(check)
      }
    }
    // Middleware can catch a failure anywhere in the schemas it wraps.
    const wrapsRecovery = hasDecodingMiddleware(ast)
    ast.encoding?.forEach((link, i) =>
      pending.push({
        ast: link.to,
        path: `${path}.encoding[${i}]`,
        recoverable: recoverable || wrapsRecovery,
      }),
    )
    if (ast._tag === "Declaration") {
      for (const check of mergingKeyChecks(ast)) {
        mergingChecks.add(check)
      }
    }
    // Effect tries a member with decoding middleware on every input, so its recovery can stand in
    // for a sibling that failed a check. Middleware anywhere in a union counts, conservatively, which
    // also covers middleware on a member's tag.
    const membersRecover = ast._tag === "Union" && containsDecodingMiddleware(ast, path)
    for (const child of children(ast, path)) {
      pending.push({ ...child, recoverable: recoverable || membersRecover })
    }
  }
  return { mergingChecks, recoverableChecks }
}

/** The schemas directly inside ast, apart from its encoding chain, with their paths. */
function children(
  ast: SchemaAST.AST,
  path: string,
): Array<{ readonly ast: SchemaAST.AST; readonly path: string }> {
  switch (ast._tag) {
    case "Declaration":
      return ast.typeParameters.map((child, i) => ({
        ast: child,
        path: `${path}.typeParameters[${i}]`,
      }))
    case "Arrays":
      return [
        ...ast.elements.map((child, i) => ({ ast: child, path: `${path}[${i}]` })),
        ...ast.rest.map((child, i) => ({ ast: child, path: `${path}.rest[${i}]` })),
      ]
    case "Objects":
      return [
        ...ast.propertySignatures.map((field) => ({
          ast: field.type,
          path: `${path}.${String(field.name)}`,
        })),
        ...ast.indexSignatures.flatMap((index, i) => [
          { ast: index.parameter, path: `${path}.keys[${i}]` },
          { ast: index.type, path: `${path}.values[${i}]` },
        ]),
      ]
    case "Union":
      return ast.types.map((child, i) => ({ ast: child, path: `${path}.union[${i}]` }))
    case "TemplateLiteral":
      return ast.parts.map((child, i) => ({ ast: child, path: `${path}.parts[${i}]` }))
  }
  return []
}

/** Whether decoding middleware sits anywhere in root's subtree, including encoding chains. */
function containsDecodingMiddleware(root: SchemaAST.AST, rootPath: string): boolean {
  const seen = new Set<SchemaAST.AST>()
  const pending = [{ ast: root, path: rootPath }]
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const { ast, path } = node
    if (seen.has(ast)) {
      continue
    }
    seen.add(ast)
    if (hasDecodingMiddleware(ast)) {
      return true
    }
    ast.encoding?.forEach((link, i) =>
      pending.push({ ast: link.to, path: `${path}.encoding[${i}]` }),
    )
    pending.push(...children(ast, path))
  }
  return false
}

function hasDecodingMiddleware(ast: SchemaAST.AST): boolean {
  return ast.encoding?.some(isDecodingMiddleware) === true
}

/** Mirrors Effect's own test for middleware that can change a decoding result. */
function isDecodingMiddleware(link: SchemaAST.Link): boolean {
  const transformation = link.transformation
  return transformation._tag === "Middleware" && transformation.decode !== Function.identity
}

/**
 * limits must come from prepare on the original schema, or merging and recoverable checks would
 * fail early.
 */
export function compile(root: SchemaAST.AST, limits: Limits): Layout {
  // A node reused across the schema compiles once.
  const memo = new Map<SchemaAST.AST, Layout>()
  const compileCached: Compile = (ast, path) => {
    const cached = memo.get(ast)
    if (cached !== undefined) {
      return cached
    }
    const layout = compileNode(ast, path, compileCached, limits)
    memo.set(ast, layout)
    return layout
  }
  return compileCached(root, "$")
}

/** An explicit layout annotation owns its node; natives and AST tags apply only without one. */
function compileNode(ast: SchemaAST.AST, path: string, compile: Compile, limits: Limits): Layout {
  if (ast.context?.isOptional) {
    throw new Error(
      `${path}: Optional properties and elements have no Borsh layout on the encoded side; use Schema.Option for a Rust Option`,
    )
  }
  const layout = descriptor(ast, path)
  if (layout !== undefined) {
    return compileDescriptor(ast, layout, path, compile, limits)
  }
  switch (ast._tag) {
    case "Declaration":
      return compileDeclaration(ast, path, compile, limits)
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
      return compileArrays(ast, path, compile, limits)
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
  limits: Limits,
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
      return bytes(layout.length)
    case "fixedArray":
      return fixedArray(ast, layout.length, path, compile, limits)
    case "enum":
      return compileEnum(ast, layout, path, compile)
  }
}
