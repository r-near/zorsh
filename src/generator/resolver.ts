import type { BorshSchemaContainer, Definition } from "."

export class DependencyResolver {
  private dependencies = new Map<string, Set<string>>()
  private originalTypes: Set<string>

  constructor(originalTypes: string[]) {
    this.originalTypes = new Set(originalTypes)
  }

  buildDependencyGraph(container: BorshSchemaContainer): string[] {
    // Build dependencies for each original type
    for (const type of this.originalTypes) {
      const def = container.definitions.get(type)
      if (!def) continue

      const deps = this.collectDependencies(def, container)
      this.dependencies.set(type, deps)
    }

    const sorted = this.topologicalSort()
    console.log("Sorted dependencies:", sorted)
    return sorted
  }

  private collectDependencies(def: Definition, container: BorshSchemaContainer): Set<string> {
    const deps = new Set<string>()

    if ("Struct" in def) {
      const structDef = def.Struct
      if ("NamedFields" in structDef.fields) {
        for (const field of structDef.fields.NamedFields) {
          this.addDependency(field.declaration, deps)
        }
      } else if ("UnnamedFields" in structDef.fields) {
        for (const field of structDef.fields.UnnamedFields) {
          this.addDependency(field, deps)
        }
      }
    }

    // Handle enum variants
    if ("Enum" in def) {
      for (const variant of def.Enum.variants) {
        if (variant.declaration !== "()") {
          // Skip unit variants
          const variantDef = container.definitions.get(variant.declaration)
          if (variantDef) {
            const variantDeps = this.collectDependencies(variantDef, container)
            for (const dep of variantDeps) {
              deps.add(dep)
            }
          }
        }
      }
    }

    return deps
  }

  private addDependency(type: string, deps: Set<string>) {
    // Strip out generic wrappers
    const baseType = type.replace(/^(Vec<|HashMap<|HashSet<|Option<)/, "").replace(/>$/, "")

    // If it's a primitive type or not an original type, skip it
    if (!this.originalTypes.has(baseType)) {
      return
    }

    deps.add(baseType)
  }

  private topologicalSort(): string[] {
    const sorted: string[] = []
    const visited = new Set<string>()
    const temp = new Set<string>()

    const visit = (node: string) => {
      if (temp.has(node)) {
        throw new Error(`Circular dependency found: ${node}`)
      }
      if (visited.has(node)) {
        return
      }
      temp.add(node)

      const nodeDeps = this.dependencies.get(node) || new Set()
      for (const dep of nodeDeps) {
        visit(dep)
      }

      temp.delete(node)
      visited.add(node)
      sorted.push(node)
    }

    for (const node of this.originalTypes) {
      if (!visited.has(node)) {
        visit(node)
      }
    }

    return sorted
  }
}
