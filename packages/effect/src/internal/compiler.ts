import { HashMap, HashSet, Option, Result, SchemaAST } from "effect"
import { descriptor } from "./annotations.js"
import { BinaryError, Reader, utf8Length, Writer } from "./io.js"

export interface Layout {
  readonly minBytes: number
  readonly isZeroSized: boolean
  readonly compare?: (left: unknown, right: unknown) => number
  read(reader: Reader): unknown
  write(writer: Writer, value: unknown): void
}

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
  const compile = (ast: SchemaAST.AST, path: string): Layout => {
    const cached = memo.get(ast)
    if (cached !== undefined) return cached
    const layout = compileNode(ast, path, compile)
    memo.set(ast, layout)
    return layout
  }
  return compile(ast, "$")
}

function compileNode(
  ast: SchemaAST.AST,
  path: string,
  compile: (ast: SchemaAST.AST, path: string) => Layout,
): Layout {
  if (ast.context?.isOptional)
    throw new Error(`${path}: Optional schemas need an explicit Borsh representation`)
  const layout = descriptor(ast)
  if (layout?.kind === "integer") {
    const { bits, signed } = layout
    const bigint = bits > 32
    if (ast._tag !== (bigint ? "BigInt" : "Number"))
      throw new Error(`${path}: Integer layout does not match encoded schema`)
    const width = bits / 8
    const minimum = signed ? -(1n << BigInt(bits - 1)) : 0n
    const maximum = (1n << BigInt(signed ? bits - 1 : bits)) - 1n
    return {
      compare: comparePrimitive,
      minBytes: width,
      isZeroSized: false,
      read: (r) => {
        const view = r.view(width)
        let value = 0n
        for (let i = width - 1; i >= 0; i--) value = (value << 8n) | BigInt(view.getUint8(i))
        if (signed && value > maximum) value -= 1n << BigInt(bits)
        return bigint ? value : Number(value)
      },
      write: (w, value) => {
        let n: bigint
        if (typeof value === "bigint" && bigint) n = value
        else if (typeof value === "number" && !bigint && Number.isInteger(value)) n = BigInt(value)
        else throw new BinaryError(w.offset, `Expected ${signed ? "i" : "u"}${bits}`)
        if (n < minimum || n > maximum)
          throw new BinaryError(w.offset, `Integer outside ${signed ? "i" : "u"}${bits} range`)
        const view = w.view(width)
        for (let i = 0; i < width; i++) {
          view.setUint8(i, Number(n & 255n))
          n >>= 8n
        }
      },
    }
  }
  if (layout?.kind === "float") {
    if (ast._tag !== "Number")
      throw new Error(`${path}: Float layout does not match encoded schema`)
    const bits = layout.bits
    return {
      minBytes: bits / 8,
      isZeroSized: false,
      read: (r) => {
        const offset = r.offset
        const view = r.view(bits / 8)
        const value = bits === 32 ? view.getFloat32(0, true) : view.getFloat64(0, true)
        if (Number.isNaN(value)) throw new BinaryError(offset, "Borsh forbids NaN")
        return value
      },
      write: (w, value) => {
        if (
          typeof value !== "number" ||
          Number.isNaN(value) ||
          (bits === 32 && !Object.is(Math.fround(value), value))
        ) {
          throw new BinaryError(w.offset, `Expected exact non-NaN f${bits}`)
        }
        const view = w.view(bits / 8)
        if (bits === 32) view.setFloat32(0, value, true)
        else view.setFloat64(0, value, true)
      },
    }
  }
  const representation = ast.annotations?.representation
  const representationId =
    typeof representation === "object" && representation !== null && "id" in representation
      ? representation.id
      : undefined
  if (
    ast._tag === "Declaration" &&
    representationId === "effect/schema/Uint8Array" &&
    (layout === undefined || layout.kind === "fixedBytes")
  ) {
    const length = layout?.length
    return {
      minBytes: length ?? 4,
      isZeroSized: length === 0,
      read: (r) => r.take(length ?? r.u32()).slice(),
      write: (w, value) => {
        if (!(value instanceof Uint8Array)) throw new BinaryError(w.offset, "Expected Uint8Array")
        if (length !== undefined && value.byteLength !== length)
          throw new BinaryError(w.offset, `Expected ${length} bytes`)
        if (value.byteLength > 0xffff_ffff)
          throw new BinaryError(w.offset, "Byte array exceeds u32 length")
        w.ensure(value.byteLength + (length === undefined ? 4 : 0))
        if (length === undefined) w.u32(value.byteLength)
        w.bytes(value)
      },
    }
  }
  if (ast._tag === "Declaration" && layout === undefined) {
    const adapter =
      representationId === "effect/schema/ReadonlyMap"
        ? readonlyMap
        : representationId === "effect/schema/ReadonlySet"
          ? readonlySet
          : representationId === "effect/schema/HashMap"
            ? hashMap
            : representationId === "effect/schema/HashSet"
              ? hashSet
              : undefined
    if (adapter !== undefined) {
      const [key, value] = ast.typeParameters
      if (ast.typeParameters.length !== adapter.arity || key === undefined)
        throw new Error(
          `${path}: Collection requires exactly ${adapter.arity} encoded type parameters`,
        )
      const keyLayout = compile(key, `${path}["key"]`)
      const compare = keyLayout.compare
      if (compare === undefined)
        throw new Error(`${path}: Collection keys require Boolean, integer or String Rust ordering`)
      const valueLayout = value === undefined ? undefined : compile(value, `${path}["value"]`)
      const minimum = keyLayout.minBytes + (valueLayout?.minBytes ?? 0)
      const ordered = (previous: unknown, key: unknown, offset: number) => {
        if (compare(previous, key) >= 0)
          throw new BinaryError(offset, "Collection keys must be strictly increasing")
      }
      return {
        minBytes: 4,
        isZeroSized: false,
        read: (r) => {
          const count = r.u32()
          if (count > Math.floor((r.input.byteLength - r.offset) / minimum))
            throw new BinaryError(r.offset, "Truncated collection payload")
          const entries: [unknown, unknown][] = []
          for (let i = 0; i < count; i++)
            at(`[${i}]`, () => {
              const offset = r.offset
              const key = at('["key"]', () => keyLayout.read(r))
              if (i > 0) at('["key"]', () => ordered(entries[i - 1]?.[0], key, offset))
              entries.push([
                key,
                valueLayout === undefined ? undefined : at('["value"]', () => valueLayout.read(r)),
              ])
            })
          return adapter.make(entries)
        },
        write: (w, value) => {
          const collection = adapter.get(value)
          if (collection === undefined || collection.size > 0xffff_ffff)
            throw new BinaryError(w.offset, "Expected native collection with u32 length")
          w.ensure(4 + collection.size * minimum)
          const entries = Array.from(collection.entries).sort(([a], [b]) => compare(a, b))
          w.u32(entries.length)
          for (const [i, [key, value]] of entries.entries())
            at(`[${i}]`, () => {
              if (i > 0) at('["key"]', () => ordered(entries[i - 1]?.[0], key, w.offset))
              at('["key"]', () => keyLayout.write(w, key))
              if (valueLayout !== undefined) at('["value"]', () => valueLayout.write(w, value))
            })
        },
      }
    }
  }
  if (layout?.kind === "enum") {
    if (ast._tag !== "Union" || ast.types.length < 2 || ast.types.length > 256)
      throw new Error(`${path}: Enum layout requires a union of 2..256 object variants`)
    const discriminants = new Map(Object.entries(layout.discriminants))
    const labels = new Map<string, { discriminant: number; payload: Layout }>()
    const variants = new Map<number, { label: string; payload: Layout }>()
    for (const member of ast.types) {
      if (
        member._tag !== "Objects" ||
        member.context?.isOptional ||
        descriptor(member) !== undefined
      )
        throw new Error(
          `${path}: Enum variants must be required objects without layout annotations`,
        )
      const tag = member.propertySignatures.find((field) => field.name === layout.tag)?.type
      if (tag?._tag !== "Literal" || typeof tag.literal !== "string" || tag.context?.isOptional)
        throw new Error(`${path}: Enum tag must be a required string literal`)
      const label = tag.literal
      if (labels.has(label)) throw new Error(`${path}: Duplicate enum label ${label}`)
      const discriminant = discriminants.get(label)
      if (discriminant === undefined)
        throw new Error(`${path}: Missing enum discriminant for ${label}`)
      const payload = compileObject(member, path, compile, layout.tag)
      labels.set(label, { discriminant, payload })
      variants.set(discriminant, { label, payload })
    }
    if (labels.size !== Object.keys(layout.discriminants).length)
      throw new Error(`${path}: Extra enum discriminants`)
    const segment = `[${JSON.stringify(layout.tag)}]`
    return {
      minBytes: 1 + Math.min(...Array.from(labels.values(), (variant) => variant.payload.minBytes)),
      isZeroSized: false,
      read: (r) => {
        const offset = r.offset
        const tag = r.view(1).getUint8(0)
        const variant = variants.get(tag)
        if (variant === undefined) throw new BinaryError(offset, `Invalid enum tag ${tag}`)
        const value = variant.payload.read(r)
        Object.defineProperty(value, layout.tag, {
          value: variant.label,
          enumerable: true,
          writable: true,
          configurable: true,
        })
        return value
      },
      write: (w, value) => {
        if (typeof value !== "object" || value === null)
          throw new BinaryError(w.offset, "Expected enum object")
        const variant = at(segment, () => {
          const label = Object.hasOwn(value, layout.tag)
            ? Reflect.get(value, layout.tag)
            : undefined
          const variant = typeof label === "string" ? labels.get(label) : undefined
          if (variant === undefined) throw new BinaryError(w.offset, "Invalid enum label")
          return variant
        })
        w.view(1).setUint8(0, variant.discriminant)
        variant.payload.write(w, value)
      },
    }
  }
  if (
    ast._tag === "Declaration" &&
    representationId === "effect/schema/Option" &&
    layout === undefined
  ) {
    const inner = ast.typeParameters[0]
    if (ast.typeParameters.length !== 1 || inner === undefined)
      throw new Error(`${path}: Option requires exactly one encoded type parameter`)
    const item = compile(inner, `${path}["value"]`)
    return {
      minBytes: 1,
      isZeroSized: false,
      read: (r) => {
        const offset = r.offset
        const tag = r.view(1).getUint8(0)
        if (tag > 1) throw new BinaryError(offset, `Invalid Option tag ${tag}`)
        return tag === 0 ? Option.none() : Option.some(at('["value"]', () => item.read(r)))
      },
      write: (w, value) => {
        if (!Option.isOption(value)) throw new BinaryError(w.offset, "Expected Option")
        w.view(1).setUint8(0, Option.isSome(value) ? 1 : 0)
        if (Option.isSome(value)) at('["value"]', () => item.write(w, value.value))
      },
    }
  }
  if (
    ast._tag === "Declaration" &&
    representationId === "effect/schema/Result" &&
    layout === undefined
  ) {
    const [success, failure] = ast.typeParameters
    if (ast.typeParameters.length !== 2 || success === undefined || failure === undefined)
      throw new Error(`${path}: Result requires exactly two encoded type parameters`)
    const ok = compile(success, `${path}["success"]`)
    const err = compile(failure, `${path}["failure"]`)
    return {
      minBytes: 1 + Math.min(ok.minBytes, err.minBytes),
      isZeroSized: false,
      read: (r) => {
        const offset = r.offset
        const tag = r.view(1).getUint8(0)
        if (tag > 1) throw new BinaryError(offset, `Invalid Result tag ${tag}`)
        return tag === 1
          ? Result.succeed(at('["success"]', () => ok.read(r)))
          : Result.fail(at('["failure"]', () => err.read(r)))
      },
      write: (w, value) => {
        if (!Result.isResult(value)) throw new BinaryError(w.offset, "Expected Result")
        w.view(1).setUint8(0, Result.isSuccess(value) ? 1 : 0)
        if (Result.isSuccess(value)) at('["success"]', () => ok.write(w, value.success))
        else at('["failure"]', () => err.write(w, value.failure))
      },
    }
  }
  if (layout?.kind === "fixedArray") {
    const rest = ast._tag === "Arrays" ? ast.rest[0] : undefined
    if (ast._tag !== "Arrays" || ast.elements.length || ast.rest.length !== 1 || !rest)
      throw new Error(`${path}: Fixed array layout requires a homogeneous encoded array`)
    const item = compile(rest, `${path}[]`)
    const length = layout.length
    const minBytes = length === 0 ? 0 : Math.min(Number.MAX_SAFE_INTEGER, length * item.minBytes)
    return {
      minBytes,
      isZeroSized: length === 0 || item.isZeroSized,
      read: (r) => {
        if (minBytes > r.input.byteLength - r.offset)
          throw new BinaryError(r.offset, "Truncated fixed array payload")
        const value: unknown[] = []
        for (let i = 0; i < length; i++) value.push(at(`[${i}]`, () => item.read(r)))
        return value
      },
      write: (w, value) => {
        if (!Array.isArray(value) || value.length !== length)
          throw new BinaryError(w.offset, `Expected fixed array of length ${length}`)
        w.ensure(minBytes)
        for (let i = 0; i < length; i++) at(`[${i}]`, () => item.write(w, value[i]))
      },
    }
  }
  if (layout !== undefined)
    throw new Error(`${path}: Borsh layout does not match encoded ${ast._tag}`)
  switch (ast._tag) {
    case "String":
      return {
        compare: compareString,
        minBytes: 4,
        isZeroSized: false,
        read: (r) => {
          const bytes = r.take(r.u32())
          try {
            return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
          } catch {
            throw new BinaryError(r.offset - bytes.byteLength, "Invalid UTF-8")
          }
        },
        write: (w, value) => {
          if (typeof value !== "string") throw new BinaryError(w.offset, "Expected string")
          w.ensure(4)
          const length = utf8Length(value, w.maxBytes - w.offset - 4, w.offset)
          w.ensure(4 + length)
          w.u32(length)
          w.bytes(new TextEncoder().encode(value))
        },
      }
    case "Boolean":
      return {
        compare: comparePrimitive,
        minBytes: 1,
        isZeroSized: false,
        read: (r) => {
          const offset = r.offset
          const value = r.view(1).getUint8(0)
          if (value > 1) throw new BinaryError(offset, `Invalid bool tag ${value}`)
          return value === 1
        },
        write: (w, value) => {
          if (typeof value !== "boolean") throw new BinaryError(w.offset, "Expected boolean")
          w.view(1).setUint8(0, value ? 1 : 0)
        },
      }
    case "Objects": {
      return compileObject(ast, path, compile)
    }
    case "Arrays": {
      if (ast.rest.length === 0) {
        const items = ast.elements.map((item, i) => compile(item, `${path}[${i}]`))
        return {
          minBytes: items.reduce((sum, item) => sum + item.minBytes, 0),
          isZeroSized: items.every((item) => item.isZeroSized),
          read: (r) => items.map((item, i) => at(`[${i}]`, () => item.read(r))),
          write: (w, value) => {
            if (!Array.isArray(value) || value.length !== items.length)
              throw new BinaryError(w.offset, `Expected tuple of length ${items.length}`)
            items.forEach((item, i) => at(`[${i}]`, () => item.write(w, value[i])))
          },
        }
      }
      const rest = ast.rest[0]
      if (ast.elements.length || ast.rest.length !== 1 || rest === undefined)
        throw new Error(`${path}: Mixed tuple rests have no Borsh layout`)
      const item = compile(rest, `${path}[]`)
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
          const value: unknown[] = []
          for (let i = 0; i < count; i++) value.push(at(`[${i}]`, () => item.read(r)))
          return value
        },
        write: (w, value) => {
          checkItem(w.offset)
          if (!Array.isArray(value) || value.length > 0xffff_ffff)
            throw new BinaryError(w.offset, "Expected array with u32 length")
          w.u32(value.length)
          for (let i = 0; i < value.length; i++) at(`[${i}]`, () => item.write(w, value[i]))
        },
      }
    }
    case "Number":
    case "BigInt":
      throw new Error(
        `${path}: ${ast._tag} requires an explicit Borsh width; use a Borsh numeric schema`,
      )
  }
  throw new Error(`${path}: Unsupported encoded schema ${ast._tag}`)
}

