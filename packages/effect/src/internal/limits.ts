import type { Schema, SchemaAST } from "effect"
import { BinaryError, type Reader } from "./io.js"

/** Checks the binary layer must not fail early, found by walking the original schema. */
export interface DeferredChecks {
  /**
   * Checks on maps and sets whose key schema has a transformation. Decoding can merge distinct wire
   * keys, so a maximum size from these checks only runs in the schema pass.
   */
  readonly mergingChecks: WeakSet<SchemaAST.Check<unknown>>
  /**
   * Checks beneath decoding middleware, such as `Schema.catchDecoding`, which can recover from
   * their failure in the schema pass, so they only run there.
   */
  readonly recoverableChecks: WeakSet<SchemaAST.Check<unknown>>
}

/** What compiling a layout needs to know about the codec's limits. */
export interface Limits extends DeferredChecks {
  /** Whether the codec has a maxItems budget, so collections charge their counts against it. */
  readonly countItems: boolean
}

export const noLimits: Limits = {
  countItems: false,
  mergingChecks: new WeakSet(),
  recoverableChecks: new WeakSet(),
}

/** What a length prefix counts, as named in early check failures. */
export type CountUnit = "items" | "bytes" | "entries" | "members"

const singular: Readonly<Record<CountUnit, string>> = {
  items: "item",
  bytes: "byte",
  entries: "entry",
  members: "member",
}

/** A recognised length or size check, with the counts it accepts. */
interface CountCheck {
  readonly check: SchemaAST.Filter<unknown>
  readonly min: number
  readonly max: number
  /** The check's own wording, so the early failure reads like the schema pass's. */
  readonly description: string
}

/** Runs right after a length prefix is read, before any item is read or allocated. */
export interface CountGuard {
  /** Whether this collection charges maxItems, when decoding and encoding. */
  readonly countItems: boolean
  /** Check a count just read against the early checks, then charge it to maxItems. */
  admit(reader: Reader, count: number, offset: number): void
}

/**
 * The guard for a vector, byte array, map or set, or undefined when it has neither early checks
 * nor a maxItems charge, so the layout keeps its unguarded closures.
 */
export function countGuard(
  checks: SchemaAST.Checks | undefined,
  unit: CountUnit,
  limits: Limits,
): CountGuard | undefined {
  const countChecks = recognise(checks, unit, limits)
  const hasChecks = countChecks.length > 0
  // Byte arrays count toward maxBytes, which already bounds them.
  const countItems = limits.countItems && unit !== "bytes"
  if (!hasChecks && !countItems) {
    return undefined
  }
  return {
    countItems,
    admit: (r, count, offset) => {
      // Effect still runs these checks in the schema pass, so disableChecks must skip them here.
      if (hasChecks && r.checks) {
        enforce(countChecks, count, unit, offset)
      }
      if (countItems) {
        r.charge(count, offset)
      }
    },
  }
}

/** Read a u32 count and let the guard check it before readPayload reads anything. */
export function guardedRead<A>(
  guard: CountGuard,
  readPayload: (r: Reader, count: number) => A,
): (r: Reader) => A {
  return (r) => {
    const offset = r.offset
    const count = r.u32()
    guard.admit(r, count, offset)
    return readPayload(r, count)
  }
}

/** Fail on the first check, in schema order, that rejects count, as the schema pass would. */
function enforce(
  countChecks: ReadonlyArray<CountCheck>,
  count: number,
  unit: CountUnit,
  offset: number,
): void {
  for (const { check, min, max, description } of countChecks) {
    if (count < min || count > max) {
      const noun = count === 1 ? singular[unit] : unit
      throw new BinaryError(offset, `${description}, got ${count} ${noun}`, check)
    }
  }
}

function describe(annotations: Schema.Annotations.Filter, unit: CountUnit): string {
  const { message, expected } = annotations
  if (typeof message === "string") {
    return message
  }
  if (typeof expected === "string") {
    return `Expected ${expected}`
  }
  return isSizeUnit(unit) ? "Failed size check" : "Failed length check"
}

function isSizeUnit(unit: CountUnit): boolean {
  return unit === "entries" || unit === "members"
}

/**
 * Effect's own length checks for vectors and byte arrays, or size checks for maps and sets,
 * found by representation id. Payloads are already normalised to non-negative integers.
 */
function recognise(
  checks: SchemaAST.Checks | undefined,
  unit: CountUnit,
  deferred: DeferredChecks,
): ReadonlyArray<CountCheck> {
  const recognised: CountCheck[] = []
  for (const check of filters(checks ?? [])) {
    const annotations = check.annotations
    if (annotations === undefined || deferred.recoverableChecks.has(check)) {
      continue
    }
    const representation = annotations.representation
    const range = isSizeUnit(unit) ? sizeRange(representation) : lengthRange(representation)
    if (range === undefined) {
      continue
    }
    // Merging keys only shrinks a collection, so its minimum size still holds.
    const max = deferred.mergingChecks.has(check) ? Infinity : range.max
    recognised.push({ check, min: range.min, max, description: describe(annotations, unit) })
  }
  return recognised
}

/** Every filter in schema order, including those in groups, which run all of their checks. */
export function filters(
  checks: ReadonlyArray<SchemaAST.Check<unknown>>,
): Array<SchemaAST.Filter<unknown>> {
  return checks.flatMap((check) => (check._tag === "FilterGroup" ? filters(check.checks) : [check]))
}

interface Range {
  readonly min: number
  readonly max: number
}

type Representation = Schema.Annotations.Filter["representation"]

function lengthRange(representation: Representation): Range | undefined {
  switch (representation?.id) {
    case "effect/schema/isMinLength":
      return atLeast(cardinality(representation.payload, "minLength"))
    case "effect/schema/isMaxLength":
      return atMost(cardinality(representation.payload, "maxLength"))
    case "effect/schema/isBetweenLength":
      return between(representation.payload)
  }
  return undefined
}

function sizeRange(representation: Representation): Range | undefined {
  switch (representation?.id) {
    case "effect/schema/isMinSize":
      return atLeast(cardinality(representation.payload, "minSize"))
    case "effect/schema/isMaxSize":
      return atMost(cardinality(representation.payload, "maxSize"))
    case "effect/schema/isBetweenSize":
      return between(representation.payload)
  }
  return undefined
}

function atLeast(min: number | undefined): Range | undefined {
  return min === undefined ? undefined : { min, max: Infinity }
}

function atMost(max: number | undefined): Range | undefined {
  return max === undefined ? undefined : { min: 0, max }
}

function between(payload: unknown): Range | undefined {
  const min = cardinality(payload, "minimum")
  const max = cardinality(payload, "maximum")
  if (min === undefined || max === undefined) {
    return undefined
  }
  return { min, max }
}

/** A payload bound, or undefined when a forged representation carries something else. */
function cardinality(payload: unknown, key: string): number | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined
  }
  const value: unknown = Reflect.get(payload, key)
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return undefined
  }
  return value
}
