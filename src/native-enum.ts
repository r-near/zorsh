import type { BinaryReader, BinaryWriter } from "./binary-io"
import { registry } from "./registry"
import { Schema } from "./schema"

interface NativeEnumOptions {
  indexMap: Map<number, string>
  valueMap: Map<string, number>
}

function createNativeEnumOptions<T extends Record<string, unknown>>(
  typescriptEnum: T,
): NativeEnumOptions {
  const indexMap = new Map<number, string>()
  const valueMap = new Map<string, number>()

  // Iterate over enum members to build reverse lookup maps.
  for (const key in typescriptEnum) {
    if (Number.isNaN(Number(key))) {
      // Filter out numeric keys (reverse mappings)
      const value = typescriptEnum[key] as number | string
      if (typeof value === "number") {
        indexMap.set(value, key)
        valueMap.set(key, value)
      }
    }
  }

  return { indexMap, valueMap }
}

export const nativeEnum = <T extends Record<string, string | number>>(
  typescriptEnum: T,
): Schema<keyof T, "nativeEnum"> => {
  const options = createNativeEnumOptions(typescriptEnum)
  return new Schema("nativeEnum", options, registry)
}

// Type handler for native enums
registry.register<string, NativeEnumOptions>("nativeEnum", {
  write: (writer: BinaryWriter, value: string, options?: NativeEnumOptions) => {
    if (!options) throw new Error("Missing options for nativeEnum")
    const index = options.valueMap.get(value)
    if (index === undefined) {
      throw new Error(`Invalid enum variant: ${value}`)
    }
    writer.writeUint8(index)
  },
  read: (reader: BinaryReader, options?: NativeEnumOptions) => {
    if (!options) throw new Error("Missing options for nativeEnum")
    const index = reader.readUint8()
    const variant = options.indexMap.get(index)
    if (variant === undefined) {
      throw new Error(`Invalid enum index: ${index}`)
    }
    return variant
  },
})
