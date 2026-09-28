import { describe, expect, it } from "vitest"
import { type Schema, b } from "../src"

describe("b.lazy() - recursive schemas", () => {
  it("should roundtrip a simple recursive tree", () => {
    // Binary tree: each node has a value and optional left/right children
    const TreeNodeSchema: Schema<unknown> = b.enum({
      Leaf: b.struct({ value: b.u32() }),
      Branch: b.struct({
        value: b.u32(),
        left: b.lazy(() => TreeNodeSchema),
        right: b.lazy(() => TreeNodeSchema),
      }),
    })

    const tree = {
      Branch: {
        value: 1,
        left: { Leaf: { value: 2 } },
        right: {
          Branch: {
            value: 3,
            left: { Leaf: { value: 4 } },
            right: { Leaf: { value: 5 } },
          },
        },
      },
    }

    const bytes = TreeNodeSchema.serialize(tree)
    const deserialized = TreeNodeSchema.deserialize(bytes)
    expect(deserialized).toEqual(tree)
  })

  it("should roundtrip recursive vec (list of self)", () => {
    // Like ProposalAction::BatchActions(Vec<ProposalAction>)
    const ActionSchema: Schema<unknown> = b.enum({
      Simple: b.u32(),
      Batch: b.vec(b.lazy(() => ActionSchema)),
    })

    const action = {
      Batch: [{ Simple: 1 }, { Simple: 2 }, { Batch: [{ Simple: 3 }] }],
    }

    const bytes = ActionSchema.serialize(action)
    const deserialized = ActionSchema.deserialize(bytes)
    expect(deserialized).toEqual(action)
  })

  it("should roundtrip recursive option (optional self)", () => {
    // Linked list: each node has a value and an optional next node
    const ListNodeSchema: Schema<unknown> = b.struct({
      value: b.u32(),
      next: b.option(b.lazy(() => ListNodeSchema)),
    })

    const list = {
      value: 1,
      next: {
        value: 2,
        next: {
          value: 3,
          next: null,
        },
      },
    }

    const bytes = ListNodeSchema.serialize(list)
    const deserialized = ListNodeSchema.deserialize(bytes)
    expect(deserialized).toEqual(list)
  })

  it("should handle deeply nested recursion", () => {
    const NodeSchema: Schema<unknown> = b.enum({
      Leaf: b.u32(),
      Branch: b.vec(b.lazy(() => NodeSchema)),
    })

    // 4 levels deep
    const deep = {
      Branch: [
        {
          Branch: [
            {
              Branch: [{ Branch: [{ Leaf: 42 }] }],
            },
          ],
        },
      ],
    }

    const bytes = NodeSchema.serialize(deep)
    const deserialized = NodeSchema.deserialize(bytes)
    expect(deserialized).toEqual(deep)
  })

  it("should handle mutual recursion via lazy", () => {
    // Expression / Statement mutual recursion
    const ExprSchema: Schema<unknown> = b.enum({
      Literal: b.u32(),
      Block: b.vec(b.lazy(() => StmtSchema)),
    })

    const StmtSchema: Schema<unknown> = b.enum({
      ExprStmt: b.lazy(() => ExprSchema),
      Return: b.lazy(() => ExprSchema),
    })

    const program = {
      ExprStmt: {
        Block: [{ Return: { Literal: 42 } }],
      },
    }

    const bytes = StmtSchema.serialize(program)
    const deserialized = StmtSchema.deserialize(bytes)
    expect(deserialized).toEqual(program)
  })

  it("should work with lazy inside struct fields", () => {
    const CategorySchema: Schema<unknown> = b.struct({
      name: b.string(),
      children: b.vec(b.lazy(() => CategorySchema)),
    })

    const category = {
      name: "root",
      children: [
        {
          name: "child1",
          children: [{ name: "grandchild", children: [] }],
        },
        { name: "child2", children: [] },
      ],
    }

    const bytes = CategorySchema.serialize(category)
    const deserialized = CategorySchema.deserialize(bytes)
    expect(deserialized).toEqual(category)
  })

  it("should work with lazy inside hashMap values", () => {
    const TreeSchema: Schema<unknown> = b.enum({
      Leaf: b.string(),
      Node: b.hashMap(
        b.string(),
        b.lazy(() => TreeSchema),
      ),
    })

    const tree = {
      Node: new Map([
        ["left", { Leaf: "hello" }],
        ["right", { Node: new Map([["inner", { Leaf: "world" }]]) }],
      ]),
    }

    const bytes = TreeSchema.serialize(tree)
    const deserialized = TreeSchema.deserialize(bytes)
    expect(deserialized).toEqual(tree)
  })

  it("should cache the factory result", () => {
    let callCount = 0
    const schema: Schema<unknown> = b.struct({
      value: b.u32(),
      next: b.option(
        b.lazy(() => {
          callCount++
          return schema
        }),
      ),
    })

    const data = { value: 1, next: { value: 2, next: null } }

    // Serialize and deserialize multiple times
    schema.deserialize(schema.serialize(data))
    schema.deserialize(schema.serialize(data))

    // Factory should only be called once due to caching
    expect(callCount).toBe(1)
  })

  it("should handle lazy with unit variants", () => {
    const ConditionSchema: Schema<unknown> = b.enum({
      True: b.unit(),
      False: b.unit(),
      And: b.vec(b.lazy(() => ConditionSchema)),
      Or: b.vec(b.lazy(() => ConditionSchema)),
      Not: b.lazy(() => ConditionSchema),
    })

    const condition = {
      And: [{ True: {} }, { Or: [{ False: {} }, { Not: { True: {} } }] }],
    }

    const bytes = ConditionSchema.serialize(condition)
    const deserialized = ConditionSchema.deserialize(bytes)
    expect(deserialized).toEqual(condition)
  })

  it("should produce identical bytes to non-lazy equivalent for non-recursive data", () => {
    // Verify that b.lazy(() => X) produces the same bytes as X directly
    const directSchema = b.struct({
      name: b.string(),
      value: b.u32(),
    })

    const lazySchema = b.struct({
      name: b.lazy(() => b.string()),
      value: b.lazy(() => b.u32()),
    })

    const data = { name: "test", value: 42 }

    const directBytes = directSchema.serialize(data)
    const lazyBytes = lazySchema.serialize(data)

    expect(lazyBytes).toEqual(directBytes)

    const directResult = directSchema.deserialize(directBytes)
    const lazyResult = lazySchema.deserialize(lazyBytes)

    expect(lazyResult).toEqual(directResult)
  })
})
