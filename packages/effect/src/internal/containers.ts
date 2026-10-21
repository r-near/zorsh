import { Option, Result, type SchemaAST } from "effect"
import type { Compile, Layout } from "./compiler.js"
import { BinaryError, prepend, type Reader, type Writer } from "./io.js"

export function compileObject(
  ast: SchemaAST.Objects,
  path: string,
  compile: Compile,
  omit?: string,
): Layout {
  if (ast.indexSignatures.length)
    throw new Error(
      `${path}: Index signatures have no Borsh layout; use Schema.ReadonlyMap or Schema.HashMap for a Rust map`,
    )
  const fields = ast.propertySignatures
    .filter((field) => field.name !== omit)
    .map((field) => {
      if (typeof field.name === "symbol")
        throw new Error(
          `${path}: Symbol key ${String(field.name)} has no Borsh layout; use a string key`,
        )
      const name = field.name
      // Assignment would hit an inherited setter or a frozen inherited property. Checked once at
      // compile time: Effect's schema pass, which runs next, assigns plainly too.
      const define = name in Object.prototype
      return { name, define, layout: compile(field.type, `${path}[${JSON.stringify(name)}]`) }
    })
  return {
    minBytes: fields.reduce((sum, field) => sum + field.layout.minBytes, 0),
    isZeroSized: fields.every((field) => field.layout.isZeroSized),
    read: (r) => {
      const value: Record<PropertyKey, unknown> = {}
      let name: string | number = ""
      try {
        for (const field of fields) {
          name = field.name
          const item = field.layout.read(r)
          if (field.define) defineField(value, name, item)
          else value[name] = item
        }
      } catch (error) {
        throw prepend(error, name)
      }
      return value
    },
    write: (w, value) => {
      if (fields.length === 0) return
      if (typeof value !== "object" || value === null)
        throw new BinaryError(w.offset, "Expected object")
      let name: string | number = ""
      try {
        for (const field of fields) {
          name = field.name
          if (!Object.hasOwn(value, name)) throw new BinaryError(w.offset, "Missing required field")
          field.layout.write(w, Reflect.get(value, name))
        }
      } catch (error) {
        throw prepend(error, name)
      }
    },
  }
}

