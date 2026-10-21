import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key))

export class HarnessError extends Error {
  constructor(kind, message, options) {
    super(message, options)
    this.name = "HarnessError"
    this.kind = kind
  }
}

function checkResponse(value, request) {
  if (value?.protocolVersion !== 1 || value?.id !== request.id || typeof value?.ok !== "boolean")
    throw new Error("wrong version, id, or ok flag")
  if (value.ok) {
    if (
      !exactKeys(value, ["protocolVersion", "id", "ok", "schemaId", "operation", "value", "hex"]) ||
      value.schemaId !== request.schemaId ||
      value.operation !== request.operation ||
      typeof value.hex !== "string" ||
      !/^(?:[0-9a-f]{2})*$/.test(value.hex) ||
      value.hex.length > 131072
    )
      throw new Error("invalid success response shape or identity")
    return value
  }
  if (
    !exactKeys(value, ["protocolVersion", "id", "ok", "error"]) ||
    !exactKeys(value.error, ["kind", "message"]) ||
    typeof value.error.message !== "string" ||
    ![
      "borsh_rejection",
      "transport",
      "protocol",
      "unknown_schema",
      "unknown_operation",
      "resource_limit",
    ].includes(value.error.kind)
  )
    throw new Error("invalid error response shape")
  if (value.error.kind !== "borsh_rejection")
    throw new HarnessError(value.error.kind, `oracle ${value.error.kind}: ${value.error.message}`)
  return value
}

