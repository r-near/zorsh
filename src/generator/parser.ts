// Define what we know about types in a declarative way
const knownTypes = {
  // Built-in types map directly to builder methods
  primitives: {
    String: "b.string()",
    "()": "b.unit()",
  },

  // Generic types and how to build them
  generics: {
    Vec: (arg: string) => `b.vec(${arg})`,
    HashMap: (key: string, value: string) => `b.hashMap(${key}, ${value})`,
    HashSet: (arg: string) => `b.hashSet(${arg})`,
    Option: (arg: string) => `b.option(${arg})`,
  },
} as const

export class TypeParser {
  parse(input: string) {
    // Clean up the input
    const cleanInput = input.trim()

    // Handle the three cases we can see
    if (this.looksLikeATuple(cleanInput)) {
      return this.parseTuple(cleanInput)
    }
    if (this.looksLikeAGeneric(cleanInput)) {
      return this.parseGeneric(cleanInput)
    }
    return this.parsePrimitive(cleanInput)
  }

  private looksLikeATuple(input: string) {
    return input.startsWith("(") && input.endsWith(")")
  }

  private looksLikeAGeneric(input: string) {
    return input.includes("<") && input.endsWith(">")
  }

  private parseTuple(input: string): string {
    // Remove outer parentheses and split by comma
    const inner = input.slice(1, -1)
    const elements = this.splitTopLevel(inner, ",")

    // Parse each element and combine
    const parsed = elements.map((element) => this.parse(element))
    return `b.tuple([${parsed.join(", ")}])`
  }

  private parseGeneric(input: string): string {
    // Split into base type and args
    const baseType = input.slice(0, input.indexOf("<"))
    const argsString = input.slice(input.indexOf("<") + 1, -1)

    // Get the builder for this generic type
    const builder = knownTypes.generics[baseType as keyof typeof knownTypes.generics]
    if (!builder) {
      throw new Error(`Unknown generic type: ${baseType}`)
    }

    // Parse the arguments and build
    const args = this.splitTopLevel(argsString, ",")
    const parsedArgs = args.map((arg) => this.parse(arg))

    // @ts-ignore - We know the builder functions accept the correct number of arguments at runtime
    return builder(...parsedArgs)
  }

  private parsePrimitive(input: string): string {
    // Check if it's a known primitive
    if (input in knownTypes.primitives) {
      return knownTypes.primitives[input as keyof typeof knownTypes.primitives]
    }

    // Handle numeric types
    if (input.match(/^[ui][0-9]+$/) || input.match(/^f[0-9]+$/)) {
      return `b.${input}()`
    }

    // Must be a custom type
    return `${input}Schema`
  }

  // Helper to split by delimiter while respecting nested structures
  private splitTopLevel(input: string, delimiter: string): string[] {
    const results: string[] = []
    let current = ""
    let depth = 0

    for (const char of input) {
      if (char === "(" || char === "<") depth++
      if (char === ")" || char === ">") depth--

      if (char === delimiter && depth === 0) {
        results.push(current.trim())
        current = ""
      } else {
        current += char
      }
    }

    if (current) {
      results.push(current.trim())
    }

    return results
  }
}
