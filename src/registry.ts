import type { BinaryReader, BinaryWriter } from "./binary-io";

export interface TypeHandler<TValue, TOptions = unknown> {
	write: (writer: BinaryWriter, value: TValue, options?: TOptions) => void;
	read: (reader: BinaryReader, options?: TOptions) => TValue;
}

export class TypeRegistry {
	private handlers = new Map<string, TypeHandler<unknown, unknown>>();

	register<TValue, TOptions = unknown>(
		type: string,
		handler: TypeHandler<TValue, TOptions>,
	): void {
		this.handlers.set(type, handler as TypeHandler<unknown, unknown>);
	}

	getHandler<TValue, TOptions = unknown>(
		type: string,
	): TypeHandler<TValue, TOptions> {
		const handler = this.handlers.get(type);
		if (!handler) {
			throw new Error(`No handler registered for type: ${type}`);
		}
		return handler as TypeHandler<TValue, TOptions>;
	}
}

// Create and initialize the global registry with primitive types
export const registry = new TypeRegistry();

// Register all primitive type handlers

// Unsigned integers
registry.register<number>("u8", {
	write: (writer, value) => writer.writeUint8(value),
	read: (reader) => reader.readUint8(),
});

registry.register<number>("u16", {
	write: (writer, value) => writer.writeUint16(value),
	read: (reader) => reader.readUint16(),
});

registry.register<number>("u32", {
	write: (writer, value) => writer.writeUint32(value),
	read: (reader) => reader.readUint32(),
});

registry.register<bigint>("u64", {
	write: (writer, value) => writer.writeUint64(value),
	read: (reader) => reader.readUint64(),
});

registry.register<bigint>("u128", {
	write: (writer, value) => writer.writeUint128(value),
	read: (reader) => reader.readUint128(),
});

// Signed integers
registry.register<number>("i8", {
	write: (writer, value) => writer.writeInt8(value),
	read: (reader) => reader.readInt8(),
});

registry.register<number>("i16", {
	write: (writer, value) => writer.writeInt16(value),
	read: (reader) => reader.readInt16(),
});

registry.register<number>("i32", {
	write: (writer, value) => writer.writeInt32(value),
	read: (reader) => reader.readInt32(),
});

registry.register<bigint>("i64", {
	write: (writer, value) => writer.writeInt64(value),
	read: (reader) => reader.readInt64(),
});

registry.register<bigint>("i128", {
	write: (writer, value) => writer.writeInt128(value),
	read: (reader) => reader.readInt128(),
});

// Floating point
registry.register<number>("f32", {
	write: (writer, value) => writer.writeFloat32(value),
	read: (reader) => reader.readFloat32(),
});

registry.register<number>("f64", {
	write: (writer, value) => writer.writeFloat64(value),
	read: (reader) => reader.readFloat64(),
});

// String and unit type
registry.register<string>("string", {
	write: (writer, value) => writer.writeString(value),
	read: (reader) => reader.readString(),
});

registry.register<Record<string, never>>("unit", {
	write: () => {}, // Unit type takes up no space
	read: () => ({}),
});

// Add struct handler - handles objects with named fields
interface StructFields {
	[field: string]: {
		type: string;
		options: unknown;
	};
}

registry.register<Record<string, unknown>, StructFields>("struct", {
	write: (writer, value, fields) => {
		if (!fields) return;
		for (const [field, def] of Object.entries(fields)) {
			const handler = registry.getHandler(def.type);
			handler.write(writer, value[field], def.options);
		}
	},
	read: (reader, fields) => {
		if (!fields) return {};
		const result: Record<string, unknown> = {};
		for (const [field, def] of Object.entries(fields)) {
			const handler = registry.getHandler(def.type);
			result[field] = handler.read(reader, def.options);
		}
		return result;
	},
});

// Add Vec handler - handles dynamic-length arrays
interface VecOptions<T> {
	elementType: string;
	elementOptions: T;
}

registry.register<unknown[], VecOptions<unknown>>("vec", {
	write: (writer, value, options) => {
		if (!options) return;
		const { elementType, elementOptions } = options;
		writer.writeUint32(value.length); // Write length prefix
		const handler = registry.getHandler<unknown>(elementType);
		for (const item of value) {
			handler.write(writer, item, elementOptions);
		}
	},
	read: (reader, options) => {
		if (!options) return [];
		const { elementType, elementOptions } = options;
		const length = reader.readUint32();
		const handler = registry.getHandler<unknown>(elementType);
		return Array.from({ length }, () => handler.read(reader, elementOptions));
	},
});

// Add HashSet handler
interface SetOptions<T> {
	elementType: string;
	elementOptions: T;
}

