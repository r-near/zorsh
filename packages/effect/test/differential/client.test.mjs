import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { describe, it } from "vite-plus/test"
import { OracleClient, HarnessError } from "./support/oracle-client.mjs"

const fixture = fileURLToPath(new URL("./support/toy-child.mjs", import.meta.url))
const dead = (pid) => {
  assert.throws(
    () => process.kill(pid, 0),
    (error) => error.code === "ESRCH",
    `child ${pid} leaked`,
  )
}
const toy = (mode, options = {}) =>
  new OracleClient(process.execPath, [fixture, mode], {
    timeoutMs: 500,
    maxFrameBytes: 1024,
    maxStderrBytes: 1024,
    killAfterMs: 50,
    rssLimitBytes: null,
    ...options,
  })

describe("bounded persistent oracle client", () => {
  /** @type {Array<[string, string[]]>} */
  const failureModes = [
    ["crash", ["exit", "eof"]],
    ["exit-immediately", ["exit", "eof", "io"]],
    ["partial-eof", ["eof", "exit"]],
    ["timeout", ["timeout"]],
    ["bad-json", ["protocol"]],
    ["invalid-utf8", ["protocol"]],
    ["bad-id", ["protocol"]],
    ["bad-version", ["protocol"]],
    ["bad-schema", ["protocol"]],
    ["bad-operation", ["protocol"]],
    ["bad-hex", ["protocol"]],
    ["bad-shape", ["protocol"]],
    ["false-ok", ["protocol"]],
    ["stdout-flood", ["stdout_limit"]],
    ["stderr-flood", ["stderr_limit"]],
    ["transport", ["transport"]],
    ["protocol", ["protocol"]],
    ["resource_limit", ["resource_limit"]],
    ["unknown_schema", ["unknown_schema"]],
    ["unknown_operation", ["unknown_operation"]],
    ["unknown-error", ["protocol"]],
  ]
  for (const [mode, kind] of failureModes) {
    it(`${mode} fails closed and reaps the child`, async () => {
      const client = toy(mode)
      try {
        await assert.rejects(
          client.request("u8", "encode", { value: "1" }),
          (error) => error instanceof HarnessError && kind.includes(error.kind),
        )
        assert.ok(client.failure instanceof HarnessError)
        await assert.rejects(
          client.request("u8", "encode", { value: "2" }),
          (error) => error === client.failure,
        )
      } finally {
        await client.close()
      }
      dead(client.pid)
      assert.ok(Buffer.byteLength(client.stderr) <= 1024)
    })
  }
  it("preserves a real Borsh rejection as the only comparable rejection class", async () => {
    const client = toy("borsh_rejection")
    try {
      const response = await client.request("u8", "encode", { value: "1" })
      assert.equal(response.ok, false)
      assert.equal(response.error.kind, "borsh_rejection")
      assert.equal(client.failure, undefined)
    } finally {
      await client.close()
    }
    dead(client.pid)
  })
  it("rejects a duplicate frame and stops the session", async () => {
    const client = toy("duplicate-frame")
    try {
      await client.request("u8", "encode", { value: "1" })
      await assert.rejects(client.request("u8", "encode", { value: "2" }), HarnessError)
    } finally {
      await client.close()
    }
    dead(client.pid)
  })
  for (const mode of ["partial-suffix", "shutdown-partial"]) {
    it(`${mode} rejects unsolicited bytes even without a final newline`, async () => {
      const client = toy(mode)
      try {
        assert.equal((await client.request("u8", "encode", { value: "1" })).ok, true)
      } finally {
        await client.close()
      }
      assert.equal(client.failure?.kind, "protocol")
      dead(client.pid)
    })
  }
  it("times out, escalates to SIGKILL, and reaps a child ignoring SIGTERM", async () => {
    const client = toy("ignore-term", { timeoutMs: 2000 })
    let exit
    try {
      // The valid roundtrip proves the SIGTERM handler is installed before hanging.
      assert.equal((await client.request("u8", "encode", { value: "1" })).ok, true)
      await assert.rejects(
        client.request("u8", "encode", { value: "1" }),
        (error) => error.kind === "timeout",
      )
    } finally {
      exit = await client.close()
    }
    assert.equal(exit.signal, "SIGKILL")
    dead(client.pid)
  })
  it("rejects concurrent requests without corrupting the in-flight request", async () => {
    const client = toy("normal")
    try {
      const first = client.request("u8", "encode", { value: "1" })
      await assert.rejects(
        client.request("u8", "encode", { value: "2" }),
        (error) => error.kind === "concurrency",
      )
      assert.equal((await first).ok, true)
      assert.equal((await client.request("u8", "encode", { value: "1" })).ok, true)
    } finally {
      await client.close()
    }
    dead(client.pid)
  })
  it("closes a pending request and remains idempotent", async () => {
    const client = toy("timeout")
    const pending = assert.rejects(
      client.request("u8", "encode", { value: "1" }),
      (error) => error.kind === "closed",
    )
    await client.close()
    await pending
    await client.close()
    dead(client.pid)
  })
  it("kills and reaps a child exceeding the sampled RSS limit", async () => {
    if (!["darwin", "linux"].includes(process.platform)) return
    const client = toy("timeout", { rssLimitBytes: 1, rssPollMs: 10 })
    try {
      await assert.rejects(
        client.request("u8", "encode", { value: "1" }),
        (error) => error.kind === "memory_limit",
      )
      assert.ok(client.peakRssBytes > 1)
    } finally {
      await client.close()
    }
    dead(client.pid)
  })
})
