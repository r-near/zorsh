import { HashMap, HashSet, Option, Result, type SchemaAST } from "effect"
import type { Compile, Layout } from "./compiler.js"
import { BinaryError, prepend, type Reader, type Writer } from "./io.js"
import { bytes } from "./primitives.js"

const uint8ArrayId = "effect/schema/Uint8Array"

type Native = (ast: SchemaAST.Declaration, path: string, compile: Compile) => Layout

export function compileDeclaration(
  ast: SchemaAST.Declaration,
  path: string,
  compile: Compile,
): Layout {
  const id = representationId(ast)
  // Own keys only, so an id such as "constructor" cannot select an Object.prototype member.
  const native = id !== undefined && Object.hasOwn(natives, id) ? natives[id] : undefined
  if (native === undefined) {
    const subject = id === undefined ? "Declaration" : `Declaration ${id}`
    throw new Error(
      `${path}: ${subject} has no Borsh layout; decode it from a Borsh-encodable schema with Schema.decodeTo`,
    )
  }
  return native(ast, path, compile)
}

/** The declaration fixedBytes may annotate. */
export function isUint8Array(ast: SchemaAST.AST): boolean {
  return ast._tag === "Declaration" && representationId(ast) === uint8ArrayId
}

function representationId(ast: SchemaAST.Declaration): string | undefined {
  const representation = ast.annotations?.representation
  if (
    typeof representation === "object" &&
    representation !== null &&
    "id" in representation &&
    typeof representation.id === "string"
  ) {
    return representation.id
  }
  return undefined
}

/** Effect's constructors fix these arities; only hand-built declarations can differ. */
function parameters<const N extends 1 | 2>(
  ast: SchemaAST.Declaration,
  count: N,
  name: string,
  path: string,
): N extends 1 ? readonly [SchemaAST.AST] : readonly [SchemaAST.AST, SchemaAST.AST] {
  // includes visits holes too, so sparse hand-built arrays fail here.
  const slots: ReadonlyArray<SchemaAST.AST | undefined> = ast.typeParameters
  if (slots.length !== count || slots.includes(undefined)) {
    throw new Error(
      `${path}: ${name} requires exactly ${count} encoded type parameter${count === 1 ? "" : "s"}`,
    )
  }
  return ast.typeParameters as never
}

function option(ast: SchemaAST.Declaration, path: string, compile: Compile): Layout {
  const [inner] = parameters(ast, 1, "Option", path)
  const item = compile(inner, `${path}["value"]`)
  return {
    minBytes: 1,
    isZeroSized: false,
    read: (r) => {
      const offset = r.offset
      const tag = r.u8()
      if (tag > 1) {
        throw new BinaryError(offset, `Invalid Option tag ${tag}`)
      }
      if (tag === 0) {
        return Option.none()
      }
      try {
        return Option.some(item.read(r))
      } catch (error) {
        throw prepend(error, "value")
      }
    },
    write: (w, value) => {
      if (!Option.isOption(value)) {
        throw new BinaryError(w.offset, "Expected Option")
      }
      w.u8(Option.isSome(value) ? 1 : 0)
      if (Option.isNone(value)) {
        return
      }
      try {
        item.write(w, value.value)
      } catch (error) {
        throw prepend(error, "value")
      }
    },
  }
}

/** Rust Result<T, E>: tag 1 then the Ok value, or tag 0 then the Err value. */
function result(ast: SchemaAST.Declaration, path: string, compile: Compile): Layout {
  const [success, failure] = parameters(ast, 2, "Result", path)
  const ok = compile(success, `${path}["success"]`)
  const err = compile(failure, `${path}["failure"]`)
  return {
    minBytes: 1 + Math.min(ok.minBytes, err.minBytes),
    isZeroSized: false,
    read: (r) => {
      const offset = r.offset
      const tag = r.u8()
      if (tag > 1) {
        throw new BinaryError(offset, `Invalid Result tag ${tag}`)
      }
      try {
        return tag === 1 ? Result.succeed(ok.read(r)) : Result.fail(err.read(r))
      } catch (error) {
        throw prepend(error, tag === 1 ? "success" : "failure")
      }
    },
    write: (w, value) => {
      if (!Result.isResult(value)) {
        throw new BinaryError(w.offset, "Expected Result")
      }
      const success = Result.isSuccess(value)
      w.u8(success ? 1 : 0)
      try {
        if (success) {
          ok.write(w, value.success)
        } else {
          err.write(w, value.failure)
        }
      } catch (error) {
        throw prepend(error, success ? "success" : "failure")
      }
    },
  }
}

