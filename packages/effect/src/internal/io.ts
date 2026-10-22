/** Expected binary failures only. User schema defects never cross this catch boundary. */
export class BinaryError extends Error {
  readonly path: PropertyKey[] = []
  constructor(offset: number, detail: string) {
    super(`${detail} at byte ${offset}`)
  }
}

/** Prefix a binary failure's path while it unwinds; other errors pass through unchanged. */
export function prepend(error: unknown, segment: PropertyKey): unknown {
  if (error instanceof BinaryError) {
    error.path.unshift(segment)
  }
  return error
}

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
/** Below this many bytes, plain loops beat the fixed cost of TextEncoder and TextDecoder. */
const shortString = 32
// Empty inputs, including detached ones, cannot back a view.
const empty = new Uint8Array(0)
const emptyView = new DataView(empty.buffer)

export interface ReaderOptions {
  readonly maxBytes: number
  /** Infinity when the codec has no maxItems. */
  readonly maxItems: number
}

export class Reader {
  offset: number
  /** A plain view, so slices copy even when the input is a Buffer. */
  readonly input: Uint8Array
  readonly view: DataView
  /** One past the last byte the value may use. */
  readonly end: number
  readonly maxBytes: number
  readonly maxItems: number
  private items: number
  /** Where a prefix read's maxBytes runs out. A whole input was checked against it up front. */
  private readonly limit: number
  /**
   * Without start, the whole input must fit maxBytes. With start, this is a prefix read: it begins
   * there, may stop before the input ends, and maxBytes caps the value rather than the input.
   */
  constructor(input: Uint8Array, options: ReaderOptions, start?: number) {
    const length = input.byteLength
    if (start === undefined && length > options.maxBytes) {
      throw new BinaryError(0, `Input exceeds maxBytes (${options.maxBytes})`)
    }
    this.offset = start ?? 0
    this.input = length === 0 ? empty : new Uint8Array(input.buffer, input.byteOffset, length)
    this.view = length === 0 ? emptyView : new DataView(input.buffer, input.byteOffset, length)
    this.limit = start === undefined ? Infinity : start + options.maxBytes
    this.end = Math.min(length, this.limit)
    this.maxBytes = options.maxBytes
    this.maxItems = options.maxItems
    this.items = options.maxItems
  }

  /**
   * The error for a read of at least length bytes at offset that runs past end. It reports maxBytes
   * when this read alone shows the value can never fit, and detail when the input ran out first.
   */
  pastEnd(offset: number, length: number, detail: string): BinaryError {
    // A value that needs more than maxBytes can never fit, however much input follows.
    if (offset + length > this.limit) {
      return new BinaryError(offset, `Value exceeds maxBytes (${this.maxBytes})`)
    }
    return new BinaryError(offset, detail)
  }

  /** Spend count items of the maxItems budget, failing at the length prefix that overran it. */
  charge(count: number, offset: number): void {
    this.items -= count
    if (this.items < 0) {
      throw new BinaryError(offset, `Input exceeds maxItems (${this.maxItems})`)
    }
  }

  /** Reserve length bytes and return their start offset. */
  advance(length: number): number {
    const offset = this.offset
    if (length > this.end - offset) {
      throw this.pastEnd(offset, length, `Truncated input: need ${length} bytes`)
    }
    this.offset = offset + length
    return offset
  }

  /** A u32 length prefix, failing at it when it exceeds maxLength. */
  length(maxLength: number): number {
    const offset = this.offset
    const length = this.u32()
    checkMaxLength(length, maxLength, offset)
    return length
  }

  /**
   * A u32 item count, also charged to maxItems at its prefix. Items need at least minBytes each,
   * so an impossible count fails before anything is allocated.
   */
  count(maxLength: number, minBytes: number, detail: string): number {
    const offset = this.offset
    const count = this.length(maxLength)
    this.charge(count, offset)
    if (count > Math.floor((this.end - this.offset) / minBytes)) {
      throw this.pastEnd(this.offset, count * minBytes, detail)
    }
    return count
  }

  take(length: number): Uint8Array {
    const offset = this.advance(length)
    return this.input.subarray(offset, offset + length)
  }

  u8(): number {
    return this.view.getUint8(this.advance(1))
  }

  u32(): number {
    return this.view.getUint32(this.advance(4), true)
  }

  string(length: number): string {
    const offset = this.advance(length)
    if (length <= shortString) {
      const ascii = this.ascii(offset, offset + length)
      if (ascii !== undefined) {
        return ascii
      }
    }
    try {
      return decoder.decode(this.input.subarray(offset, offset + length))
    } catch {
      throw new BinaryError(offset, "Invalid UTF-8")
    }
  }

