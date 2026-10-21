import { HashMap, HashSet, type SchemaAST } from "effect"
import type { Compile, Layout } from "./compiler.js"
import { parameters } from "./containers.js"
import { BinaryError, prepend } from "./io.js"

interface CollectionAdapter {
  readonly name: string
  readonly arity: 1 | 2
  get(
    value: unknown,
  ): { readonly size: number; readonly entries: Iterable<readonly [unknown, unknown]> } | undefined
  make(entries: [unknown, unknown][]): unknown
}

/** Rust BTreeMap/BTreeSet: a u32 count, then entries in strictly increasing key order. */
function collection(adapter: CollectionAdapter) {
  return (ast: SchemaAST.Declaration, path: string, compile: Compile): Layout => {
    const [key, value] = parameters(ast, adapter.arity, adapter.name, path)
    const keyLayout = compile(key, `${path}["key"]`)
    const compare = keyLayout.compare
    if (compare === undefined)
      throw new Error(`${path}: Collection keys require Boolean, integer or String Rust ordering`)
    const valueLayout = value === undefined ? undefined : compile(value, `${path}["value"]`)
    const minimum = keyLayout.minBytes + (valueLayout?.minBytes ?? 0)
    const ordered = (previous: unknown, key: unknown, offset: number) => {
      if (compare(previous, key) >= 0)
        throw new BinaryError(offset, "Collection keys must be strictly increasing")
    }
    return {
      minBytes: 4,
      isZeroSized: false,
      read: (r) => {
        const count = r.u32()
        if (count > Math.floor((r.input.byteLength - r.offset) / minimum))
          throw new BinaryError(r.offset, "Truncated collection payload")
        const entries: [unknown, unknown][] = []
        let i = 0
        let part = "key"
        try {
          for (; i < count; i++) {
            const offset = r.offset
            part = "key"
            const key = keyLayout.read(r)
            if (i > 0) ordered(entries[i - 1]?.[0], key, offset)
            part = "value"
            entries.push([key, valueLayout === undefined ? undefined : valueLayout.read(r)])
          }
        } catch (error) {
          throw prepend(prepend(error, part), i)
        }
        return adapter.make(entries)
      },
      write: (w, value) => {
        const collection = adapter.get(value)
        if (collection === undefined || collection.size > 0xffff_ffff)
          throw new BinaryError(w.offset, "Expected native collection with u32 length")
        w.ensure(4 + (collection.size === 0 ? 0 : collection.size * minimum))
        const entries = Array.from(collection.entries).sort(([a], [b]) => compare(a, b))
        w.u32(entries.length)
        let i = 0
        let part = "key"
        try {
          for (const [key, value] of entries) {
            part = "key"
            if (i > 0) ordered(entries[i - 1]?.[0], key, w.offset)
            keyLayout.write(w, key)
            part = "value"
            if (valueLayout !== undefined) valueLayout.write(w, value)
            i++
          }
        } catch (error) {
          throw prepend(prepend(error, part), i)
        }
      },
    }
  }
}

export const readonlyMap = collection({
  name: "ReadonlyMap",
  arity: 2,
  get: (value) => (value instanceof Map ? { size: value.size, entries: value } : undefined),
  make: (entries) => new Map(entries),
})
export const readonlySet = collection({
  name: "ReadonlySet",
  arity: 1,
  get: (value) =>
    value instanceof Set ? { size: value.size, entries: value.entries() } : undefined,
  make: (entries) => new Set(entries.map(([key]) => key)),
})
export const hashMap = collection({
  name: "HashMap",
  arity: 2,
  get: (value) =>
    HashMap.isHashMap(value) ? { size: HashMap.size(value), entries: value } : undefined,
  make: HashMap.fromIterable,
})
export const hashSet = collection({
  name: "HashSet",
  arity: 1,
  get: (value) =>
    HashSet.isHashSet(value)
      ? {
          size: HashSet.size(value),
          entries: (function* () {
            for (const key of value) yield [key, key] as const
          })(),
        }
      : undefined,
  make: (entries) => HashSet.fromIterable(entries.map(([key]) => key)),
})