/** The representation id of `Borsh.withBytes`. */
export const withBytesId = "@zorsh/effect/withBytes"

/** The shape `Borsh.withBytes` decodes to and encodes from, on either side of its schema. */
export interface ValueWithBytes<A> {
  readonly value: A
  readonly bytes: Uint8Array
}

/** Own properties only, as for any struct field, so an inherited `bytes` is never trusted. */
export function isValueWithBytes(input: unknown): input is ValueWithBytes<unknown> {
  return (
    typeof input === "object" &&
    input !== null &&
    Object.hasOwn(input, "value") &&
    Object.hasOwn(input, "bytes") &&
    Reflect.get(input, "bytes") instanceof Uint8Array
  )
}

/** The layout of the wrapped schema, also keeping the exact span its value was read from. */
function withBytes(ast: SchemaAST.Declaration, path: string, compile: Compile): Layout {
  const [inner] = parameters(ast, 1, "withBytes", path)
  const value = compile(inner, `${path}["value"]`)
  // No compare: as a map key or set member it fails at construction, like any unordered key.
  return {
    minBytes: value.minBytes,
    isZeroSized: value.isZeroSized,
    read: (r) => {
      const start = r.offset
      try {
        // The reader's input is a plain view, so slice copies rather than aliasing the caller.
        return { value: value.read(r), bytes: r.input.slice(start, r.offset) }
      } catch (error) {
        throw prepend(error, "value")
      }
    },
    write: (w, input) => {
      if (!isValueWithBytes(input)) {
        throw new BinaryError(w.offset, "Expected value with bytes")
      }
      const start = w.offset
      try {
        value.write(w, input.value)
      } catch (error) {
        throw prepend(error, "value")
      }
      const difference = w.firstDifference(start, input.bytes)
      if (difference !== undefined) {
        throw prepend(new BinaryError(difference, "Bytes do not match the encoded value"), "bytes")
      }
    },
  }
}

interface CollectionAdapter {
  readonly name: string
  readonly arity: 1 | 2
  get(value: unknown): Collection | undefined
  make(entries: [unknown, unknown][]): unknown
}

/**
 * Rust BTreeMap/BTreeSet, also for Hash collections: a u32 count, then strictly increasing keys.
 */
