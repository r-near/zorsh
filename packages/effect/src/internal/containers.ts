import type { SchemaAST } from "effect"
import type { Compile, Layout } from "./compiler.js"
import { BinaryError, prepend, type Reader, type Writer } from "./io.js"
import { type CountGuard, countGuard, guardedRead, type Limits } from "./limits.js"

/** A Rust struct: fields in declaration order. `omit` skips an enum variant's tag field. */
export function compileObject(
  ast: SchemaAST.Objects,
  path: string,
  compile: Compile,
  omit?: string,
): Layout {
  if (ast.indexSignatures.length > 0) {
    throw new Error(
      `${path}: Index signatures have no Borsh layout; use Schema.ReadonlyMap or Schema.HashMap for a Rust map`,
    )
  }
  const fields = ast.propertySignatures
    .filter((field) => field.name !== omit)
    .map((field) => {
      if (typeof field.name === "symbol") {
        throw new Error(
          `${path}: Symbol key ${String(field.name)} has no Borsh layout; use a string key`,
        )
      }
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
          if (field.define) {
            defineField(value, name, item)
          } else {
            value[name] = item
          }
        }
      } catch (error) {
        throw prepend(error, name)
      }
      return value
    },
    write: (w, value) => {
      if (fields.length === 0) {
        return
      }
      if (typeof value !== "object" || value === null) {
        throw new BinaryError(w.offset, "Expected object")
      }
      let name: string | number = ""
      try {
        for (const field of fields) {
          name = field.name
          if (!Object.hasOwn(value, name)) {
            throw new BinaryError(w.offset, "Missing required field")
          }
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
  if (ast._tag === "Arrays" && ast.elements.length === 0 && ast.rest.length === 1) {
    return ast.rest[0]
  }
  return undefined
}

export function compileArrays(
  ast: SchemaAST.Arrays,
  path: string,
  compile: Compile,
  limits: Limits,
): Layout {
  if (ast.rest.length === 0) {
    return tuple(ast.elements.map((item, i) => compile(item, `${path}[${i}]`)))
  }
  const rest = homogeneousItem(ast)
  if (rest === undefined) {
    throw new Error(
      `${path}: Mixed tuple rests have no Borsh layout; move the rest into its own Schema.Array element, or use Schema.Array with Schema.isMinLength`,
    )
  }
  return vector(compile(rest, `${path}[]`), countGuard(ast.checks, "items", limits))
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
      if (!Array.isArray(value) || value.length !== items.length) {
        throw new BinaryError(w.offset, `Expected tuple of length ${items.length}`)
      }
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
function vector(item: Layout, guard: CountGuard | undefined): Layout {
  const rejectZeroSizedItem = (offset: number) => {
    if (item.isZeroSized) {
      throw new BinaryError(offset, "Borsh forbids vectors of zero-sized values")
    }
  }
  // Without a guard these are the hot-path closures, so the limit helpers below stay out of them.
  if (guard === undefined) {
    return {
      minBytes: 4,
      isZeroSized: false,
      read: (r) => {
        rejectZeroSizedItem(r.offset)
        const count = r.u32()
        // Each item needs at least minBytes, so reject an impossible count before allocating.
        if (count > Math.floor((r.input.byteLength - r.offset) / item.minBytes)) {
          throw new BinaryError(r.offset, "Truncated vector payload")
        }
        return readItems(r, item, count)
      },
      write: (w, value) => {
        rejectZeroSizedItem(w.offset)
        if (!Array.isArray(value) || value.length > 0xffff_ffff) {
          throw new BinaryError(w.offset, "Expected array with u32 length")
        }
        w.u32(value.length)
        writeItems(w, item, value)
      },
    }
  }
  const readGuarded = guardedRead(guard, (r, count) => {
    if (count > Math.floor((r.input.byteLength - r.offset) / item.minBytes)) {
      throw new BinaryError(r.offset, "Truncated vector payload")
    }
    return readItems(r, item, count)
  })
  return {
    minBytes: 4,
    isZeroSized: false,
    read: (r) => {
      rejectZeroSizedItem(r.offset)
      return readGuarded(r)
    },
    write: (w, value) => {
      rejectZeroSizedItem(w.offset)
      if (!Array.isArray(value) || value.length > 0xffff_ffff) {
        throw new BinaryError(w.offset, "Expected array with u32 length")
      }
      if (guard.countItems) {
        w.charge(value.length, w.offset)
      }
      w.u32(value.length)
      writeItems(w, item, value)
    },
  }
}

/** Rust [T; N], without a count prefix. With maxItems, every read and write charges all N items. */
export function fixedArray(
  ast: SchemaAST.AST,
  length: number,
  path: string,
  compile: Compile,
  limits: Limits,
): Layout {
  const rest = homogeneousItem(ast)
  if (rest === undefined) {
    throw new Error(`${path}: Fixed array layout requires a homogeneous encoded array`)
  }
  const item = compile(rest, `${path}[]`)
  // Nested fixed arrays can multiply past 2^53, so clamp to stay a safe integer.
  const minBytes = length === 0 ? 0 : Math.min(Number.MAX_SAFE_INTEGER, length * item.minBytes)
  const read = (r: Reader) => {
    if (minBytes > r.input.byteLength - r.offset) {
      throw new BinaryError(r.offset, "Truncated fixed array payload")
    }
    return readItems(r, item, length)
  }
  const isFixedArray = (value: unknown): value is readonly unknown[] =>
    Array.isArray(value) && value.length === length
  const write = (w: Writer, value: unknown) => {
    if (!isFixedArray(value)) {
      throw new BinaryError(w.offset, `Expected fixed array of length ${length}`)
    }
    w.ensure(minBytes)
    let i = 0
    try {
      for (; i < length; i++) {
        item.write(w, value[i])
      }
    } catch (error) {
      throw prepend(error, i)
    }
  }
  const isZeroSized = length === 0 || item.isZeroSized
  if (!limits.countItems) {
    return { minBytes, isZeroSized, read, write }
  }
  // Zero-sized items cost no bytes, so maxItems is the only bound on how many a read visits.
  return {
    minBytes,
    isZeroSized,
    read: (r) => {
      r.charge(length, r.offset)
      return read(r)
    },
    write: (w, value) => {
      // A value of the wrong shape fails in write with its own message, before any charge.
      if (isFixedArray(value)) {
        w.charge(length, w.offset)
      }
      write(w, value)
    },
  }
}

function readItems(r: Reader, item: Layout, count: number): unknown[] {
  const value: unknown[] = []
  let i = 0
  try {
    for (; i < count; i++) {
      value.push(item.read(r))
    }
  } catch (error) {
    throw prepend(error, i)
  }
  return value
}

function writeItems(w: Writer, item: Layout, value: readonly unknown[]): void {
  let i = 0
  try {
    for (; i < value.length; i++) {
      item.write(w, value[i])
    }
  } catch (error) {
    throw prepend(error, i)
  }
}
