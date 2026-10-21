import { HashMap, HashSet, Option, Order, Result, SchemaAST } from "effect"
import { descriptor, type EnumDescriptor } from "./annotations.js"
import { BinaryError, prepend, Reader, utf8Length, Writer } from "./io.js"

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
    return {
      compare: comparePrimitive,
      minBytes: bits / 8,
      isZeroSized: false,
      ...integer(bits, signed),
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
        const offset = r.advance(bits / 8)
        const value =
          bits === 32 ? r.view.getFloat32(offset, true) : r.view.getFloat64(offset, true)
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
        const offset = w.advance(bits / 8)
        if (bits === 32) w.view.setFloat32(offset, value, true)
        else w.view.setFloat64(offset, value, true)
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
          let i = 0
          let part = "key"
          try {
            for (; i < count; i++) {
              const offset = r.offset
              part = "key"
              const key = keyLayout.read(r)
              if (i > 0) ordered(entries[i - 1]?.[0], key, offset)
              part = "value"
              entries.push([key, valueLayout === undefined ? undefined : valueLayout.read(r)])
            }
          } catch (error) {
            throw prepend(prepend(error, part), i)
          }
          return adapter.make(entries)
        },
        write: (w, value) => {
          const collection = adapter.get(value)
          if (collection === undefined || collection.size > 0xffff_ffff)
            throw new BinaryError(w.offset, "Expected native collection with u32 length")
          w.ensure(4 + (collection.size === 0 ? 0 : collection.size * minimum))
          const entries = Array.from(collection.entries).sort(([a], [b]) => compare(a, b))
          w.u32(entries.length)
          let i = 0
          let part = "key"
          try {
            for (const [key, value] of entries) {
              part = "key"
              if (i > 0) ordered(entries[i - 1]?.[0], key, w.offset)
              keyLayout.write(w, key)
              part = "value"
              if (valueLayout !== undefined) valueLayout.write(w, value)
              i++
            }
          } catch (error) {
            throw prepend(prepend(error, part), i)
          }
        },
      }
    }
  }
  if (
    layout?.kind === "enum" ||
    (layout === undefined && (ast._tag === "Union" || ast._tag === "Enum"))
  )
    return compileEnum(ast, layout, path, compile)
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
        return readItems(r, item, length)
      },
      write: (w, value) => {
        if (!Array.isArray(value) || value.length !== length)
          throw new BinaryError(w.offset, `Expected fixed array of length ${length}`)
        w.ensure(minBytes)
        writeItems(w, item, value)
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
        read: (r) => r.string(r.u32()),
        write: (w, value) => {
          if (typeof value !== "string") throw new BinaryError(w.offset, "Expected string")
          w.ensure(4)
          const length = utf8Length(value, w.maxBytes - w.offset - 4, w.offset)
          w.ensure(4 + length)
          w.u32(length)
          w.string(value, length)
        },
      }
    case "Boolean":
      return {
        compare: comparePrimitive,
        minBytes: 1,
        isZeroSized: false,
        read: (r) => {
          const offset = r.offset
          const value = r.u8()
          if (value > 1) throw new BinaryError(offset, `Invalid bool tag ${value}`)
          return value === 1
        },
        write: (w, value) => {
          if (typeof value !== "boolean") throw new BinaryError(w.offset, "Expected boolean")
          w.u8(value ? 1 : 0)
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
    case "Number":
    case "BigInt":
      throw new Error(
        `${path}: ${ast._tag} requires an explicit Borsh width; use a Borsh numeric schema`,
      )
  }
  if (ast._tag === "Literal")
    throw new Error(
      `${path}: Unsupported encoded schema Literal; use Schema.Literals or a tagged union for a Rust enum`,
    )
  throw new Error(`${path}: Unsupported encoded schema ${ast._tag}`)
}

export interface EnumVariant {
  readonly label: string
  readonly discriminant: number
  readonly value?: unknown
  readonly member?: SchemaAST.Objects
}

