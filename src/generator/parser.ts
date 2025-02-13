type Token =
  | { type: "identifier"; value: string }
  | { type: "comma" }
  | { type: "leftAngle" | "rightAngle" }
  | { type: "leftParen" | "rightParen" }

type TypeNode =
  | { type: "primitive"; name: string }
  | { type: "generic"; base: string; args: TypeNode[] }
  | { type: "tuple"; elements: TypeNode[] }

export class TypeParser {
  private tokens: Token[] = []
  private current = 0

  parse(typeStr: string): TypeNode {
    this.tokens = this.tokenize(typeStr)
    this.current = 0
    return this.parseType()
  }

  private tokenize(input: string): Token[] {
    const tokens: Token[] = []
    let current = 0

    while (current < input.length) {
      const char = input[current] ?? ""

      // Skip whitespace
      if (char === " " || char === "\n" || char === "\t" || char === "\r") {
        current++
        continue
      }

      // Handle special characters
      if (char === "<") {
        tokens.push({ type: "leftAngle" })
        current++
        continue
      }
      if (char === ">") {
        tokens.push({ type: "rightAngle" })
        current++
        continue
      }
      if (char === "(") {
        tokens.push({ type: "leftParen" })
        current++
        continue
      }
      if (char === ")") {
        tokens.push({ type: "rightParen" })
        current++
        continue
      }
      if (char === ",") {
        tokens.push({ type: "comma" })
        current++
        continue
      }

      // Parse identifiers
      if (/[A-Za-z0-9_]/.test(char)) {
        let value = ""
        while (current < input.length && /[A-Za-z0-9_]/.test(input[current] ?? "")) {
          value += input[current]
          current++
        }
        tokens.push({ type: "identifier", value })
        continue
      }

      throw new Error(`Unexpected character: ${char}`)
    }

    return tokens
  }

  private parseType(): TypeNode {
    const token = this.tokens[this.current]
    if (!token) throw new Error("Unexpected end of input")

    if (token.type === "identifier") {
      this.current++

      // Look ahead for generic arguments
      if (this.current < this.tokens.length && this.tokens[this.current]?.type === "leftAngle") {
        this.current++ // consume '<'
        const args = this.parseGenericArgs()
        return { type: "generic", base: token.value, args }
      }

      return { type: "primitive", name: token.value }
    }

    if (token.type === "leftParen") {
      this.current++
      const elements = this.parseTupleElements()
      return { type: "tuple", elements }
    }

    throw new Error(`Unexpected token: ${JSON.stringify(token)}`)
  }

  private parseGenericArgs(): TypeNode[] {
    const args: TypeNode[] = []

    while (this.current < this.tokens.length) {
      const arg = this.parseType()
      args.push(arg)

      const next = this.tokens[this.current]
      if (!next) throw new Error("Unexpected end of input in generic args")

      if (next.type === "rightAngle") {
        this.current++ // consume '>'
        break
      }

      if (next.type === "comma") {
        this.current++ // consume ','
        continue
      }

      throw new Error(`Unexpected token in generic args: ${JSON.stringify(next)}`)
    }

    return args
  }

  private parseTupleElements(): TypeNode[] {
    const elements: TypeNode[] = []

    while (this.current < this.tokens.length) {
      const element = this.parseType()
      elements.push(element)

      const next = this.tokens[this.current]
      if (!next) throw new Error("Unexpected end of input in tuple")

      if (next.type === "rightParen") {
        this.current++ // consume ')'
        break
      }

      if (next.type === "comma") {
        this.current++ // consume ','
        continue
      }

      throw new Error(`Unexpected token in tuple: ${JSON.stringify(next)}`)
    }

    return elements
  }

  generateZorshCode(node: TypeNode): string {
    switch (node.type) {
      case "primitive":
        if (node.name === "String") return "b.string()"
        if (node.name === "()") return "b.unit()"
        if (node.name.match(/^[ui][0-9]+$/) || node.name.match(/^f[0-9]+$/)) {
          return `b.${node.name}()`
        }
        return `${node.name}Schema`

      case "generic": {
        const args = node.args.map((arg) => this.generateZorshCode(arg))
        switch (node.base) {
          case "Vec":
            return `b.vec(${args[0]})`
          case "HashMap":
            return `b.hashMap(${args[0]}, ${args[1]})`
          case "HashSet":
            return `b.hashSet(${args[0]})`
          case "Option":
            return `b.option(${args[0]})`
          default:
            throw new Error(`Unknown generic type: ${node.base}`)
        }
      }

      case "tuple": {
        const elements = node.elements.map((e) => this.generateZorshCode(e))
        return `b.tuple([${elements.join(", ")}])`
      }
    }
  }
}
