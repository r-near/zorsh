import { createInterface } from "node:readline"
const mode = process.argv[2]
for await (const line of createInterface({ input: process.stdin })) {
  const request: { id: string; schemaId: string; operation: string; value: unknown } =
    JSON.parse(line)
  if (mode === "timeout") continue
  if (mode === "crash") process.exit(1)
  if (mode === "flood") {
    process.stdout.write(Buffer.alloc(1048577, 120))
    continue
  }
  if (mode === "stderr-flood") {
    process.stderr.write(Buffer.alloc(65537, 120))
    continue
  }
  if (mode === "partial") {
    process.stdout.write("{")
    process.exitCode = 1
    break
  }
  const response =
    mode === "transport"
      ? {
          protocolVersion: 1,
          id: request.id,
          ok: false,
          error: { kind: "transport", message: "invalid transport" },
        }
      : {
          protocolVersion: 1,
          id: request.id,
          ok: true,
          schemaId: request.schemaId,
          operation: request.operation,
          value: request.value,
          hex: "07",
        }
  process.stdout.write(JSON.stringify(response) + "\n")
  if (mode === "trailing") setTimeout(() => process.stdout.write("x"), 10)
}
if (mode === "nonzero") process.exitCode = 2
if (mode === "hang-close") setInterval(() => {}, 1000)
