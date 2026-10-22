import {
  Context,
  Effect,
  HashMap,
  HashSet,
  Option,
  Result,
  Schema,
  SchemaGetter,
  SchemaTransformation,
} from "effect"
import { expectTypeOf } from "vite-plus/test"
import { U16 } from "../src/Borsh.js"
import { Borsh } from "../src/index.js"

class Decode extends Context.Service<Decode, { readonly prefix: string }>()("Decode") {}
class Encode extends Context.Service<Encode, { readonly prefix: string }>()("Encode") {}
const schema = U16.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformEffect({
      decode: (n) => Effect.map(Decode, (service) => service.prefix + n),
      encode: (value) =>
        Effect.map(Encode, (service) => Number(value.slice(service.prefix.length))),
    }),
  ),
)
const codec = Borsh.toCodec(schema)
expectTypeOf(codec).toEqualTypeOf<Schema.Codec<string, Uint8Array, Decode, Encode>>()
expectTypeOf(Schema.decodeEffect(codec)(Uint8Array.of(1, 0))).toEqualTypeOf<
  Effect.Effect<string, Schema.SchemaError, Decode>
>()
expectTypeOf(Schema.encodeEffect(codec)("v1")).toEqualTypeOf<
  Effect.Effect<Uint8Array, Schema.SchemaError, Encode>
>()

expectTypeOf(Borsh.decodePrefixEffect(schema)(Uint8Array.of(1, 0), 0)).toEqualTypeOf<
  Effect.Effect<Borsh.Prefix<string>, Schema.SchemaError, Decode>
>()
// @ts-expect-error A schema that needs decoding services cannot decode synchronously.
Borsh.decodePrefixSync(schema)

const Transfer = Schema.Struct({ receiver: Schema.String, amount: Borsh.U128 })
const transfer = Borsh.toCodec(Transfer)
const bytes = Schema.encodeSync(transfer)({ receiver: "alice.near", amount: 123n })
expectTypeOf(Schema.decodeSync(transfer)(bytes)).toEqualTypeOf<typeof Transfer.Type>()
expectTypeOf(Borsh.decodePrefixSync(Transfer)(bytes, 0, { errors: "all" })).toEqualTypeOf<
  Borsh.Prefix<typeof Transfer.Type>
>()
const batch = Borsh.toCodec(Schema.Struct({ values: Schema.Array(schema) }))
expectTypeOf(batch).toEqualTypeOf<
  Schema.Codec<{ readonly values: readonly string[] }, Uint8Array, Decode, Encode>
>()

const Actions = Schema.TaggedUnion({ Idle: {}, Set: { value: Schema.Option(schema) } })
const Action = Actions.pipe(Borsh.discriminants({ Idle: 3, Set: 17 }))
expectTypeOf(Action).toEqualTypeOf<typeof Actions>()
// @ts-expect-error Missing discriminant for Set.
Actions.pipe(Borsh.discriminants({ Idle: 3 }))
// @ts-expect-error Typo in a discriminant key.
Actions.pipe(Borsh.discriminants({ Idle: 3, Sett: 17 }))
// @ts-expect-error Extra discriminant key.
Actions.pipe(Borsh.discriminants({ Idle: 3, Set: 17, Other: 1 }))
// @ts-expect-error The map must match the selected tag key.
Actions.pipe(Borsh.discriminants({ Idle: 3, Set: 17 }, { tag: "kind" }))
const action = Borsh.toCodec(Action)
expectTypeOf(action).toEqualTypeOf<Schema.Codec<typeof Action.Type, Uint8Array, Decode, Encode>>()
expectTypeOf(Action.cases.Set.make({ value: Option.some("v1") })._tag).toEqualTypeOf<"Set">()
const label = Action.match(
  { _tag: "Idle" },
  { Idle: () => "idle", Set: (value) => Option.getOrElse(value.value, () => "empty") },
)
expectTypeOf(label).toEqualTypeOf<string>()
const decoded = Schema.decodeEffect(action)(Uint8Array.of(3))
expectTypeOf(decoded).toEqualTypeOf<Effect.Effect<typeof Action.Type, Schema.SchemaError, Decode>>()
expectTypeOf(Schema.encodeEffect(action)({ _tag: "Idle" })).toEqualTypeOf<
  Effect.Effect<Uint8Array, Schema.SchemaError, Encode>
>()

expectTypeOf(Actions.cases.Set.make({ value: Option.none() })._tag).toEqualTypeOf<"Set">()
expectTypeOf(Borsh.toCodec(Actions)).toEqualTypeOf<
  Schema.Codec<typeof Actions.Type, Uint8Array, Decode, Encode>
>()

const Status = Schema.Literals(["Pending", "Done"])
expectTypeOf(Schema.decodeSync(Borsh.toCodec(Status))(Uint8Array.of(1))).toEqualTypeOf<
  "Pending" | "Done"
