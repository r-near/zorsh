import { SchemaAST } from "effect"
import { descriptor } from "./annotations.js"
import { BinaryError, Reader, utf8Length, Writer } from "./io.js"

export interface Layout {
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
  if (ast.context?.isOptional)
    throw new Error("$: Optional schemas need an explicit Borsh representation")
  const layout = descriptor(ast)
  if (layout?.kind === "integer") {
    const { bits, signed } = layout
    const bigint = bits > 32
    if (ast._tag !== (bigint ? "BigInt" : "Number"))
      throw new Error("$: Integer layout does not match encoded schema")
    const width = bits / 8
    const minimum = signed ? -(1n << BigInt(bits - 1)) : 0n
    const maximum = (1n << BigInt(signed ? bits - 1 : bits)) - 1n
    return {
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
    if (ast._tag !== "Number") throw new Error("$: Float layout does not match encoded schema")
    const bits = layout.bits
    return {
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
  if (
    ast._tag === "Declaration" &&
    typeof representation === "object" &&
    representation !== null &&
    "id" in representation &&
    representation.id === "effect/schema/Uint8Array"
  ) {
    const length = layout?.length
    return {
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
  if (layout !== undefined) throw new Error(`$: Borsh layout does not match encoded ${ast._tag}`)
  switch (ast._tag) {
    case "String":
      return {
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
    case "Arrays":
      if (ast.elements.length === 0 && ast.rest.length === 0) {
        return {
          read: () => [],
          write: (w, value) => {
            if (!Array.isArray(value) || value.length !== 0)
              throw new BinaryError(w.offset, "Expected empty tuple")
          },
        }
      }
      break
    case "Number":
    case "BigInt":
      throw new Error(`$: ${ast._tag} requires an explicit Borsh width; use a Borsh numeric schema`)
  }
  throw new Error(`$: Unsupported encoded schema ${ast._tag}; this slice supports primitives only`)
}
