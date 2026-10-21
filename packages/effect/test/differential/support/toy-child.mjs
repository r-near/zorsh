// Hostile process fixture for the client only. This never stands in for Borsh.
import readline from "node:readline"
const mode = process.argv[2]
if (mode === "ignore-term") {
  process.on("SIGTERM", () => {})
  setInterval(() => {}, 1000)
}
if (mode === "exit-immediately") process.exit(19)
const input = readline.createInterface({ input: process.stdin })
input.on("line", (line) => {
  const request = JSON.parse(line)
  const reply = {
    protocolVersion: 1,
    id: request.id,
    ok: true,
    schemaId: request.schemaId,
    operation: request.operation,
    value: "1",
    hex: "01",
  }
  switch (mode) {
    case "timeout":
    case "ignore-term":
      return
    case "crash":
      process.exit(23)
    case "partial-eof":
      process.stdout.write('{"protocolVersion":1')
      process.exit(0)
    case "stdout-flood":
      process.stdout.write("x".repeat(4096))
      return
    case "stderr-flood":
      process.stderr.write("e".repeat(4096))
      return
    case "bad-json":
      process.stdout.write("nope\n")
      return
    case "invalid-utf8":
      process.stdout.write(Buffer.from([0xff, 10]))
      return
    case "bad-id":
      reply.id = "unmatched"
      break
    case "bad-version":
      reply.protocolVersion = 2
      break
    case "bad-schema":
      reply.schemaId = "i8"
      break
    case "bad-operation":
      reply.operation = "decode"
      break
    case "bad-hex":
      reply.hex = "0g"
      break
    case "bad-shape":
      reply.extra = "surprise"
      break
    case "false-ok":
      reply.ok = 1
      break
    case "transport":
    case "protocol":
    case "resource_limit":
    case "unknown_schema":
    case "unknown_operation":
    case "borsh_rejection":
      process.stdout.write(
        JSON.stringify({
          protocolVersion: 1,
          id: request.id,
          ok: false,
          error: { kind: mode, message: "controlled fixture failure" },
        }) + "\n",
      )
      return
    case "unknown-error":
      process.stdout.write(
        JSON.stringify({
          protocolVersion: 1,
          id: request.id,
          ok: false,
          error: { kind: "unknown_error", message: "not in protocol" },
        }) + "\n",
      )
      return
  }
  const frame = JSON.stringify(reply) + "\n"
  process.stdout.write(mode === "duplicate-frame" ? frame + frame : frame)
})