>()
Status.pipe(Borsh.discriminants({ Pending: 1, Done: 5 }))
// @ts-expect-error Missing discriminant for Done.
Status.pipe(Borsh.discriminants({ Pending: 1 }))
enum Direction {
  Up = 1,
  Down = 5,
}
const Directions = Schema.Enum(Direction).pipe(Borsh.discriminants({ Up: 1, Down: 5 }))
expectTypeOf(
  Schema.decodeSync(Borsh.toCodec(Directions))(Uint8Array.of(1)),
).toEqualTypeOf<Direction>()
// @ts-expect-error TS enum maps use member names, not values.
Schema.Enum(Direction).pipe(Borsh.discriminants({ 1: 1, 5: 5 }))
const BrandedDirection = Schema.Enum(Direction).pipe(Schema.brand("Direction"))
BrandedDirection.pipe(Borsh.discriminants({ Up: 1, Down: 5 }))
// @ts-expect-error Branded TS enums still use member names.
BrandedDirection.pipe(Borsh.discriminants({ 1: 1, 5: 5 }))
const DirectionText = Schema.Enum(Direction).pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform(String),
    encode: SchemaGetter.transform((text) => (text === "1" ? Direction.Up : Direction.Down)),
  }),
)
expectTypeOf(
  DirectionText.pipe(Borsh.discriminants({ Up: 1, Down: 5 })).Type,
).toEqualTypeOf<string>()
// @ts-expect-error Transformed TS enums use their encoded member names.
DirectionText.pipe(Borsh.discriminants({ 1: 1, 5: 5 }))
DirectionText.pipe(Schema.brand("Text"), Borsh.discriminants({ Up: 1, Down: 5 }))
// @ts-expect-error Only object variants have a tag key.
Status.pipe(Borsh.discriminants({ Pending: 1, Done: 5 }, { tag: "kind" }))
// @ts-expect-error Only object variants have a tag key.
Schema.Enum(Direction).pipe(Borsh.discriminants({ Up: 1, Down: 5 }, { tag: "kind" }))
const RefinedDirection = Schema.Enum(Direction).pipe(
  Schema.refine((d): d is Direction.Up => d === Direction.Up),
)
RefinedDirection.pipe(Borsh.discriminants({ Up: 1, Down: 5 }))
// @ts-expect-error Refined TS enums still use member names.
RefinedDirection.pipe(Borsh.discriminants({ 1: 1, 5: 5 }))
Schema.toEncoded(Schema.Enum(Direction)).pipe(Borsh.discriminants({ Up: 1, Down: 5 }))
// @ts-expect-error Encoded TS enums still use member names.
Schema.toEncoded(Schema.Enum(Direction)).pipe(Borsh.discriminants({ 1: 1, 5: 5 }))
Schema.flip(Schema.Enum(Direction)).pipe(Borsh.discriminants({ Up: 1, Down: 5 }))
const TypedDirection = Schema.toType(
  Schema.String.pipe(
    Schema.decodeTo(Schema.Enum(Direction), {
      decode: SchemaGetter.transform(() => Direction.Up),
      encode: SchemaGetter.transform(String),
    }),
  ),
)
TypedDirection.pipe(Borsh.discriminants({ Up: 1, Down: 5 }))
// @ts-expect-error The type side of a transformation still uses member names.
TypedDirection.pipe(Borsh.discriminants({ 1: 1, 5: 5 }))
Schema.Enum({ 0: "zero", 1: "one" } as const).pipe(Borsh.discriminants({ 0: 1, 1: 5 }))
// @ts-expect-error Plain object enums use their keys, including integer keys.
Schema.Enum({ 0: "zero", 1: "one" } as const).pipe(Borsh.discriminants({ zero: 1, one: 5 }))
// @ts-expect-error Array items are not enum names.
Schema.Array(Schema.Enum(Direction)).pipe(Borsh.discriminants({ Up: 1, Down: 5 }))
declare const eitherTag: "_tag" | "kind"
// @ts-expect-error The tag key must be one string literal.
Actions.pipe(Borsh.discriminants({ Idle: 3, Set: 17 }, { tag: eitherTag }))
// @ts-expect-error The tag key must be one string literal.
Actions.pipe(Borsh.discriminants({ Idle: 3, Set: 17 }, { tag: "_tag" as string }))
const partial: Partial<Record<"Idle" | "Set", number>> = { Idle: 3 }
// @ts-expect-error Optional map entries do not cover a variant.
Actions.pipe(Borsh.discriminants(partial))
const Kinds = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("A") }),
  Schema.Struct({ kind: Schema.Literal("B"), value: U16 }),
]).pipe(Borsh.discriminants({ A: 2, B: 9 }, { tag: "kind" }), Schema.toTaggedUnion("kind"))
expectTypeOf(Kinds.match({ kind: "A" }, { A: () => 0, B: (b) => b.value })).toEqualTypeOf<number>()

