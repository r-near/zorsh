import type { Schema } from "./schema"

/**
 * Maps primitive schema types to their TypedArray types
 */
type TypedArrayMap = {
  u8: Uint8Array
  u16: Uint16Array
  u32: Uint32Array
  i8: Int8Array
  i16: Int16Array
  i32: Int32Array
  i64: BigInt64Array
  f32: Float32Array
  f64: Float64Array
}

type NumericTypes = keyof TypedArrayMap
export type TypedArrayType = TypedArrayMap[NumericTypes]

/**
 * Helper type to determine if a schema should use a TypedArray
 */
export type IsTypedArraySchema<T> = T extends Schema<unknown, NumericTypes> ? true : false

/**
 * Maps schema types to their appropriate array types
 */
export type VecType<T> = T extends Schema<unknown, infer Type>
  ? Type extends keyof TypedArrayMap
    ? TypedArrayMap[Type]
    : Array<TypeOf<T>>
  : never

/**
 * Extracts the inner type from a Schema
 */
export type TypeOf<T extends Schema<unknown, string>> = T extends Schema<infer U, string>
  ? U
  : never
