/** Expected binary failures only. User schema defects never cross this catch boundary. */
export class BinaryError extends Error {
  readonly path: PropertyKey[] = []
  constructor(
    readonly offset: number,
    readonly detail: string,
  ) {
    super(`${detail} at byte ${offset}`)
  }
}

/** Prefix a binary failure's path while it unwinds; other errors pass through unchanged. */
export function prepend(error: unknown, segment: PropertyKey): unknown {
  if (error instanceof BinaryError) error.path.unshift(segment)
  return error
}

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
/** Below this many bytes, plain loops beat the fixed cost of TextEncoder and TextDecoder. */
const shortString = 32
// Empty inputs, including detached ones, cannot back a view.
const empty = new Uint8Array(0)
const emptyView = new DataView(empty.buffer)

export class Reader {
  offset = 0
  /** A plain view, so slices copy even when the input is a Buffer. */
  readonly input: Uint8Array
  readonly view: DataView
  constructor(input: Uint8Array, maxBytes: number) {
    if (input.byteLength > maxBytes)
      throw new BinaryError(0, `Input exceeds maxBytes (${maxBytes})`)
    const length = input.byteLength
    this.input = length === 0 ? empty : new Uint8Array(input.buffer, input.byteOffset, length)
    this.view = length === 0 ? emptyView : new DataView(input.buffer, input.byteOffset, length)
  }

  /** Reserve length bytes and return their start offset. */
  advance(length: number): number {
    const offset = this.offset
    if (length > this.input.byteLength - offset)
      throw new BinaryError(offset, `Truncated input: need ${length} bytes`)
    this.offset = offset + length
    return offset
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
      if (ascii !== undefined) return ascii
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
      if ((low | high) & 0x80808080) return undefined
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
      if (code > 0x7f) return undefined
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

  constructor(readonly maxBytes: number) {
    this.buffer = new Uint8Array(Math.min(64, maxBytes))
    this.view = new DataView(this.buffer.buffer)
  }

  ensure(length: number): void {
    if (length > this.maxBytes - this.offset)
      throw new BinaryError(this.offset, `Output exceeds maxBytes (${this.maxBytes})`)
    const needed = this.offset + length
    if (needed <= this.buffer.byteLength) return
    const buffer = new Uint8Array(
      Math.min(this.maxBytes, Math.max(needed, this.buffer.byteLength * 2)),
    )
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
    if (length === value.length && length <= shortString) {
      const buffer = this.buffer
      for (let i = 0; i < length; i++) buffer[offset + i] = value.charCodeAt(i)
    } else encoder.encodeInto(value, this.buffer.subarray(offset, offset + length))
  }

  finish(): Uint8Array {
    return this.buffer.slice(0, this.offset)
  }
}

/** Count and validate before encoding; stop as soon as the budget is exceeded. */
export function utf8Length(value: string, budget: number, offset: number): number {
  let length = 0
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x80) length++
    else if (code < 0x800) length += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new BinaryError(offset, "Lone UTF-16 surrogate")
      length += 4
    } else if (code >= 0xdc00 && code <= 0xdfff)
      throw new BinaryError(offset, "Lone UTF-16 surrogate")
    else length += 3
    if (length > budget || length > 0xffff_ffff)
      throw new BinaryError(offset, "UTF-8 string exceeds byte budget")
  }
  return length
}