/** Read Rust enum variants with declaration-order or explicit discriminants. */
export function enumVariants(
  ast: SchemaAST.AST,
  layout: EnumDescriptor | undefined,
  path: string,
): ReadonlyArray<EnumVariant> {
  const tag = layout === undefined ? "_tag" : layout.tag
  const explicit =
    "pass the Rust wire discriminants (declaration indices unless #[borsh(use_discriminant = true)]) to Borsh.discriminants"
  const objects =
    ast._tag === "Union" && ast.types.length > 0 && ast.types.every(SchemaAST.isObjects)
  const required = (member: SchemaAST.AST) => {
    if (member.context?.isOptional || descriptor(member) !== undefined)
      throw new Error(`${path}: Enum variants must be required and have no layout annotations`)
  }
  let variants: ReadonlyArray<Omit<EnumVariant, "discriminant">>
  if (objects) {
    variants = ast.types.map((member) => {
      required(member)
      const field = member.propertySignatures.find((field) => field.name === tag)?.type
      if (
        field?._tag !== "Literal" ||
        typeof field.literal !== "string" ||
        field.context?.isOptional
      )
        throw new Error(
          `${path}: Enum tag ${JSON.stringify(tag)} must be a required string literal; set another key with Borsh.discriminants(map, { tag })`,
        )
      return { label: field.literal, member }
    })
  } else if (ast._tag === "Union" && ast.types.every(SchemaAST.isLiteral)) {
    variants = ast.types.map((member) => {
      required(member)
      return { label: String(member.literal), value: member.literal }
    })
    if (layout === undefined && variants.some((variant) => typeof variant.value !== "string"))
      throw new Error(`${path}: Non-string literal enums have no Rust variant order; ${explicit}`)
  } else if (ast._tag === "Enum") {
    variants = ast.enums.map(([label, value]) => ({ label, value }))
    if (new Set(variants.map((variant) => typeof variant.value)).size > 1)
      throw new Error(`${path}: Mixed string and numeric enums are unsupported`)
    if (new Set(variants.map((variant) => variant.value)).size !== variants.length)
      throw new Error(`${path}: Duplicate enum values have no Borsh layout`)
    if (
      layout === undefined &&
      variants.some((variant, i) => typeof variant.value === "number" && variant.value !== i)
    )
      throw new Error(
        `${path}: Numeric enum values must be 0..n-1 in declaration order; ${explicit}`,
      )
  } else if (ast._tag === "Union" && layout === undefined) {
    throw new Error(
      `${path}: Union has no Borsh layout; use Schema.Option for nullable values, or a tagged union, Schema.Literals or Schema.Enum for Rust enums`,
    )
  } else {
    throw new Error(`${path}: Enum layout requires a tagged union, literal union or Schema.Enum`)
  }
  if (variants.length < 1 || variants.length > 256)
    throw new Error(`${path}: Enums require 1 through 256 variants`)
  if (!objects && tag !== "_tag")
    throw new Error(`${path}: Only object enum variants have a tag key`)
  const labels = new Set<string>()
  for (const { label } of variants) {
    if (labels.has(label)) throw new Error(`${path}: Duplicate enum label ${label}`)
    labels.add(label)
  }
  if (layout === undefined)
    return variants.map((variant, discriminant) => ({ ...variant, discriminant }))
  const discriminants = new Map(Object.entries(layout.discriminants))
  const extra = [...discriminants.keys()].filter((label) => !labels.has(label))
  if (extra.length > 0) throw new Error(`${path}: Unknown enum discriminants ${extra.join(", ")}`)
  return variants.map((variant) => {
    const discriminant = discriminants.get(variant.label)
    if (discriminant === undefined)
      throw new Error(`${path}: Missing enum discriminant for ${variant.label}`)
    return { ...variant, discriminant }
  })
}

