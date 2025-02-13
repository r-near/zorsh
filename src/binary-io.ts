// Core binary reading/writing utilities

export class BinaryWriter {
	private buffer: Uint8Array;
	private view: DataView;
	private offset = 0;

	constructor(initialSize = 1024) {
		this.buffer = new Uint8Array(initialSize);
		this.view = new DataView(this.buffer.buffer);
	}

	private ensureCapacity(additionalBytes: number): void {
		const requiredSize = this.offset + additionalBytes;
		if (requiredSize <= this.buffer.length) {
			return;
		}

		// Double the buffer size until it's large enough
		let newSize = this.buffer.length;
		while (newSize < requiredSize) {
			newSize *= 2;
		}

		const newBuffer = new Uint8Array(newSize);
		newBuffer.set(this.buffer);
		this.buffer = newBuffer;
		this.view = new DataView(this.buffer.buffer);
	}

	// Unsigned integers
	writeUint8(value: number): void {
		this.ensureCapacity(1);
		this.view.setUint8(this.offset, value);
		this.offset += 1;
	}

	writeUint16(value: number): void {
		this.ensureCapacity(2);
		this.view.setUint16(this.offset, value, true);
		this.offset += 2;
	}

	writeUint32(value: number): void {
		this.ensureCapacity(4);
		this.view.setUint32(this.offset, value, true);
		this.offset += 4;
	}

	writeUint64(value: bigint): void {
		this.ensureCapacity(8);
		this.view.setBigUint64(this.offset, value, true);
		this.offset += 8;
	}

	writeUint128(value: bigint): void {
		this.ensureCapacity(16);
		const low = value & BigInt("0xFFFFFFFFFFFFFFFF");
		const high = value >> BigInt(64);
		this.writeUint64(low);
		this.writeUint64(high);
	}

	// Signed integers
	writeInt8(value: number): void {
		this.ensureCapacity(1);
		this.view.setInt8(this.offset, value);
		this.offset += 1;
	}

	writeInt16(value: number): void {
		this.ensureCapacity(2);
		this.view.setInt16(this.offset, value, true);
		this.offset += 2;
	}

	writeInt32(value: number): void {
		this.ensureCapacity(4);
		this.view.setInt32(this.offset, value, true);
		this.offset += 4;
	}

	writeInt64(value: bigint): void {
		this.ensureCapacity(8);
		this.view.setBigInt64(this.offset, value, true);
		this.offset += 8;
	}

	writeInt128(value: bigint): void {
		this.ensureCapacity(16);
		const low = value & BigInt("0xFFFFFFFFFFFFFFFF");
		const high = value >> BigInt(64);
		this.writeInt64(low);
		this.writeInt64(high);
	}

	// Floating point
	writeFloat32(value: number): void {
		this.ensureCapacity(4);
		this.view.setFloat32(this.offset, value, true);
		this.offset += 4;
	}

	writeFloat64(value: number): void {
		this.ensureCapacity(8);
		this.view.setFloat64(this.offset, value, true);
		this.offset += 8;
	}

	writeString(value: string): void {
		const bytes = new TextEncoder().encode(value);
		this.writeUint32(bytes.length);
		this.ensureCapacity(bytes.length);
		this.buffer.set(bytes, this.offset);
		this.offset += bytes.length;
	}

	getBuffer(): Uint8Array {
		return this.buffer.slice(0, this.offset);
	}
}

export class BinaryReader {
	private view: DataView;
	private offset = 0;

	constructor(private buffer: Uint8Array) {
		this.view = new DataView(
			buffer.buffer,
			buffer.byteOffset,
			buffer.byteLength,
		);
	}

	// Unsigned integers
	readUint8(): number {
		const value = this.view.getUint8(this.offset);
		this.offset += 1;
		return value;
	}

	readUint16(): number {
		const value = this.view.getUint16(this.offset, true);
		this.offset += 2;
		return value;
	}

	readUint32(): number {
		const value = this.view.getUint32(this.offset, true);
		this.offset += 4;
		return value;
	}

	readUint64(): bigint {
		const value = this.view.getBigUint64(this.offset, true);
		this.offset += 8;
		return value;
	}

	readUint128(): bigint {
		const low = this.readUint64();
		const high = this.readUint64();
		return (high << BigInt(64)) | low;
	}

	// Signed integers
	readInt8(): number {
		const value = this.view.getInt8(this.offset);
		this.offset += 1;
		return value;
	}

	readInt16(): number {
		const value = this.view.getInt16(this.offset, true);
		this.offset += 2;
		return value;
	}

	readInt32(): number {
		const value = this.view.getInt32(this.offset, true);
		this.offset += 4;
		return value;
	}

	readInt64(): bigint {
		const value = this.view.getBigInt64(this.offset, true);
		this.offset += 8;
		return value;
	}

	readInt128(): bigint {
		const low = this.readUint64(); // Read as unsigned to preserve bit pattern
		const high = this.readInt64(); // Read high bits as signed
		return (high << BigInt(64)) | low;
	}

	// Floating point
	readFloat32(): number {
		const value = this.view.getFloat32(this.offset, true);
		this.offset += 4;
		return value;
	}

	readFloat64(): number {
		const value = this.view.getFloat64(this.offset, true);
		this.offset += 8;
		return value;
	}

	readString(): string {
		const length = this.readUint32();
		const bytes = this.buffer.slice(this.offset, this.offset + length);
		this.offset += length;
		return new TextDecoder().decode(bytes);
	}

	getOffset(): number {
		return this.offset;
	}
}
