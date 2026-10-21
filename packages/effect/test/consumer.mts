import { Context, Effect, Schema, SchemaTransformation } from "effect"
import { expectTypeOf } from "vite-plus/test"
import { Borsh } from "../src/index.js"
import { U16 } from "../src/Borsh.js"

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