function compileObject(
  ast: SchemaAST.Objects,
  path: string,
  compile: (ast: SchemaAST.AST, path: string) => Layout,
  omit?: string,
): Layout {
  if (ast.indexSignatures.length)
    throw new Error(`${path}: Index signatures have no Borsh struct layout`)
  const fields = ast.propertySignatures
    .filter((field) => field.name !== omit)
    .map((field) => {
      if (typeof field.name === "symbol")
        throw new Error(`${path}: Symbol keys have no Borsh struct layout`)
      const name = field.name
      const segment = `[${JSON.stringify(name)}]`
      return { name, segment, layout: compile(field.type, path + segment) }
    })
  return {
    minBytes: fields.reduce((sum, field) => sum + field.layout.minBytes, 0),
    isZeroSized: fields.every((field) => field.layout.isZeroSized),
    read: (r) => {
      const value: Record<PropertyKey, unknown> = {}
      for (const field of fields)
        Object.defineProperty(value, field.name, {
          value: at(field.segment, () => field.layout.read(r)),
          enumerable: true,
          writable: true,
          configurable: true,
        })
      return value
    },
    write: (w, value) => {
      if (fields.length === 0) return
      if (typeof value !== "object" || value === null)
        throw new BinaryError(w.offset, "Expected object")
      for (const field of fields)
        at(field.segment, () => {
          if (!Object.hasOwn(value, field.name))
            throw new BinaryError(w.offset, "Missing required field")
          field.layout.write(w, Reflect.get(value, field.name))
        })
    },
  }
}