function collectionLayout(adapter: CollectionAdapter) {
  return (ast: SchemaAST.Declaration, path: string, compile: Compile): Layout => {
    const [key, value] = parameters(ast, adapter.arity, adapter.name, path)
    const keyLayout = compile(key, `${path}["key"]`)
    const compare = keyLayout.compare
    if (compare === undefined) {
      throw new Error(
        `${path}: ${adapter.name} keys require Boolean, integer or String Rust ordering`,
      )
    }
    const valueLayout = value === undefined ? undefined : compile(value, `${path}["value"]`)
    const minEntryBytes = keyLayout.minBytes + (valueLayout?.minBytes ?? 0)
    const assertIncreasing = (previous: unknown, key: unknown, offset: number) => {
      if (compare(previous, key) >= 0) {
        throw new BinaryError(offset, "Collection keys must be strictly increasing")
      }
    }
    const readEntries = (r: Reader, count: number) => {
      // Each entry needs at least minEntryBytes, so reject an impossible count before allocating.
      if (count > Math.floor((r.end - r.offset) / minEntryBytes)) {
        throw r.pastEnd(r.offset, count * minEntryBytes, "Truncated collection payload")
      }
      const entries: [unknown, unknown][] = []
      // The entry index and part locate a failure, as in [3]["value"].
      let i = 0
      let part = "key"
      try {
        for (; i < count; i++) {
          const offset = r.offset
          part = "key"
          const key = keyLayout.read(r)
          if (i > 0) {
            assertIncreasing(entries[i - 1]?.[0], key, offset)
          }
          part = "value"
          entries.push([key, valueLayout === undefined ? undefined : valueLayout.read(r)])
        }
      } catch (error) {
        throw prepend(prepend(error, part), i)
      }
      return adapter.make(entries)
    }
    const writeEntries = (w: Writer, collection: Collection) => {
      w.ensure(4 + (collection.size === 0 ? 0 : collection.size * minEntryBytes))
      // Sorted into Rust order, so the increasing check below only rejects keys Rust deems equal.
      const entries = Array.from(collection.entries).sort(([a], [b]) => compare(a, b))
      w.u32(entries.length)
      let i = 0
      let part = "key"
      try {
        for (const [key, value] of entries) {
          part = "key"
          if (i > 0) {
            assertIncreasing(entries[i - 1]?.[0], key, w.offset)
          }
          keyLayout.write(w, key)
          part = "value"
          if (valueLayout !== undefined) {
            valueLayout.write(w, value)
          }
          i++
        }
      } catch (error) {
        throw prepend(prepend(error, part), i)
      }
    }
    return {
      minBytes: 4,
      isZeroSized: false,
      read: (r) => {
        const offset = r.offset
        const count = r.u32()
        r.charge(count, offset)
        return readEntries(r, count)
      },
      write: (w, value) => {
        const collection = adapter.get(value)
        if (collection === undefined || collection.size > 0xffff_ffff) {
          throw new BinaryError(w.offset, "Expected native collection with u32 length")
        }
        w.charge(collection.size, w.offset)
        writeEntries(w, collection)
      },
    }
  }
}

interface Collection {
  readonly size: number
  readonly entries: Iterable<readonly [unknown, unknown]>
}

const readonlyMap = collectionLayout({
  name: "ReadonlyMap",
  arity: 2,
  get: (value) => (value instanceof Map ? { size: value.size, entries: value } : undefined),
  make: (entries) => new Map(entries),
})
const readonlySet = collectionLayout({
  name: "ReadonlySet",
  arity: 1,
  get: (value) =>
    value instanceof Set ? { size: value.size, entries: value.entries() } : undefined,
  make: (entries) => new Set(entries.map(([key]) => key)),
})
const hashMap = collectionLayout({
  name: "HashMap",
  arity: 2,
  get: (value) =>
    HashMap.isHashMap(value) ? { size: HashMap.size(value), entries: value } : undefined,
  make: HashMap.fromIterable,
})
const hashSet = collectionLayout({
  name: "HashSet",
  arity: 1,
  get: (value) =>
    HashSet.isHashSet(value) ? { size: HashSet.size(value), entries: keyPairs(value) } : undefined,
  make: (entries) => HashSet.fromIterable(entries.map(([key]) => key)),
})

/** Set members as [key, key] entries, the shape Set.prototype.entries yields. */
function* keyPairs<K>(keys: Iterable<K>): Generator<readonly [K, K]> {
  for (const key of keys) {
    yield [key, key] as const
  }
}

/** Effect declarations with a Borsh layout, keyed by their representation id. */
const natives: Readonly<Record<string, Native>> = {
  [uint8ArrayId]: () => bytes(),
  "effect/schema/Option": option,
  "effect/schema/Result": result,
  "effect/schema/ReadonlyMap": readonlyMap,
  "effect/schema/ReadonlySet": readonlySet,
  "effect/schema/HashMap": hashMap,
  "effect/schema/HashSet": hashSet,
  [withBytesId]: withBytes,
}