function compileEnum(
  ast: SchemaAST.AST,
  layout: EnumDescriptor | undefined,
  path: string,
  compile: (ast: SchemaAST.AST, path: string) => Layout,
): Layout {
  const tag = layout === undefined ? "_tag" : layout.tag
  const variants = enumVariants(ast, layout, path)
  const select = <V extends EnumVariant>(variants: ReadonlyArray<V>) => {
    const byDiscriminant = new Map(variants.map((variant) => [variant.discriminant, variant]))
    return (r: Reader) => {
      const offset = r.offset
      const discriminant = r.u8()
      const variant = byDiscriminant.get(discriminant)
      if (variant === undefined) throw new BinaryError(offset, `Invalid enum tag ${discriminant}`)
      return variant
    }
  }
  const objects = variants.flatMap(({ member, ...variant }) =>
    member === undefined
      ? []
      : [{ ...variant, payload: compileObject(member, path, compile, tag) }],
  )
  // A default-discriminant enum with one dataless variant is a Rust ZST; explicit maps imply repr(u8).
  const isZeroSized =
    layout === undefined &&
    variants.length === 1 &&
    objects.every((variant) => variant.payload.isZeroSized)
  if (objects.length === 0) {
    const read = select(variants)
    const byValue = new Map(variants.map((variant) => [variant.value, variant.discriminant]))
    return {
      minBytes: 1,
      isZeroSized,
      read: (r) => read(r).value,
      write: (w, value) => {
        const discriminant = byValue.get(value)
        if (discriminant === undefined) throw new BinaryError(w.offset, "Invalid enum value")
        w.u8(discriminant)
      },
    }
  }
  const read = select(objects)
  const byLabel = new Map(objects.map((variant) => [variant.label, variant]))
  return {
    minBytes: 1 + Math.min(...objects.map((variant) => variant.payload.minBytes)),
    isZeroSized,
    read: (r) => {
      const variant = read(r)
      const value = variant.payload.read(r)
      Object.defineProperty(value, tag, {
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
      const label = Object.hasOwn(value, tag) ? Reflect.get(value, tag) : undefined
      const variant = typeof label === "string" ? byLabel.get(label) : undefined
      if (variant === undefined) throw prepend(new BinaryError(w.offset, "Invalid enum label"), tag)
      w.u8(variant.discriminant)
      variant.payload.write(w, value)
    },
  }
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
      // Assignment would hit an inherited setter or a frozen inherited property.
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
          if (field.define)
            Object.defineProperty(value, name, {
              value: item,
              enumerable: true,
              writable: true,
              configurable: true,
            })
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

/** Native DataView access; 128-bit values are two little-endian 64-bit halves. */
function integer(bits: 8 | 16 | 32 | 64 | 128, signed: boolean): Pick<Layout, "read" | "write"> {
  const width = bits / 8
  const name = `${signed ? "i" : "u"}${bits}`
  if (bits <= 32) {
    const minimum = signed ? -(2 ** (bits - 1)) : 0
    const maximum = 2 ** (signed ? bits - 1 : bits) - 1
    return {
      read: (r) => {
        const offset = r.advance(width)
        const view = r.view
        if (bits === 8) return signed ? view.getInt8(offset) : view.getUint8(offset)
        if (bits === 16) return signed ? view.getInt16(offset, true) : view.getUint16(offset, true)
        return signed ? view.getInt32(offset, true) : view.getUint32(offset, true)
      },
      write: (w, value) => {
        if (typeof value !== "number" || !Number.isInteger(value))
          throw new BinaryError(w.offset, `Expected ${name}`)
        if (value < minimum || value > maximum)
          throw new BinaryError(w.offset, `Integer outside ${name} range`)
        // Unsigned setters wrap negative values to the same two's complement bytes.
        const offset = w.advance(width)
        if (bits === 8) w.view.setUint8(offset, value)
        else if (bits === 16) w.view.setUint16(offset, value, true)
        else w.view.setUint32(offset, value, true)
      },
    }
  }
  const minimum = signed ? -(1n << BigInt(bits - 1)) : 0n
  const maximum = (1n << BigInt(signed ? bits - 1 : bits)) - 1n
  return {
    read: (r) => {
      const offset = r.advance(width)
      const view = r.view
      if (bits === 64)
        return signed ? view.getBigInt64(offset, true) : view.getBigUint64(offset, true)
      const high = signed ? view.getBigInt64(offset + 8, true) : view.getBigUint64(offset + 8, true)
      return (high << 64n) | view.getBigUint64(offset, true)
    },
    write: (w, value) => {
      if (typeof value !== "bigint") throw new BinaryError(w.offset, `Expected ${name}`)
      if (value < minimum || value > maximum)
        throw new BinaryError(w.offset, `Integer outside ${name} range`)
      // BigUint64 setters take the value modulo 2^64, so signed halves need no special case.
      const offset = w.advance(width)
      w.view.setBigUint64(offset, value, true)
      if (bits === 128) w.view.setBigUint64(offset + 8, value >> 64n, true)
    },
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
  if (typeof a === "number" && typeof b === "number") return Order.Number(a, b)
  if (typeof a === "bigint" && typeof b === "bigint") return Order.BigInt(a, b)
  if (typeof a === "boolean" && typeof b === "boolean") return Order.Boolean(a, b)
  throw new BinaryError(0, "Expected ordered primitive")
}
function compareString(a: unknown, b: unknown): number {
  if (typeof a !== "string" || typeof b !== "string")
    throw new BinaryError(0, "Expected string key")
  let i = 0
  let j = 0
  for (
    let left = a.codePointAt(i), right = b.codePointAt(j);
    left !== undefined && right !== undefined;
    left = a.codePointAt(i), right = b.codePointAt(j)
  ) {
    if (left !== right) return left < right ? -1 : 1
    i += left > 0xffff ? 2 : 1
    j += right > 0xffff ? 2 : 1
  }
  return a.length - b.length
}