registry.register<Set<unknown>, SetOptions<unknown>>("set", {
	write: (writer, value, options) => {
		if (!options) return;
		const { elementType, elementOptions } = options;
		const array = Array.from(value);
		writer.writeUint32(array.length);
		const handler = registry.getHandler<unknown>(elementType);
		for (const item of array) {
			handler.write(writer, item, elementOptions);
		}
	},
	read: (reader, options) => {
		if (!options) return new Set();
		const { elementType, elementOptions } = options;
		const length = reader.readUint32();
		const handler = registry.getHandler<unknown>(elementType);
		const items = Array.from({ length }, () =>
			handler.read(reader, elementOptions),
		);
		return new Set(items);
	},
});

// Add HashMap handler
interface MapOptions<K, V> {
	keyType: string;
	keyOptions: K;
	valueType: string;
	valueOptions: V;
}

registry.register<Map<unknown, unknown>, MapOptions<unknown, unknown>>("map", {
	write: (writer, value, options) => {
		if (!options) return;
		const { keyType, keyOptions, valueType, valueOptions } = options;
		const entries = Array.from(value.entries());
		writer.writeUint32(entries.length);
		const keyHandler = registry.getHandler<unknown>(keyType);
		const valueHandler = registry.getHandler<unknown>(valueType);
		for (const [key, val] of entries) {
			keyHandler.write(writer, key, keyOptions);
			valueHandler.write(writer, val, valueOptions);
		}
	},
	read: (reader, options) => {
		if (!options) return new Map();
		const { keyType, keyOptions, valueType, valueOptions } = options;
		const length = reader.readUint32();
		const keyHandler = registry.getHandler<unknown>(keyType);
		const valueHandler = registry.getHandler<unknown>(valueType);
		const entries = Array.from({ length }, () => {
			const key = keyHandler.read(reader, keyOptions);
			const value = valueHandler.read(reader, valueOptions);
			return [key, value] as const;
		});
		return new Map(entries);
	},
});

// Add Option handler
interface OptionOptions<T> {
	valueType: string;
	valueOptions: T;
}

registry.register<unknown | null, OptionOptions<unknown>>("option", {
	write: (writer, value, options) => {
		if (!options) return;
		const { valueType, valueOptions } = options;
		const isSome = value !== null;
		writer.writeUint8(isSome ? 1 : 0);
		if (isSome) {
			const handler = registry.getHandler<unknown>(valueType);
			handler.write(writer, value, valueOptions);
		}
	},
	read: (reader, options) => {
		if (!options) return null;
		const { valueType, valueOptions } = options;
		const isSome = reader.readUint8() === 1;
		if (isSome) {
			const handler = registry.getHandler<unknown>(valueType);
			return handler.read(reader, valueOptions);
		}
		return null;
	},
});

// Add enum handler
interface EnumVariant {
	index: number;
	name: string;
	type: string;
	options: unknown;
}

interface EnumOptions {
	variants: EnumVariant[];
}

registry.register<Record<string, unknown>, EnumOptions>("enum", {
	write: (writer, value, options) => {
		if (!options) return;

		// Get the variant name (should be the only key in the object)
		const variantName = Object.keys(value)[0];
		// Assert variantName exists and is a string key of the value object
		const variantValue = value[variantName as keyof typeof value];

		// Find the variant definition
		const variant = options.variants.find((v) => v.name === variantName);
		if (!variant) {
			throw new Error(`Unknown enum variant: ${variantName}`);
		}

		// Write variant index
		writer.writeUint8(variant.index);

		// Write variant value if it has associated data
		if (variant.type !== "unit") {
			const handler = registry.getHandler(variant.type);
			handler.write(writer, variantValue, variant.options);
		}
	},
	read: (reader, options) => {
		if (!options) return {};

		const index = reader.readUint8();
		const variant = options.variants.find((v) => v.index === index);
		if (!variant) {
			throw new Error(`Unknown enum variant index: ${index}`);
		}

		// Return early for unit type
		if (variant.type === "unit") {
			return { [variant.name]: {} };
		}

		// Handle non-unit types
		const handler = registry.getHandler(variant.type);
		const value = handler.read(reader, variant.options);
		return { [variant.name]: value };
	},
});

// Add fixed-length array handler
interface ArrayOptions<T> {
	elementType: string;
	elementOptions: T;
	length: number;
}

registry.register<unknown[], ArrayOptions<unknown>>("array", {
	write: (writer, value, options) => {
		if (!options) return;
		const { elementType, elementOptions, length } = options;
		if (value.length !== length) {
			throw new Error(
				`Array length mismatch: expected ${length}, got ${value.length}`,
			);
		}
		const handler = registry.getHandler<unknown>(elementType);
		for (const item of value) {
			handler.write(writer, item, elementOptions);
		}
	},
	read: (reader, options) => {
		if (!options) return [];
		const { elementType, elementOptions, length } = options;
		const handler = registry.getHandler<unknown>(elementType);
		return Array.from({ length }, () => handler.read(reader, elementOptions));
	},
});