function at<A>(segment: string, run: () => A): A {
  try {
    return run()
  } catch (error) {
    if (error instanceof BinaryError) throw error.prepend(segment)
    throw error
  }
}

interface CollectionAdapter {
  readonly arity: number
  get(
    value: unknown,
  ): { readonly size: number; readonly entries: Iterable<readonly [unknown, unknown]> } | undefined
  make(entries: [unknown, unknown][]): unknown
}
const readonlyMap: CollectionAdapter = {
  arity: 2,
  get: (value) => (value instanceof Map ? { size: value.size, entries: value } : undefined),
  make: (entries) => new Map(entries),
}
const readonlySet: CollectionAdapter = {
  arity: 1,
  get: (value) =>
    value instanceof Set ? { size: value.size, entries: value.entries() } : undefined,
  make: (entries) => new Set(entries.map(([key]) => key)),
}
const hashMap: CollectionAdapter = {
  arity: 2,
  get: (value) =>
    HashMap.isHashMap(value) ? { size: HashMap.size(value), entries: value } : undefined,
  make: HashMap.fromIterable,
}
const hashSet: CollectionAdapter = {
  arity: 1,
  get: (value) =>
    HashSet.isHashSet(value)
      ? {
          size: HashSet.size(value),
          entries: (function* () {
            for (const key of value) yield [key, key] as const
          })(),
        }
      : undefined,
  make: (entries) => HashSet.fromIterable(entries.map(([key]) => key)),
}
function comparePrimitive(a: unknown, b: unknown): number {
  if (
    (typeof a === "number" && typeof b === "number") ||
    (typeof a === "bigint" && typeof b === "bigint") ||
    (typeof a === "boolean" && typeof b === "boolean")
  )
    return a < b ? -1 : a > b ? 1 : 0
  throw new BinaryError(0, "Expected ordered primitive")
}
function compareString(a: unknown, b: unknown): number {
  if (typeof a !== "string" || typeof b !== "string")
    throw new BinaryError(0, "Expected string key")
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const x = a.charCodeAt(i++)
    const y = b.charCodeAt(j++)
    const left =
      x >= 0xd800 && x <= 0xdbff ? 0x10000 + ((x - 0xd800) << 10) + a.charCodeAt(i++) - 0xdc00 : x
    const right =
      y >= 0xd800 && y <= 0xdbff ? 0x10000 + ((y - 0xd800) << 10) + b.charCodeAt(j++) - 0xdc00 : y
    if (left !== right) return left < right ? -1 : 1
  }
  return a.length - b.length
}
