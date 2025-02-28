// test/enum-integration.test.ts
import { describe, expect, test } from "vitest"
import { b } from "../src/schema"

describe("Native Enum Integration with Borsh Enums", () => {
  // This is a TypeScript native enum representing status
  enum Status {
    Idle = 0,
    Running = 1,
    Paused = 2,
    Completed = 3,
    Failed = 4,
  }

  // This is a more complex Borsh enum that may contain data
  // (similar to how Rust enums can have fields)
  const ResultSchema = b.enum({
    Success: b.struct({
      data: b.string(),
      timestamp: b.u64(),
    }),
    Failure: b.struct({
      error: b.string(),
      code: b.u16(),
    }),
  })

  // Let's define a top-level schema that uses both enum types
  const TaskSchema = b.struct({
    id: b.string(),
    status: b.nativeEnum(Status),
    result: b.option(ResultSchema),
    metadata: b.hashMap(b.string(), b.string()),
  })

  type Task = b.infer<typeof TaskSchema>

  test("mixed enum types in complex schema", () => {
    // Create a task object
    const task: Task = {
      id: "task-123",
      status: Status.Running,
      result: null, // No result yet
      metadata: new Map([
        ["owner", "alice"],
        ["priority", "high"],
      ]),
    }

    // Serialize and deserialize
    const serialized = TaskSchema.serialize(task)
    const deserialized = TaskSchema.deserialize(serialized)

    // Verify
    expect(deserialized).toEqual(task)
    expect(deserialized.status).toBe(Status.Running)

    // Now add a successful result and try again
    const taskWithResult: Task = {
      ...task,
      status: Status.Completed,
      result: {
        Success: {
          data: "Completed successfully",
          timestamp: BigInt(1678886400000),
        },
      },
    }

    const serialized2 = TaskSchema.serialize(taskWithResult)
    const deserialized2 = TaskSchema.deserialize(serialized2)

    expect(deserialized2).toEqual(taskWithResult)
    expect(deserialized2.status).toBe(Status.Completed)
    expect(deserialized2.result).toEqual(taskWithResult.result)
  })

  test("enum round trip with both types", () => {
    // Create a task with a failure result
    const failedTask: Task = {
      id: "task-456",
      status: Status.Failed,
      result: {
        Failure: {
          error: "Resource not found",
          code: 404,
        },
      },
      metadata: new Map([
        ["owner", "bob"],
        ["retry", "false"],
      ]),
    }

    // Serialize and deserialize
    const serialized = TaskSchema.serialize(failedTask)
    const deserialized = TaskSchema.deserialize(serialized)

    // Verify
    expect(deserialized).toEqual(failedTask)
    expect(deserialized.status).toBe(Status.Failed)
    expect(deserialized.result).toEqual(failedTask.result)
  })

  test("comparing binary representation of native enum vs borsh enum", () => {
    // Define comparable enums with both approaches
    enum StatusEnum {
      Active = 0,
      Inactive = 1,
      Pending = 2,
    }

    const BorshStatusEnum = b.enum({
      Active: b.unit(),
      Inactive: b.unit(),
      Pending: b.unit(),
    })

    const nativeSchema = b.nativeEnum(StatusEnum)

    // Test serializing values
    const nativeActive = nativeSchema.serialize(StatusEnum.Active)
    const nativeInactive = nativeSchema.serialize(StatusEnum.Inactive)
    const nativePending = nativeSchema.serialize(StatusEnum.Pending)

    const borshActive = BorshStatusEnum.serialize({ Active: {} })
    const borshInactive = BorshStatusEnum.serialize({ Inactive: {} })
    const borshPending = BorshStatusEnum.serialize({ Pending: {} })

    // Both should serialize to single-byte values representing the variant index
    expect(nativeActive.length).toBe(1)
    expect(borshActive.length).toBe(1)

    // And the index values should match
    expect(nativeActive[0]).toBe(borshActive[0]) // Both should be 0
    expect(nativeInactive[0]).toBe(borshInactive[0]) // Both should be 1
    expect(nativePending[0]).toBe(borshPending[0]) // Both should be 2

    // Ensure consistency with deserializing
    expect(nativeSchema.deserialize(nativeActive)).toBe(StatusEnum.Active)
    expect(nativeSchema.deserialize(nativeInactive)).toBe(StatusEnum.Inactive)
    expect(nativeSchema.deserialize(nativePending)).toBe(StatusEnum.Pending)
  })
})