/** Define an own data property where assignment would reach Object.prototype. */
export function defineField(target: object, name: PropertyKey, value: unknown): void {
  Object.defineProperty(target, name, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

/** The item of a plain `ReadonlyArray<T>`, with no leading or trailing elements. */
export function homogeneousItem(ast: SchemaAST.AST): SchemaAST.AST | undefined {
  return ast._tag === "Arrays" && ast.elements.length === 0 && ast.rest.length === 1
    ? ast.rest[0]
    : undefined
}

export function compileArrays(ast: SchemaAST.Arrays, path: string, compile: Compile): Layout {
  if (ast.rest.length === 0)
    return tuple(ast.elements.map((item, i) => compile(item, `${path}[${i}]`)))
  const rest = homogeneousItem(ast)
  if (rest === undefined)
    throw new Error(
      `${path}: Mixed tuple rests have no Borsh layout; nest the rest as a Schema.Array element, or use Schema.Array with Schema.isMinLength`,
    )
  return vector(compile(rest, `${path}[]`))
}

function tuple(items: ReadonlyArray<Layout>): Layout {
  return {
    minBytes: items.reduce((sum, item) => sum + item.minBytes, 0),
    isZeroSized: items.every((item) => item.isZeroSized),
    read: (r) => {
      const value: unknown[] = []
      let i = 0
      try {
        for (const item of items) {
          value.push(item.read(r))
          i++
        }
      } catch (error) {
        throw prepend(error, i)
      }
      return value
    },
    write: (w, value) => {
      if (!Array.isArray(value) || value.length !== items.length)
        throw new BinaryError(w.offset, `Expected tuple of length ${items.length}`)
      let i = 0
      try {
        for (const item of items) {
          item.write(w, value[i])
          i++
        }
      } catch (error) {
        throw prepend(error, i)
      }
    },
  }
}

/** Rust Vec<T>. Zero-sized items are rejected when visited, as borsh-rs does. */
function vector(item: Layout): Layout {
  const checkItem = (offset: number) => {
    if (item.isZeroSized)
      throw new BinaryError(offset, "Borsh forbids vectors of zero-sized values")
  }
  return {
    minBytes: 4,
    isZeroSized: false,
    read: (r) => {
      checkItem(r.offset)
      const count = r.u32()
      if (count > Math.floor((r.input.byteLength - r.offset) / item.minBytes))
        throw new BinaryError(r.offset, "Truncated vector payload")
      return readItems(r, item, count)
    },
    write: (w, value) => {
      checkItem(w.offset)
      if (!Array.isArray(value) || value.length > 0xffff_ffff)
        throw new BinaryError(w.offset, "Expected array with u32 length")
      w.u32(value.length)
      writeItems(w, item, value)
    },
  }
}

/** Rust [T; N], without a count prefix. */
export function fixedArray(
  ast: SchemaAST.AST,
  length: number,
  path: string,
  compile: Compile,
): Layout {
  const rest = homogeneousItem(ast)
  if (rest === undefined)
    throw new Error(`${path}: Fixed array layout requires a homogeneous encoded array`)
  const item = compile(rest, `${path}[]`)
  const minBytes = length === 0 ? 0 : Math.min(Number.MAX_SAFE_INTEGER, length * item.minBytes)
  return {
    minBytes,
    isZeroSized: length === 0 || item.isZeroSized,
    read: (r) => {
      if (minBytes > r.input.byteLength - r.offset)
        throw new BinaryError(r.offset, "Truncated fixed array payload")
      return readItems(r, item, length)
    },
    write: (w, value) => {
      if (!Array.isArray(value) || value.length !== length)
        throw new BinaryError(w.offset, `Expected fixed array of length ${length}`)
      w.ensure(minBytes)
      let i = 0
      try {
        for (; i < length; i++) item.write(w, value[i])
      } catch (error) {
        throw prepend(error, i)
      }
    },
  }
}

/** Effect's constructors fix these arities; only hand-built declarations can differ. */
export function parameters<const N extends 1 | 2>(
  ast: SchemaAST.Declaration,
  count: N,
  name: string,
  path: string,
): N extends 1 ? readonly [SchemaAST.AST] : readonly [SchemaAST.AST, SchemaAST.AST] {
  if (ast.typeParameters.length !== count)
    throw new Error(
      `${path}: ${name} requires exactly ${count} encoded type parameter${count === 1 ? "" : "s"}`,
    )
  return ast.typeParameters as never
}

export function option(ast: SchemaAST.Declaration, path: string, compile: Compile): Layout {
  const [inner] = parameters(ast, 1, "Option", path)
  const item = compile(inner, `${path}["value"]`)
  return {
    minBytes: 1,
    isZeroSized: false,
    read: (r) => {
      const offset = r.offset
      const tag = r.u8()
      if (tag > 1) throw new BinaryError(offset, `Invalid Option tag ${tag}`)
      if (tag === 0) return Option.none()
      try {
        return Option.some(item.read(r))
      } catch (error) {
        throw prepend(error, "value")
      }
    },
    write: (w, value) => {
      if (!Option.isOption(value)) throw new BinaryError(w.offset, "Expected Option")
      w.u8(Option.isSome(value) ? 1 : 0)
      if (Option.isNone(value)) return
      try {
        item.write(w, value.value)
      } catch (error) {
        throw prepend(error, "value")
      }
    },
  }
}

export function result(ast: SchemaAST.Declaration, path: string, compile: Compile): Layout {
  const [success, failure] = parameters(ast, 2, "Result", path)
  const ok = compile(success, `${path}["success"]`)
  const err = compile(failure, `${path}["failure"]`)
  return {
    minBytes: 1 + Math.min(ok.minBytes, err.minBytes),
    isZeroSized: false,
    read: (r) => {
      const offset = r.offset
      const tag = r.u8()
      if (tag > 1) throw new BinaryError(offset, `Invalid Result tag ${tag}`)
      try {
        return tag === 1 ? Result.succeed(ok.read(r)) : Result.fail(err.read(r))
      } catch (error) {
        throw prepend(error, tag === 1 ? "success" : "failure")
      }
    },
    write: (w, value) => {
      if (!Result.isResult(value)) throw new BinaryError(w.offset, "Expected Result")
      const success = Result.isSuccess(value)
      w.u8(success ? 1 : 0)
      try {
        if (success) ok.write(w, value.success)
        else err.write(w, value.failure)
      } catch (error) {
        throw prepend(error, success ? "success" : "failure")
      }
    },
  }
}

function readItems(r: Reader, item: Layout, count: number): unknown[] {
  const value: unknown[] = []
  let i = 0
  try {
    for (; i < count; i++) value.push(item.read(r))
  } catch (error) {
    throw prepend(error, i)
  }
  return value
}

function writeItems(w: Writer, item: Layout, value: readonly unknown[]): void {
  let i = 0
  try {
    for (; i < value.length; i++) item.write(w, value[i])
  } catch (error) {
    throw prepend(error, i)
  }
}
