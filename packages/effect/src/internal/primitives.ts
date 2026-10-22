import { Order } from "effect"
import type { Layout } from "./compiler.js"
import { BinaryError, utf8Length } from "./io.js"

type IntegerBits = 8 | 16 | 32 | 64 | 128

/** Rust's inclusive iN/uN bounds. */
export function integerRange(bits: IntegerBits, signed: boolean) {
  const minimum = signed ? -(1n << BigInt(bits - 1)) : 0n
  const maximum = (1n << BigInt(signed ? bits - 1 : bits)) - 1n
  return { minimum, maximum }
}

/** Native DataView access; up to 32 bits as a number, wider as a bigint. */
export function integer(bits: IntegerBits, signed: boolean): Layout {
  return bits <= 32 ? numberInteger(bits, signed) : bigintInteger(bits, signed)
}

function numberInteger(bits: IntegerBits, signed: boolean): Layout {
  const width = bits / 8
  const name = `${signed ? "i" : "u"}${bits}`
  const range = integerRange(bits, signed)
  const minimum = Number(range.minimum)
  const maximum = Number(range.maximum)
  return {
    compare: comparePrimitive,
    minBytes: width,
    isZeroSized: false,
    read: (r) => {
      const offset = r.advance(width)
      const view = r.view
      if (bits === 8) {
        return signed ? view.getInt8(offset) : view.getUint8(offset)
      }
      if (bits === 16) {
        return signed ? view.getInt16(offset, true) : view.getUint16(offset, true)
      }
      return signed ? view.getInt32(offset, true) : view.getUint32(offset, true)
    },
    write: (w, value) => {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new BinaryError(w.offset, `Expected ${name}`)
      }
      if (value < minimum || value > maximum) {
        throw new BinaryError(w.offset, `Integer outside ${name} range`)
      }
      // Unsigned setters wrap negative values to the same two's complement bytes.
      const offset = w.advance(width)
      if (bits === 8) {
        w.view.setUint8(offset, value)
      } else if (bits === 16) {
        w.view.setUint16(offset, value, true)
      } else {
        w.view.setUint32(offset, value, true)
      }
    },
  }
}

/** 64-bit values are one BigInt64; 128-bit values are two little-endian 64-bit halves. */
function bigintInteger(bits: IntegerBits, signed: boolean): Layout {
  const width = bits / 8
  const name = `${signed ? "i" : "u"}${bits}`
  const { minimum, maximum } = integerRange(bits, signed)
  return {
    compare: comparePrimitive,
    minBytes: width,
    isZeroSized: false,
    read: (r) => {
      const offset = r.advance(width)
      const view = r.view
      if (bits === 64) {
        return signed ? view.getBigInt64(offset, true) : view.getBigUint64(offset, true)
      }
      const high = signed ? view.getBigInt64(offset + 8, true) : view.getBigUint64(offset + 8, true)
      return (high << 64n) | view.getBigUint64(offset, true)
    },
    write: (w, value) => {
      if (typeof value !== "bigint") {
        throw new BinaryError(w.offset, `Expected ${name}`)
      }
      if (value < minimum || value > maximum) {
        throw new BinaryError(w.offset, `Integer outside ${name} range`)
      }
      // BigUint64 setters take the value modulo 2^64, so signed halves need no special case.
      const offset = w.advance(width)
      w.view.setBigUint64(offset, value, true)
      if (bits === 128) {
        w.view.setBigUint64(offset + 8, value >> 64n, true)
      }
    },
  }
}

export function float(bits: 32 | 64): Layout {
  return {
    minBytes: bits / 8,
    isZeroSized: false,
    read: (r) => {
      const offset = r.advance(bits / 8)
      const value = bits === 32 ? r.view.getFloat32(offset, true) : r.view.getFloat64(offset, true)
      if (Number.isNaN(value)) {
        throw new BinaryError(offset, "Borsh forbids NaN")
      }
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
      if (bits === 32) {
        w.view.setFloat32(offset, value, true)
      } else {
        w.view.setFloat64(offset, value, true)
      }
    },
  }
}

/** Rust Vec<u8> with a u32 length prefix, or [u8; N] when length is given. */
export function bytes(length?: number): Layout {
  return {
    minBytes: length ?? 4,
    isZeroSized: length === 0,
    read: (r) => r.take(length ?? r.u32()).slice(),
    write: (w, value) => {
      if (!(value instanceof Uint8Array)) {
        throw new BinaryError(w.offset, "Expected Uint8Array")
      }
      if (length !== undefined && value.byteLength !== length) {
        throw new BinaryError(w.offset, `Expected ${length} bytes`)
      }
      if (value.byteLength > 0xffff_ffff) {
        throw new BinaryError(w.offset, "Byte array exceeds u32 length")
      }
      // Reserve the prefix with the payload, so an oversized array fails at the prefix offset. Both
      // shapes reserve here, reading byteLength as often as the checks above expect.
      const prefixBytes = length === undefined ? 4 : 0
      w.ensure(value.byteLength + prefixBytes)
      if (length === undefined) {
        w.u32(value.byteLength)
      }
      w.bytes(value)
    },
  }
}

export function string(): Layout {
  return {
    compare: compareString,
    minBytes: 4,
    isZeroSized: false,
    read: (r) => r.string(r.u32()),
    write: (w, value) => {
      if (typeof value !== "string") {
        throw new BinaryError(w.offset, "Expected string")
      }
      // Check room for the prefix first, so fewer than 4 bytes left reports maxBytes rather than
      // the string budget.
      w.ensure(4)
      const length = utf8Length(value, w.maxBytes - w.offset - 4, w.offset)
      w.ensure(4 + length)
      w.u32(length)
      w.string(value, length)
    },
  }
}

export function boolean(): Layout {
  return {
    compare: comparePrimitive,
    minBytes: 1,
    isZeroSized: false,
    read: (r) => {
      const offset = r.offset
      const value = r.u8()
      if (value > 1) {
        throw new BinaryError(offset, `Invalid bool tag ${value}`)
      }
      return value === 1
    },
    write: (w, value) => {
      if (typeof value !== "boolean") {
        throw new BinaryError(w.offset, "Expected boolean")
      }
      w.u8(value ? 1 : 0)
    },
  }
}

function comparePrimitive(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") {
    return Order.Number(a, b)
  }
  if (typeof a === "bigint" && typeof b === "bigint") {
    return Order.BigInt(a, b)
  }
  if (typeof a === "boolean" && typeof b === "boolean") {
    return Order.Boolean(a, b)
  }
  throw new BinaryError(0, "Expected ordered primitive")
}

/** Rust orders str by UTF-8 bytes, which is Unicode scalar order rather than UTF-16 order. */
function compareString(a: unknown, b: unknown): number {
  if (typeof a !== "string" || typeof b !== "string") {
    throw new BinaryError(0, "Expected string key")
  }
  // One index serves both strings: it only moves past equal code points, which have equal width.
  let i = 0
  while (i < a.length && i < b.length) {
    const left = a.codePointAt(i) as number
    const right = b.codePointAt(i) as number
    if (left !== right) {
      return left < right ? -1 : 1
    }
    i += left > 0xffff ? 2 : 1
  }
  // One string is a prefix of the other, so the shorter sorts first.
  return a.length - b.length
}
