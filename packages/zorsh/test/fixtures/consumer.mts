import { b, Schema, type EnumLike } from "../../src/index.js"
import { BinaryReader } from "../../src/binary-io.js"
import type { TypeOf, VecType } from "../../src/types.js"
const schema = b.struct({
  id: b.u64(),
  payload: b.bytes(),
  fixed: b.bytes(2),
  event: b.enum({ Empty: b.unit(), Data: b.string() }),
})
type Value = b.infer<typeof schema>
const value: Value = {
  id: 1n,
  payload: new Uint8Array(),
  fixed: new Uint8Array([1, 2]),
  event: { Data: "ok" },
}
const publicSchema: Schema<Value> = schema
const decoded: TypeOf<typeof schema> = publicSchema.deserialize(publicSchema.serialize(value))
const vector: VecType<typeof schema> = [decoded]
const enumLike: EnumLike = { A: "a" }
const variant: "a" = b.nativeEnum({ A: "a" } as const).deserialize(new Uint8Array([0]))
const reader = new BinaryReader(new Uint8Array())
// @ts-expect-error integer fields retain bigint inference
const wrong: Value = { ...value, id: "1" }
// @ts-expect-error bytes retain Uint8Array inference
const wrongBytes: b.infer<ReturnType<typeof b.bytes>> = [1, 2]
void [vector, enumLike, variant, reader, wrong, wrongBytes]
