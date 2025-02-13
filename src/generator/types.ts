import { b } from "../schema"

// Helper schemas for nested structures
const RangeSchema = b.struct({
  start: b.u64(),
  end: b.u64(),
})

const SequenceSchema = b.struct({
  lengthWidth: b.u32(),
  lengthRange: RangeSchema,
  elements: b.string(),
})

const TupleSchema = b.struct({
  elements: b.vec(b.string()),
})

const VariantSchema = b.struct({
  discriminant: b.u64(),
  name: b.string(),
  declaration: b.string(),
})

const EnumSchema = b.struct({
  tagWidth: b.u32(),
  variants: b.vec(VariantSchema),
})

const NamedFieldSchema = b.struct({
  name: b.string(),
  declaration: b.string(),
})

const StructFieldsSchema = b.enum({
  NamedFields: b.vec(NamedFieldSchema),
  UnnamedFields: b.vec(b.string()),
  Empty: b.struct({}),
})

const StructSchema = b.struct({
  fields: StructFieldsSchema,
})

// Main Definition schema as an enum since these are mutually exclusive
const DefinitionSchema = b.enum({
  Primitive: b.struct({ size: b.u32() }),
  Sequence: SequenceSchema,
  Tuple: TupleSchema,
  Enum: EnumSchema,
  Struct: StructSchema,
})

export const BorshSchemaContainerSchema = b.struct({
  declaration: b.string(),
  definitions: b.hashMap(b.string(), DefinitionSchema),
})

export type Definition = b.infer<typeof DefinitionSchema>
export type DefinitionEnum = b.infer<typeof EnumSchema>
export type DefinitionStruct = b.infer<typeof StructSchema>
export type DefinitionSequence = b.infer<typeof SequenceSchema>
export type DefinitionTuple = b.infer<typeof TupleSchema>
export type BorshSchemaContainer = b.infer<typeof BorshSchemaContainerSchema>
