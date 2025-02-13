import type { BorshSchemaContainer, Definition, DefinitionEnum, DefinitionStruct } from "."
import { DependencyResolver, SchemaAnalyzer, TypeParser } from "."

class CodeGenerator {
  generate(container: BorshSchemaContainer, sortedTypes: string[]): string {
    const output: string[] = ['import { b } from "zorsh";\n']

    for (const type of sortedTypes) {
      const def = container.definitions.get(type)
      if (!def) continue

      const schema = this.generateTypeSchema(type, def, container)
      output.push(schema)
    }

    return output.join("\n\n")
  }

  private generateTypeSchema(
    name: string,
    def: Definition,
    container: BorshSchemaContainer,
  ): string {
    let schema: string
    if ("Struct" in def) {
      schema = this.generateStructSchema(name, def.Struct)
    } else if ("Enum" in def) {
      schema = this.generateEnumSchema(name, def.Enum, container)
    } else {
      throw new Error(`Unknown definition type for ${name}`)
    }

    return `${schema}\nexport type ${name} = b.infer<typeof ${name}Schema>;`
  }

  private generateStructSchema(name: string, struct: NonNullable<DefinitionStruct>): string {
    const fields: string[] = []

    if ("NamedFields" in struct.fields) {
      for (const field of struct.fields.NamedFields) {
        fields.push(`  ${field.name}: ${this.generateTypeReference(field.declaration)}`)
      }
    }

    return `export const ${name}Schema = b.struct({\n${fields.join(",\n")}\n});`
  }

  private generateEnumSchema(
    name: string,
    enum_: NonNullable<DefinitionEnum>,
    container: BorshSchemaContainer,
  ): string {
    const variants: string[] = []

    for (const variant of enum_.variants) {
      const variantDef = container.definitions.get(variant.declaration)
      let variantSchema: string

      if (!variantDef || variant.declaration === "()") {
        variantSchema = "b.unit()"
      } else if ("Struct" in variantDef) {
        if ("UnnamedFields" in variantDef.Struct.fields) {
          // For tuple variants, use the inner type directly
          variantSchema = this.generateTypeReference(
            variantDef.Struct.fields.UnnamedFields[0] ?? "()",
          )
        } else if ("NamedFields" in variantDef.Struct.fields) {
          // For struct variants, create an inline struct
          const fields = variantDef.Struct.fields.NamedFields.map(
            (f) => `    ${f.name}: ${this.generateTypeReference(f.declaration)}`,
          ).join(",\n")
          variantSchema = `b.struct({\n${fields}\n  })`
        } else {
          variantSchema = "b.unit()"
        }
      } else {
        throw new Error(`Unknown variant type for ${variant.name}`)
      }

      variants.push(`  ${variant.name}: ${variantSchema}`)
    }

    return `export const ${name}Schema = b.enum({\n${variants.join(",\n")}\n});`
  }

  private generateTypeReference(type: string): string {
    const parser = new TypeParser()
    return parser.parse(type)
  }
}

export class ZorshGenerator {
  generate(container: BorshSchemaContainer): string {
    const analyzer = new SchemaAnalyzer()
    const originalTypes = analyzer.findOriginalTypes(container)

    const resolver = new DependencyResolver(originalTypes)
    const sortedTypes = resolver.buildDependencyGraph(container)

    const generator = new CodeGenerator()
    return generator.generate(container, sortedTypes)
  }
}
