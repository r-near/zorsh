import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import fc from "fast-check"

export const oraclePath = fileURLToPath(
  new URL("../../../../rust/borsh-oracle/target/debug/zorsh-borsh-oracle", import.meta.url),
)
export class HarnessError extends Error {}
type Response = { ok: true; value: unknown; hex: string } | { ok: false }
type Pending = {
  request: Record<string, unknown>
  resolve: (value: Response) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}
function object(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value))
}
function keys(value: Record<string, unknown>, expected: string[]) {
  assert.deepEqual(Object.keys(value).sort(), expected.sort(), "Invalid oracle response fields")
}

export class Oracle {
  private child
  private pending: Pending | undefined
  private buffer = Buffer.alloc(0)
  private stderrBytes = 0
  private stderr = ""
  private nextId = 0
  private closing = false
  private exit
  failure: HarnessError | undefined

  constructor(
    command = process.env.ZORSH_BORSH_ORACLE ?? oraclePath,
    args: string[] = [],
    private timeout = 3000,
  ) {
    this.child = spawn(command, args, { stdio: "pipe" })
    this.exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      this.child.on("close", (code, signal) => {
        if (this.pending || !this.closing || code !== 0 || signal !== null)
          this.fail(new HarnessError(`Oracle exited (${code ?? signal}): ${this.stderr.trim()}`))
        resolve({ code, signal })
      })
    })
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr])
      stream.on("error", (cause) => this.fail(new HarnessError("Oracle I/O failed", { cause })))
    this.child.on("error", (cause) =>
      this.fail(
        new HarnessError("Cannot start Rust oracle; run vp run test-effect-differential", {
          cause,
        }),
      ),
    )
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.length
      this.stderr += chunk.toString("utf8").slice(0, 4096 - this.stderr.length)
      if (this.stderrBytes > 65536) this.fail(new HarnessError("Oracle stderr exceeded 64 KiB"))
    })
    this.child.stdout.on("end", () => {
      if (this.buffer.length) this.fail(new HarnessError("Partial oracle response at EOF"))
    })
    this.child.stdout.on("data", (chunk: Buffer) => {
      try {
        assert.ok(this.pending, "Unsolicited oracle output")
        assert.ok(this.buffer.length + chunk.length <= 1048576, "Oracle stdout exceeded 1 MiB")
        this.buffer = Buffer.concat([this.buffer, chunk])
        const end = this.buffer.indexOf(10)
        if (end < 0) return
        assert.equal(end, this.buffer.length - 1, "Extra oracle response bytes")
        const response: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(this.buffer.subarray(0, end)),
        )
        object(response)
        const pending = this.pending
        assert.equal(response.protocolVersion, 1)
        assert.equal(response.id, pending.request.id, "Oracle response ID differs")
        if (response.ok === true) {
          keys(response, ["protocolVersion", "id", "ok", "schemaId", "operation", "value", "hex"])
          assert.equal(response.schemaId, pending.request.schemaId)
          assert.equal(response.operation, pending.request.operation)
          assert.ok(
            typeof response.hex === "string" &&
              /^(?:[0-9a-f]{2})*$/.test(response.hex) &&
              response.hex.length <= 131072,
            "Invalid oracle hex",
          )
        } else {
          assert.equal(response.ok, false)
          keys(response, ["protocolVersion", "id", "ok", "error"])
          object(response.error)
          keys(response.error, ["kind", "message"])
          assert.equal(typeof response.error.message, "string")
          assert.equal(
            response.error.kind,
            "borsh_rejection",
            `Oracle infrastructure error: ${JSON.stringify(response.error)}`,
          )
        }
        clearTimeout(pending.timer)
        this.pending = undefined
        this.buffer = Buffer.alloc(0)
        pending.resolve(
          response.ok
            ? { ok: true, value: response.value, hex: String(response.hex) }
            : { ok: false },
        )
      } catch (cause) {
        this.fail(new HarnessError("Invalid oracle response", { cause }))
      }
    })
  }

  private fail(error: HarnessError) {
    this.failure ??= error
    if (this.pending) {
      clearTimeout(this.pending.timer)
      this.pending.reject(this.failure)
      this.pending = undefined
    }
    this.child.kill("SIGKILL")
  }

  request(
    schemaId: string,
    operation: "encode" | "decode",
    payload: { value: unknown } | { hex: string },
  ): Promise<Response> {
    if (this.failure) return Promise.reject(this.failure)
    assert.ok(!this.pending && !this.closing, "Oracle requests must be sequential")
    const request = {
      protocolVersion: 1,
      id: String(++this.nextId),
      schemaId,
      operation,
      ...payload,
    }
    const frame = JSON.stringify(request) + "\n"
    assert.ok(Buffer.byteLength(frame) <= 1048576, "Oracle request exceeded 1 MiB")
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new HarnessError("Oracle request timed out")),
        this.timeout,
      )
      this.pending = { request, resolve, reject, timer }
      this.child.stdin.write(frame)
    })
  }

  async close() {
    this.closing = true
    this.child.stdin.end()
    const timer = setTimeout(
      () => this.fail(new HarnessError("Oracle shutdown timed out")),
      this.timeout,
    )
    try {
      await this.exit
      if (this.failure) throw this.failure
    } finally {
      clearTimeout(timer)
    }
  }
}

export async function assertProperty<A>(
  arbitrary: fc.Arbitrary<A>,
  predicate: (value: A) => Promise<unknown>,
  parameters: fc.Parameters<[A]> = {},
) {
  let infrastructure: Error | undefined
  let mismatch = false
  try {
    await fc.assert(
      fc.asyncProperty(arbitrary, async (input) => {
        if (infrastructure) throw new fc.PreconditionFailure(true)
        try {
          await predicate(input)
        } catch (error) {
          if (error instanceof HarnessError) {
            infrastructure = new Error(`Oracle failed while evaluating ${fc.stringify(input)}`, {
              cause: error,
            })
            if (mismatch) throw new fc.PreconditionFailure(true)
          } else mismatch = true
          throw error
        }
      }),
      parameters,
    )
  } catch (error) {
    if (infrastructure)
      throw new AggregateError([error, infrastructure], "Oracle infrastructure failed")
    throw error
  }
}
