import { BinaryReader, BinaryWriter } from "./binary-io"
import { type TypeRegistry, registry } from "./registry"
import type { VecType } from "./types"

export class Schema<T, Type extends string = string> {
  constructor(
    public readonly type: Type,
    public readonly options: unknown,
    private registry: TypeRegistry,
  ) {}

  serialize(value: T): Uint8Array {
    const writer = new BinaryWriter()
    const handler = this.registry.getHandler<T>(this.type)
    handler.write(writer, value, this.options)
    return writer.getBuffer()
  }

  deserialize(buffer: Uint8Array): T {
    const reader = new BinaryReader(buffer)
    const handler = this.registry.getHandler<T>(this.type)
    return handler.read(reader, this.options)
  }
}

// First declare the namespace type (for type-level stuff)
export namespace b {
  export type infer<T extends Schema<unknown>> = T extends Schema<infer U> ? U : never
}

// Builder API
export const b = {
  // Primitive types

  // Unsigned integers
  u8: () => new Schema<number, "u8">("u8", null, registry),
  u16: () => new Schema<number, "u16">("u16", null, registry),
  u32: () => new Schema<number, "u32">("u32", null, registry),
  u64: () => new Schema<bigint, "u64">("u64", null, registry),
  u128: () => new Schema<bigint, "u128">("u128", null, registry),

  // Signed integers
  i8: () => new Schema<number, "i8">("i8", null, registry),
  i16: () => new Schema<number, "i16">("i16", null, registry),
  i32: () => new Schema<number, "i32">("i32", null, registry),
  i64: () => new Schema<bigint, "i64">("i64", null, registry),
  i128: () => new Schema<bigint, "i128">("i128", null, registry),

  // Floating point
  f32: () => new Schema<number, "f32">("f32", null, registry),
  f64: () => new Schema<number, "f64">("f64", null, registry),

  // Other primitives
  string: () => new Schema<string, "string">("string", null, registry),
  unit: () => new Schema<Record<string, never>, "unit">("unit", null, registry),

  // Complex container types
  vec: <T extends Schema<unknown>>(elementSchema: T): Schema<VecType<T>> => {
    return new Schema(
      "vec",
      {
        elementType: elementSchema.type,
        elementOptions: elementSchema.options,
      },
      registry,
    )
  },

  hashSet: <T>(elementSchema: Schema<T>): Schema<Set<T>> => {
    return new Schema(
      "set",
      {
        elementType: elementSchema.type,
        elementOptions: elementSchema.options,
      },
      registry,
    )
  },

  hashMap: <K, V>(keySchema: Schema<K>, valueSchema: Schema<V>): Schema<Map<K, V>> => {
    return new Schema(
      "map",
      {
        keyType: keySchema.type,
        keyOptions: keySchema.options,
        valueType: valueSchema.type,
        valueOptions: valueSchema.options,
      },
      registry,
    )
  },

  option: <T>(valueSchema: Schema<T>): Schema<T | null> => {
    return new Schema(
      "option",
      {
        valueType: valueSchema.type,
        valueOptions: valueSchema.options,
      },
      registry,
    )
  },

  array: <T>(elementSchema: Schema<T>, length: number): Schema<T[]> => {
    return new Schema(
      "array",
      {
        elementType: elementSchema.type,
        elementOptions: elementSchema.options,
        length,
      },
      registry,
    )
  },

  // Enum type
  enum: <T extends Record<string, Schema<unknown>>>(
    variants: T,
  ): Schema<
    {
      [K in keyof T]: { [KK in K]: T[K] extends Schema<infer U> ? U : never }
    }[keyof T]
  > => {
    // Convert variants to array format with indices
    const variantArray = Object.entries(variants).map(([name, schema], index) => ({
      index,
      name,
      type: schema.type,
      options: schema.options,
    }))

    return new Schema("enum", { variants: variantArray }, registry)
  },

  // Complex types
  struct: <T extends Record<string, Schema<unknown>>>(
    fields: T,
  ): Schema<{ [K in keyof T]: T[K] extends Schema<infer U> ? U : never }> => {
    const fieldDefs = Object.fromEntries(
      Object.entries(fields).map(([key, schema]) => [
        key,
        { type: schema.type, options: schema.options },
      ]),
    )
    return new Schema("struct", fieldDefs, registry)
  },
}
