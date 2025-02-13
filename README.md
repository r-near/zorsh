# Zorsh

A TypeScript-first implementation of the [Borsh](https://borsh.io) binary serialization format, with a modern Zod-like API and full type inference.

## Features

- 🎯 **Type-Safe**: Full TypeScript type inference with zero runtime overhead
- 🎨 **Modern API**: Zod-inspired schema builder with an intuitive API
- ⚡ **High Performance**: Direct binary serialization without intermediate steps
- 💪 **Flexible**: Rich type system supporting complex nested structures
- 📦 **Self-Contained**: No external dependencies beyond TypeScript

## Installation

```bash
npm install zorsh
# or
yarn add zorsh
# or
pnpm add zorsh
```

## Quick Start

```typescript
import { b } from "zorsh";

// Define your schema
const UserSchema = b.struct({
  name: b.string(),
  age: b.u8(),
  scores: b.vec(b.u16()),
  metadata: b.option(
    b.struct({
      joinDate: b.u64(),
      rank: b.string(),
    })
  ),
});

// Get the TypeScript type from your schema
type User = b.infer<typeof UserSchema>;

// Use it!
const user: User = {
  name: "Alice",
  age: 25,
  scores: [100, 95, 98],
  metadata: {
    joinDate: BigInt(Date.now()),
    rank: "Gold",
  },
};

// Serialize to bytes
const bytes = UserSchema.serialize(user);

// Deserialize back to object
const decoded = UserSchema.deserialize(bytes);
```

## Type System

### Primitive Types

#### Numbers

- Unsigned integers: `u8`, `u16`, `u32`, `u64`, `u128`
- Signed integers: `i8`, `i16`, `i32`, `i64`, `i128`
- Floating point: `f32`, `f64`

```typescript
const schema = b.u64();
const value = BigInt(123456789);
const bytes = schema.serialize(value);
```

#### Other Primitives

- `string`: UTF-8 encoded strings
- `unit`: Empty type (similar to void)

```typescript
const schema = b.string();
const value = "Hello, World!";
const bytes = schema.serialize(value);
```

### Complex Types

#### Option (Nullable Values)

```typescript
const schema = b.option(b.string());
const value: string | null = "hello";
const bytes = schema.serialize(value);
```

#### Arrays and Vectors

```typescript
// Fixed-length array
const fixed = b.array(b.u16(), 3);

// Dynamic-length vector
const dynamic = b.vec(b.u16());
```

#### Sets and Maps

```typescript
// Set of unique values
const setSchema = b.hashSet(b.string());

// Key-value mapping
const mapSchema = b.hashMap(b.string(), b.u128());
```

#### Structs

```typescript
const PersonSchema = b.struct({
  name: b.string(),
  age: b.u8(),
  balance: b.u128(),
});
```

#### Enums

```typescript
// Simple enum
const StatusSchema = b.enum({
  Pending: b.unit(),
  Fulfilled: b.unit(),
  Rejected: b.unit(),
});

// Enum with data
const ShapeSchema = b.enum({
  Square: b.u32(),
  Rectangle: b.struct({
    length: b.u32(),
    width: b.u32(),
  }),
  Circle: b.struct({
    radius: b.u32(),
  }),
});
```

## Complex Example

Here's a more complex example showing nested data structures:

```typescript
// Define game state schemas
const PlayerSchema = b.struct({
  name: b.string(),
  health: b.u8(),
  inventory: b.hashMap(b.string(), b.u16()), // item name -> count
  achievements: b.hashSet(b.string()), // unique achievement IDs
  guild: b.option(b.string()), // optional guild name
  recentScores: b.vec(b.u16()), // dynamic array of scores
});

const GameStateSchema = b.struct({
  players: b.hashMap(b.string(), PlayerSchema), // player ID -> player data
  currentRound: b.u32(),
  nextRoundStart: b.option(b.u32()), // optional timestamp
});

// Use with full type inference
type GameState = b.infer<typeof GameStateSchema>;

const gameState: GameState = {
  players: new Map([
    [
      "player1",
      {
        name: "Alice",
        health: 100,
        inventory: new Map([
          ["sword", 1],
          ["potion", 5],
        ]),
        achievements: new Set(["first_kill", "speedrun"]),
        guild: "Warriors",
        recentScores: [100, 95, 98],
      },
    ],
  ]),
  currentRound: 5,
  nextRoundStart: 1234567890,
};

const bytes = GameStateSchema.serialize(gameState);
const decoded = GameStateSchema.deserialize(bytes);
```

## Binary Format

Zorsh follows the Borsh specification for binary layout:

- Integers are little-endian
- Dynamic containers (vec, hashmap, hashset) are prefixed with u32 length
- Enums are encoded as u8 variant index followed by variant data
- Strings are length-prefixed UTF-8
- Structs are encoded in field definition order
- Option values use u8 discriminator (0 = None, 1 = Some)

## Why Zorsh?

- **Type Safety**: Full TypeScript inference means you can't accidentally serialize the wrong data type
- **Performance**: Direct binary serialization without intermediate JSON or other formats
- **Consistency**: Borsh guarantees a consistent binary representation, making it ideal for hashing and signatures
- **Modern API**: Familiar Zod-like builder pattern makes it easy to define and compose schemas

## Type Inference

Zorsh provides complete type inference through its Zod-like interface:

```typescript
const schema = b.struct({
  id: b.string(),
  data: b.option(b.vec(b.u8())),
  metadata: b.hashMap(b.string(), b.u64()),
});

// TypeScript automatically infers:
type T = b.infer<typeof schema>;
// {
//   id: string
//   data: Uint8Array | null
//   metadata: Map<string, bigint>
// }
```

## Testing

Zorsh includes a comprehensive test suite that verifies both its TypeScript implementation and cross-language compatibility:

- **Unit Tests**: Extensive testing of all serialization types and edge cases
- **Rust Compatibility**: Tests against Rust's Borsh implementation to ensure perfect compatibility
- **Complex Scenarios**: Verification of nested and complex data structure handling

To run the test suite:

```bash
npm test
```

For details about running the Rust compatibility tests, see the [Rust tests documentation](test/rust/README.md).

## Contributing

Contributions are welcome! Feel free to:

- Report bugs
- Suggest features
- Submit pull requests

## License

MIT
