import { b } from "./schema";

// Define a schema
const UserSchema = b.struct({
	name: b.string(),
	age: b.u8(),
	scores: b.vec(b.u16()),
	metadata: b.option(
		b.struct({
			joinDate: b.u64(),
			rank: b.string(),
		}),
	),
});

// Get the type from the schema using b.infer
type User = b.infer<typeof UserSchema>;

// TypeScript infers this as:
// type User = {
//   name: string
//   age: number
//   scores: number[]
//   metadata: {
//     joinDate: bigint
//     rank: string
//   } | null
// }

// Use the inferred type
const user: User = {
	name: "Alice",
	age: 25,
	scores: [100, 95, 98],
	metadata: {
		joinDate: BigInt(Date.now()),
		rank: "Gold",
	},
};

const bytes = UserSchema.serialize(user);
const decoded = UserSchema.deserialize(bytes);
console.log("Decoded:", decoded);
