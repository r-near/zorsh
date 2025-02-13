import { readFileSync, writeFileSync } from "node:fs"
import { BorshSchemaContainerSchema, ZorshGenerator } from "."

//Read schema.bin into a file
const data = readFileSync("rust/borsh_test/test_data/complex_schema.bin")
const container = BorshSchemaContainerSchema.deserialize(data)

const generator = new ZorshGenerator()
const code = generator.generate(container)

//Write code to a file
writeFileSync("rust/borsh_test/generated_schema.ts", code)