  /** Decode eight bytes per high-bit check, giving up on the first non-ASCII byte. */
  private ascii(start: number, end: number): string | undefined {
    const view = this.view
    let value = ""
    let i = start
    for (; i + 8 <= end; i += 8) {
      const low = view.getUint32(i, true)
      const high = view.getUint32(i + 4, true)
      // Any byte at or above 0x80 is not ASCII.
      if ((low | high) & 0x80808080) {
        return undefined
      }
      value += String.fromCharCode(
        low & 255,
        (low >>> 8) & 255,
        (low >>> 16) & 255,
        low >>> 24,
        high & 255,
        (high >>> 8) & 255,
        (high >>> 16) & 255,
        high >>> 24,
      )
    }
    for (; i < end; i++) {
      const code = view.getUint8(i)
      if (code > 0x7f) {
        return undefined
      }
      value += String.fromCharCode(code)
    }
    return value
  }
}

export class Writer {
  private buffer: Uint8Array
  /** Recreated whenever the buffer grows; read it only after advance. */
  view: DataView
  offset = 0

  private items: number

  /** maxItems is Infinity when the codec has none. */
  constructor(
    readonly maxBytes: number,
    readonly maxItems = Infinity,
  ) {
    this.buffer = new Uint8Array(Math.min(64, maxBytes))
    this.view = new DataView(this.buffer.buffer)
    this.items = maxItems
  }

  /** The encode side of Reader.charge, so a codec never writes what it cannot read back. */
  charge(count: number, offset: number): void {
    this.items -= count
    if (this.items < 0) {
      throw new BinaryError(offset, `Output exceeds maxItems (${this.maxItems})`)
    }
  }

  ensure(length: number): void {
    if (length > this.maxBytes - this.offset) {
      throw new BinaryError(this.offset, `Output exceeds maxBytes (${this.maxBytes})`)
    }
    const needed = this.offset + length
    if (needed <= this.buffer.byteLength) {
      return
    }
    // Double to amortize growth, but never allocate past maxBytes.
    const capacity = Math.min(this.maxBytes, Math.max(needed, this.buffer.byteLength * 2))
    const buffer = new Uint8Array(capacity)
    buffer.set(this.buffer)
    this.buffer = buffer
    this.view = new DataView(buffer.buffer)
  }

  /** Reserve length bytes and return their start offset. */
  advance(length: number): number {
    this.ensure(length)
    const offset = this.offset
    this.offset = offset + length
    return offset
  }

  bytes(bytes: Uint8Array): void {
    const offset = this.advance(bytes.byteLength)
    this.buffer.set(bytes, offset)
  }

  u8(value: number): void {
    const offset = this.advance(1)
    this.view.setUint8(offset, value)
  }

  u32(value: number): void {
    const offset = this.advance(4)
    this.view.setUint32(offset, value, true)
  }

  /** Write a string whose UTF-8 length utf8Length has already validated. */
  string(value: string, length: number): void {
    const offset = this.advance(length)
    // Equal UTF-16 and UTF-8 lengths mean every character is ASCII, so each code is its byte.
    if (length === value.length && length <= shortString) {
      const buffer = this.buffer
      for (let i = 0; i < length; i++) {
        buffer[offset + i] = value.charCodeAt(i)
      }
    } else {
      encoder.encodeInto(value, this.buffer.subarray(offset, offset + length))
    }
  }

  /**
   * Where the bytes written since start first differ from expected, or undefined when they are
   * equal. When one is a prefix of the other, that is where the shorter one ends.
   */
  firstDifference(start: number, expected: Uint8Array): number | undefined {
    const written = this.offset - start
    const shared = Math.min(written, expected.byteLength)
    const buffer = this.buffer
    for (let i = 0; i < shared; i++) {
      if (buffer[start + i] !== expected[i]) {
        return start + i
      }
    }
    return written === expected.byteLength ? undefined : start + shared
  }

  finish(): Uint8Array {
    return this.buffer.slice(0, this.offset)
  }
}

/** A Borsh.maxLength bound, checked at its length prefix before anything after it. */
export function checkMaxLength(length: number, maxLength: number, offset: number): void {
  if (length > maxLength) {
    throw new BinaryError(offset, `Length ${length} exceeds maxLength (${maxLength})`)
  }
}

/**
 * The UTF-8 length of value, or -1 if it has a lone UTF-16 surrogate, which UTF-8 cannot encode.
 * Counting stops once the length passes stop, so the result is then only known to exceed it.
 */
export function utf8Length(value: string, stop = Infinity): number {
  let length = 0
  for (let i = 0; i < value.length && length <= stop; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x80) {
      length++
    } else if (code < 0x800) {
      length += 2
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // A high surrogate must pair with a low one. Past the end, charCodeAt is NaN and fails too.
      const next = value.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return -1
      }
      length += 4
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return -1
    } else {
      length += 3
    }
  }
  return length
}