const fixed = Schema.Array(schema).pipe(Borsh.fixedArray(2))
expectTypeOf(fixed.Type).toEqualTypeOf<readonly string[]>()
expectTypeOf(Borsh.toCodec(fixed)).toEqualTypeOf<
  Schema.Codec<readonly string[], Uint8Array, Decode, Encode>
>()
const result = Borsh.toCodec(Schema.Result(fixed, schema))
expectTypeOf(result).toEqualTypeOf<
  Schema.Codec<Result.Result<readonly string[], string>, Uint8Array, Decode, Encode>
>()

class ValueDecode extends Context.Service<ValueDecode, { readonly suffix: string }>()(
  "ValueDecode",
) {}
class ValueEncode extends Context.Service<ValueEncode, { readonly suffix: string }>()(
  "ValueEncode",
) {}
const valueSchema = U16.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformEffect({
      decode: (n) => Effect.map(ValueDecode, ({ suffix }) => n + suffix),
      encode: (value) =>
        Effect.map(ValueEncode, ({ suffix }) => Number(value.slice(0, -suffix.length))),
    }),
  ),
)
const maps = Borsh.toCodec(Schema.ReadonlyMap(schema, Schema.Option(valueSchema)))
expectTypeOf(maps).toEqualTypeOf<
  Schema.Codec<
    ReadonlyMap<string, Option.Option<string>>,
    Uint8Array,
    Decode | ValueDecode,
    Encode | ValueEncode
  >
>()
expectTypeOf(Schema.decodeEffect(maps)(new Uint8Array(4))).toEqualTypeOf<
  Effect.Effect<
    ReadonlyMap<string, Option.Option<string>>,
    Schema.SchemaError,
    Decode | ValueDecode
  >
>()
expectTypeOf(Schema.encodeEffect(maps)(new Map())).toEqualTypeOf<
  Effect.Effect<Uint8Array, Schema.SchemaError, Encode | ValueEncode>
>()
const hashMaps = Borsh.toCodec(Schema.HashMap(schema, Schema.Result(valueSchema, valueSchema)))
expectTypeOf(hashMaps).toEqualTypeOf<
  Schema.Codec<
    HashMap.HashMap<string, Result.Result<string, string>>,
    Uint8Array,
    Decode | ValueDecode,
    Encode | ValueEncode
  >
>()
expectTypeOf(Schema.decodeEffect(hashMaps)(new Uint8Array(4))).toEqualTypeOf<
  Effect.Effect<
    HashMap.HashMap<string, Result.Result<string, string>>,
    Schema.SchemaError,
    Decode | ValueDecode
  >
>()
expectTypeOf(Schema.encodeEffect(hashMaps)(HashMap.empty())).toEqualTypeOf<
  Effect.Effect<Uint8Array, Schema.SchemaError, Encode | ValueEncode>
>()
expectTypeOf(Borsh.toCodec(Schema.ReadonlySet(schema))).toEqualTypeOf<
  Schema.Codec<ReadonlySet<string>, Uint8Array, Decode, Encode>
>()
expectTypeOf(Borsh.toCodec(Schema.HashSet(schema))).toEqualTypeOf<
  Schema.Codec<HashSet.HashSet<string>, Uint8Array, Decode, Encode>
>()

const transferWithBytes = Borsh.withBytes(Transfer)
expectTypeOf(transferWithBytes.schema).toEqualTypeOf<typeof Transfer>()
expectTypeOf(transferWithBytes.annotate({ title: "Transfer" })).toEqualTypeOf<
  Borsh.withBytes<typeof Transfer>
>()
expectTypeOf(transferWithBytes.Type).toEqualTypeOf<{
  readonly value: typeof Transfer.Type
  readonly bytes: Uint8Array
}>()
const SignedTransfer = Schema.Struct({
  transfer: transferWithBytes,
  signature: Borsh.fixedBytes(64),
})
const signed = Schema.decodeSync(Borsh.toCodec(SignedTransfer))(new Uint8Array(0))
expectTypeOf(signed.transfer.value.amount).toEqualTypeOf<bigint>()
expectTypeOf(signed.transfer.bytes).toEqualTypeOf<Uint8Array>()
const servicedWithBytes = Borsh.withBytes(schema)
expectTypeOf(servicedWithBytes.Encoded).toEqualTypeOf<{
  readonly value: number
  readonly bytes: Uint8Array
}>()
expectTypeOf(Borsh.toCodec(servicedWithBytes)).toEqualTypeOf<
  Schema.Codec<{ readonly value: string; readonly bytes: Uint8Array }, Uint8Array, Decode, Encode>
>()
