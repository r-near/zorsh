import type { BorshSchemaContainer } from "."

export class SchemaAnalyzer {
  private enumVariants = new Set<string>()
  private originalTypes = new Set<string>()

  findOriginalTypes(container: BorshSchemaContainer): string[] {
    console.log("All definition keys:", Array.from(container.definitions.keys()))

    // First collect all enum variants
    for (const [name, def] of container.definitions) {
      if ("Enum" in def && !name.startsWith("Option<")) {
        for (const variant of def.Enum.variants) {
          this.enumVariants.add(variant.declaration)
        }
      }
    }

    // Then find original types
    for (const [name, def] of container.definitions) {
      // Skip if it's an enum variant
      if (this.enumVariants.has(name)) {
        continue
      }

      // Skip synthetic/generated types
      if (
        name.includes("<") || // Vec<T>, HashMap<K,V>, etc
        name.startsWith("(") || // Tuples
        name.startsWith("Option<") || // Options
        name.match(/^[a-z][0-9]*$/) || // Primitives like u8, f32
        name === "String" || // Skip built-in String type
        "Sequence" in def || // Skip sequence types
        "Primitive" in def // Skip primitive types
      ) {
        continue
      }

      this.originalTypes.add(name)
    }

    const types = Array.from(this.originalTypes)
    console.log("Found original types:", types)
    return types
  }
}
