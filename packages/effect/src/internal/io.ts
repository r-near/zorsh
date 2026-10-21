/** Expected binary failures only. User schema defects never cross this catch boundary. */
export class BinaryError extends Error {
  constructor(
    readonly offset: number,
    readonly detail: string,
    readonly path = "$",
  ) {
    super(`${path} at byte ${offset}: ${detail}`)
  }

  prepend(segment: string): BinaryError {
    return new BinaryError(this.offset, this.detail, `$${segment}${this.path.slice(1)}`)
  }
}

export class Reader {
  offset = 0
  constructor(
    readonly input: Uint8Array,
    maxBytes: number,
  ) {
    if (input.byteLength > maxBytes)
      throw new BinaryError(0, `Input exceeds maxBytes (${maxBytes})`)
  }

  take(length: number): Uint8Array {
    if (length > this.input.byteLength - this.offset)
      throw new BinaryError(this.offset, `Truncated input: need ${length} bytes`)
    const bytes = new Uint8Array(this.input.buffer, this.input.byteOffset + this.offset, length)
    this.offset += length
    return bytes
  }

  view(length: number): DataView {
    const bytes = this.take(length)
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  u32(): number {
    return this.view(4).getUint32(0, true)
  }
}

export class Writer {
  private buffer: Uint8Array
  offset = 0

  constructor(readonly maxBytes: number) {
    this.buffer = new Uint8Array(Math.min(64, maxBytes))
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
  }

  view(length: number): DataView {
    this.ensure(length)
    const view = new DataView(this.buffer.buffer, this.offset, length)
    this.offset += length
    return view
  }

  bytes(bytes: Uint8Array): void {
    this.ensure(bytes.byteLength)
    this.buffer.set(bytes, this.offset)
    this.offset += bytes.byteLength
  }

  u32(value: number): void {
    this.view(4).setUint32(0, value, true)
  }

  finish(): Uint8Array {
    return this.buffer.slice(0, this.offset)
  }
}

/** Count and validate before TextEncoder allocates; stop as soon as the budget is exceeded. */
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
