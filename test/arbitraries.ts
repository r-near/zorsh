/**
 * fast-check arbitraries derived from a schema, in the spirit of pyborsh's
 * hypothesis strategies: `arbitraryFor(schema)` walks the schema's type tree
 * (the same `type`/`options` shape the registry handlers consume) and yields
 * valid values for it, so any schema gets property tests for free.
 *
 * Collections stay small: the properties under test are structural (framing,
 * ordering, error contracts), not about bulk data.
 */

import fc from "fast-check"
import { registry } from "../src/registry"
import { Schema } from "../src/schema"

const MAX_COLLECTION_SIZE = 4
const MAX_STRING_LENGTH = 6
const MAX_BYTES_LENGTH = 6

interface ElementOptions {
  elementType: string
  elementOptions: unknown
  length?: number
}

interface MapOptions {
  keyType: string
  keyOptions: unknown
  valueType: string
  valueOptions: unknown
}

interface StructFields {
  [field: string]: { type: string; options: unknown }
}

interface EnumOptions {
  variants: { index: number; name: string; type: string; options: unknown }[]
}

interface NativeEnumOptions {
  indexToValueMap: Map<number, string | number>
}

type TupleTypes = { type: string; options: unknown }[]

/** An arbitrary producing valid values for `schema`. */
export function arbitraryFor<T>(schema: Schema<T>): fc.Arbitrary<T> {
  return arbitraryForType(schema.type, schema.options) as fc.Arbitrary<T>
}

/**
 * Structural identity of a value: the hex of its own serialization. Generated
 * set elements and map keys are kept distinct by it, since a Borsh collection
 * cannot hold two entries that encode identically.
 */
function serializedHex(type: string, options: unknown): (value: unknown) => string {
  const schema = new Schema<unknown>(type, options, registry)
  return (value) =>
    Array.from(schema.serialize(value), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function arbitraryForType(type: string, options: unknown): fc.Arbitrary<unknown> {
  switch (type) {
    case "u8":
      return fc.integer({ min: 0, max: 0xff })
    case "u16":
      return fc.integer({ min: 0, max: 0xffff })
    case "u32":
      return fc.integer({ min: 0, max: 0xffffffff })
    case "u64":
      return fc.bigInt({ min: 0n, max: (1n << 64n) - 1n })
    case "u128":
      return fc.bigInt({ min: 0n, max: (1n << 128n) - 1n })
    case "i8":
      return fc.integer({ min: -0x80, max: 0x7f })
    case "i16":
      return fc.integer({ min: -0x8000, max: 0x7fff })
    case "i32":
      return fc.integer({ min: -0x80000000, max: 0x7fffffff })
    case "i64":
      return fc.bigInt({ min: -(1n << 63n), max: (1n << 63n) - 1n })
    case "i128":
      return fc.bigInt({ min: -(1n << 127n), max: (1n << 127n) - 1n })
    // NaN is rejected by the writer, and -0 is excluded so round-trips can be
    // compared with `toEqual`, which distinguishes it from 0.
    case "f32":
      return fc.float({ noNaN: true }).filter((value) => !Object.is(value, -0))
    case "f64":
      return fc.double({ noNaN: true }).filter((value) => !Object.is(value, -0))
    case "bool":
      return fc.boolean()
    // "binary" draws from every code point, including those outside the BMP,
    // whose UTF-8 order differs from their UTF-16 code-unit order.
    case "string":
      return fc.string({ unit: "binary", maxLength: MAX_STRING_LENGTH })
    case "unit":
      return fc.constant({})
    case "bytes": {
      const { length } = options as { length?: number }
      return length != null
        ? fc.uint8Array({ minLength: length, maxLength: length })
        : fc.uint8Array({ maxLength: MAX_BYTES_LENGTH })
    }
    case "vec": {
      const { elementType, elementOptions } = options as ElementOptions
      return fc.array(arbitraryForType(elementType, elementOptions), {
        maxLength: MAX_COLLECTION_SIZE,
      })
    }
    case "array": {
      const { elementType, elementOptions, length } = options as Required<ElementOptions>
      return fc.array(arbitraryForType(elementType, elementOptions), {
        minLength: length,
        maxLength: length,
      })
    }
    case "option": {
      const { valueType, valueOptions } = options as { valueType: string; valueOptions: unknown }
      return fc.oneof(fc.constant(null), arbitraryForType(valueType, valueOptions))
    }
    case "set": {
      const { elementType, elementOptions } = options as ElementOptions
      return fc
        .uniqueArray(arbitraryForType(elementType, elementOptions), {
          selector: serializedHex(elementType, elementOptions),
          maxLength: MAX_COLLECTION_SIZE,
        })
        .map((items) => new Set(items))
    }
    case "map": {
      const { keyType, keyOptions, valueType, valueOptions } = options as MapOptions
      const keyIdentity = serializedHex(keyType, keyOptions)
      return fc
        .uniqueArray(
          fc.tuple(
            arbitraryForType(keyType, keyOptions),
            arbitraryForType(valueType, valueOptions),
          ),
          { selector: ([key]) => keyIdentity(key), maxLength: MAX_COLLECTION_SIZE },
        )
        .map((entries) => new Map(entries))
    }
    case "struct": {
      const fields = options as StructFields
      return fc.record(
        Object.fromEntries(
          Object.entries(fields).map(([name, def]) => [
            name,
            arbitraryForType(def.type, def.options),
          ]),
        ),
      )
    }
    case "enum": {
      const { variants } = options as EnumOptions
      return fc.oneof(
        ...variants.map((variant) =>
          variant.type === "unit"
            ? fc.constant({ [variant.name]: {} })
            : arbitraryForType(variant.type, variant.options).map((payload) => ({
                [variant.name]: payload,
              })),
        ),
      )
    }
    case "tuple": {
      const types = options as TupleTypes
      return fc.tuple(...types.map((element) => arbitraryForType(element.type, element.options)))
    }
    case "nativeEnum": {
      const { indexToValueMap } = options as NativeEnumOptions
      return fc.constantFrom(...indexToValueMap.values())
    }
    default:
      throw new Error(`No arbitrary for schema type: ${type}`)
  }
}
