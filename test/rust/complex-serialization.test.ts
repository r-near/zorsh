import { describe, expect, test } from "vitest";
import { GameStateSchema, type GameState } from "./complex-schema";
import * as fs from "node:fs/promises";
import * as path from "node:path";

describe("Borsh-RS Compatibility (Complex Schema)", () => {
	const testDataDir = path.join(
		__dirname,
		"..",
		"..",
		"rust",
		"borsh_test",
		"test_data",
	);

	test("Complex GameState serialization/deserialization", async () => {
		const binPath = path.join(testDataDir, "complex_game_state.bin");
		const rustBytes = new Uint8Array(await fs.readFile(binPath));
		const decodedFromRust = GameStateSchema.deserialize(rustBytes);

		// Create a matching TypeScript object for comparison.  This is
		// *crucial* for ensuring your schema and types are correct.
		const expectedGameState: GameState = {
			players: new Map([
				[
					"alice_id",
					{
						name: "Alice",
						level: 10,
						stats: {
							health: 100,
							mana: 50,
							attack: 20,
							defense: 15,
							magic_attack: 5,
							magic_defense: 10,
						},
						inventory: [
							{
								id: "sword_001",
								name: "Iron Sword",
								weight: 2.5,
								effects: [{ Damage: 15 }],
							},
							{
								id: "potion_001",
								name: "Health Potion",
								weight: 0.125,
								effects: [{ Heal: 50 }],
							},
						],
						equipped_items: new Map([["hand", "sword_001"]]),
						quest_log: new Set(["quest_start", "collect_herbs"]),
						last_login: 1678886400n, // Use BigInt for u64
					},
				],
				[
					"bob_id",
					{
						name: "Bob",
						level: 5,
						stats: {
							health: 80,
							mana: 75,
							attack: 10,
							defense: 5,
							magic_attack: 30,
							magic_defense: 20,
						},
						inventory: [
							{
								id: "staff_001",
								name: "Apprentice Staff",
								weight: 1.25,
								effects: [
									{ Damage: 5 },
									{ Buff: { stat: "magic_attack", amount: 10 } },
								],
							},
						],
						equipped_items: new Map(),
						quest_log: new Set(),
						last_login: null,
					},
				],
			]),
			current_round: 3,
			events: [
				{ PlayerJoined: { player_id: "alice_id" } },
				{ ChatMessage: { sender: "alice_id", message: "Hello, world!" } },
				{
					BattleResult: {
						winner: "alice_id",
						loser: "bob_id",
						rewards: [{ item_id: "gold_001", quantity: 100 }],
					},
				},
			],
			game_version: "1.2.3",
		};

		// Deserialize Rust bytes and compare
		expect(decodedFromRust).toEqual(expectedGameState);

		// Serialize TypeScript data and compare to Rust bytes
		const serializedTs = GameStateSchema.serialize(expectedGameState);
		expect(serializedTs).toEqual(rustBytes);
	});
});
