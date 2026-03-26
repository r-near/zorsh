import type { Schema } from "./schema"

/**
 * Maps schema types to their appropriate array types
 */
export type VecType<T> = T extends Schema<unknown, string> ? Array<TypeOf<T>> : never

/**
 * Extracts the inner type from a Schema
 */
export type TypeOf<T extends Schema<unknown, string>> = T extends Schema<infer U, string>
  ? U
  : never

/**
 * Represents a TypeScript enum type.
 * This interface is used for type constraints in the nativeEnum function.
 */
export interface EnumLike {
  [key: string]: string | number
  [numericKey: number]: string
}