export class OracleClient {
  #child
  #pending
  #buffer = Buffer.alloc(0)
  #stderr = Buffer.alloc(0)
  #failure
  #nextId = 0
  #closed = false
  #exit
  #resolveExit
  #monitor
  #monitorBusy = false
  #monitorTask
  #killTimer
  #options
  requests = 0
  peakRssBytes = 0
  constructor(command, args = [], options = {}) {
    this.#options = {
      timeoutMs: 3000,
      maxFrameBytes: 1048576,
      maxStderrBytes: 65536,
      killAfterMs: 250,
      rssLimitBytes: 128 * 1024 * 1024,
      rssPollMs: 100,
      ...options,
    }
    if (this.#options.rssLimitBytes !== null && !["darwin", "linux"].includes(process.platform))
      throw new HarnessError("unsupported_platform", "RSS watchdog requires Linux or macOS ps")
    this.#exit = new Promise((resolve) => {
      this.#resolveExit = resolve
    })
    this.#child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] })
    this.#child.stdin.on("error", (error) =>
      this.#fail(new HarnessError("io", "oracle stdin failure", { cause: error })),
    )
    this.#child.stdout.on("error", (error) =>
      this.#fail(new HarnessError("io", "oracle stdout failure", { cause: error })),
    )
    this.#child.stderr.on("error", (error) =>
      this.#fail(new HarnessError("io", "oracle stderr failure", { cause: error })),
    )
    this.#child.on("error", (error) =>
      this.#fail(new HarnessError("spawn", "oracle spawn failure", { cause: error })),
    )
    this.#child.stdout.on("data", (chunk) => this.#onData(chunk))
    this.#child.stderr.on("data", (chunk) => {
      if (this.#stderr.length + chunk.length > this.#options.maxStderrBytes) {
        this.#fail(new HarnessError("stderr_limit", "oracle stderr exceeded capture bound"))
        return
      }
      this.#stderr = Buffer.concat([this.#stderr, chunk])
    })
    this.#child.on("exit", (code, signal) => {
      if (!this.#closed)
        this.#fail(new HarnessError("exit", `oracle exited unexpectedly (${code ?? signal})`))
    })
    this.#child.on("close", (code, signal) => {
      clearInterval(this.#monitor)
      clearTimeout(this.#killTimer)
      if (!this.#closed)
        this.#fail(new HarnessError("eof", `oracle closed unexpectedly (${code ?? signal})`))
      this.#resolveExit({ code, signal })
    })
    this.#child.stdout.on("end", () => {
      if (!this.#closed)
        this.#fail(
          new HarnessError(
            "eof",
            `oracle stdout EOF${this.#buffer.length ? " with partial frame" : ""}`,
          ),
        )
    })
    // macOS rejects finite RLIMIT_AS/RLIMIT_DATA. Watch RSS and fail closed on a
    // failed observation. This is an operational bound, not an OS hard RSS cap.
    if (this.#options.rssLimitBytes !== null) {
      this.#monitor = setInterval(() => {
        if (!this.#monitorBusy) this.#monitorTask = this.#checkRss()
      }, this.#options.rssPollMs)
      this.#monitor.unref()
    }
  }
  get pid() {
    return this.#child.pid
  }
  get stderr() {
    return this.#stderr.toString("utf8")
  }
  get failure() {
    return this.#failure
  }
  async #checkRss() {
    if (this.#closed || this.#failure || this.#monitorBusy || !this.#child.pid) return
    this.#monitorBusy = true
    try {
      const { stdout } = await execFileAsync(
        "/bin/ps",
        ["-o", "rss=", "-p", String(this.#child.pid)],
        { timeout: 500, maxBuffer: 1024 },
      )
      const rss = Number(stdout.trim()) * 1024
      if (!Number.isSafeInteger(rss) || rss <= 0) throw new Error("invalid RSS observation")
      this.peakRssBytes = Math.max(this.peakRssBytes, rss)
      if (rss > this.#options.rssLimitBytes)
        this.#fail(
          new HarnessError(
            "memory_limit",
            `oracle RSS ${rss} exceeded ${this.#options.rssLimitBytes}`,
          ),
        )
    } catch (cause) {
      if (!this.#closed && !this.#failure)
        this.#fail(new HarnessError("memory_monitor", "unable to observe oracle RSS", { cause }))
    } finally {
      this.#monitorBusy = false
    }
  }
  #fail(error) {
    if (!this.#failure) this.#failure = error
    if (this.#pending) {
      clearTimeout(this.#pending.timer)
      this.#pending.reject(this.#failure)
      this.#pending = undefined
    }
    this.#child.kill("SIGTERM")
    if (!this.#killTimer) {
      this.#killTimer = setTimeout(() => this.#child.kill("SIGKILL"), this.#options.killAfterMs)
      this.#killTimer.unref()
    }
  }
  #onData(chunk) {
    if (this.#failure || this.#closed) return
    // Append only one bounded frame at a time, including for a chunk containing
    // several lines. Never concatenate an arbitrarily large child output chunk.
    let start = 0
    while (start < chunk.length) {
      const lf = chunk.indexOf(10, start)
      const end = lf < 0 ? chunk.length : lf
      if (this.#buffer.length + end - start > this.#options.maxFrameBytes) {
        this.#fail(new HarnessError("stdout_limit", "oracle stdout frame exceeded bound"))
        return
      }
      this.#buffer = Buffer.concat([this.#buffer, chunk.subarray(start, end)])
      if (lf < 0) return
      const frame = this.#buffer
      this.#buffer = Buffer.alloc(0)
      if (!this.#pending) {
        this.#fail(new HarnessError("protocol", "unsolicited/duplicate response"))
        return
      }
      const pending = this.#pending
      try {
        const response = checkResponse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame)),
          pending.request,
        )
        this.#pending = undefined
        clearTimeout(pending.timer)
        pending.resolve(response)
      } catch (cause) {
        this.#fail(
          cause instanceof HarnessError
            ? cause
            : new HarnessError("protocol", "invalid oracle frame", { cause }),
        )
        return
      }
      start = lf + 1
    }
  }
  request(schemaId, operation, payload) {
    if (this.#closed || this.#failure)
      return Promise.reject(this.#failure ?? new HarnessError("closed", "oracle client closed"))
    if (this.#pending)
      return Promise.reject(new HarnessError("concurrency", "only one request may be in flight"))
    const request = {
      protocolVersion: 1,
      id: `js-${++this.#nextId}`,
      schemaId,
      operation,
      ...payload,
    }
    const frame = Buffer.from(JSON.stringify(request) + "\n")
    if (frame.length - 1 > this.#options.maxFrameBytes)
      return Promise.reject(new HarnessError("request_limit", "request exceeded frame bound"))
    this.requests++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.#fail(new HarnessError("timeout", `oracle request ${request.id} timed out`)),
        this.#options.timeoutMs,
      )
      this.#pending = { request, resolve, reject, timer }
      this.#child.stdin.write(frame, (error) => {
        if (error) this.#fail(new HarnessError("io", "oracle write failed", { cause: error }))
      })
    })
  }
  async close() {
    if (this.#closed) return this.#exit
    this.#closed = true
    clearInterval(this.#monitor)
    if (this.#pending) {
      clearTimeout(this.#pending.timer)
      this.#pending.reject(new HarnessError("closed", "client closed with request pending"))
      this.#pending = undefined
    }
    this.#child.stdin.destroy()
    this.#child.kill("SIGTERM")
    const timer = setTimeout(() => this.#child.kill("SIGKILL"), this.#options.killAfterMs)
    try {
      const exit = await this.#exit
      await this.#monitorTask
      return exit
    } finally {
      clearTimeout(timer)
      clearTimeout(this.#killTimer)
    }
  }
}
