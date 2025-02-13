// src/lib.rs
use borsh::{BorshDeserialize, BorshSerialize};
use std::collections::{HashMap, HashSet};

mod float_test;

#[derive(BorshSerialize, BorshDeserialize, PartialEq, Debug)]
pub enum GameEvent {
    PlayerJoined {
        player_id: String,
    },
    PlayerLeft {
        player_id: String,
    },
    ChatMessage {
        sender: String,
        message: String,
    },
    ItemUsed {
        item_id: String,
        target: Option<String>,
    }, // Option for single-target or area-effect
    BattleResult {
        winner: String,
        loser: String,
        rewards: Vec<Reward>, // Nested struct
    },
}

#[derive(BorshSerialize, BorshDeserialize, PartialEq, Debug)]
pub struct Reward {
    item_id: String,
    quantity: u32,
}

#[derive(BorshSerialize, BorshDeserialize, PartialEq, Debug)]
pub struct Player {
    pub name: String,
    pub level: u8,
    pub stats: Stats,                            // Nested struct
    pub inventory: Vec<Item>,                    // Vec of nested structs
    pub equipped_items: HashMap<String, String>, // Slot -> Item ID
    pub quest_log: HashSet<String>,              // Set of quest IDs
    pub last_login: Option<u64>,                 // Optional timestamp
}

#[derive(BorshSerialize, BorshDeserialize, PartialEq, Debug)]
pub struct Stats {
    pub health: u32,
    pub mana: u32,
    pub attack: u32,
    pub defense: u32,
    pub magic_attack: u32,
    pub magic_defense: u32,
}

#[derive(BorshSerialize, BorshDeserialize, PartialEq, Debug)]
pub struct Item {
    pub id: String,
    pub name: String,
    pub weight: f32,
    pub effects: Vec<Effect>, // Vec of nested enum
}

#[derive(BorshSerialize, BorshDeserialize, PartialEq, Debug)]
pub enum Effect {
    Damage(u32),
    Heal(u32),
    Buff(StatBuff),   // Nested struct
    Debuff(StatBuff), // Nested struct
}

#[derive(BorshSerialize, BorshDeserialize, PartialEq, Debug)]
pub struct StatBuff {
    pub stat: String, // Could be an enum, but string for simplicity
    pub amount: i32,  // Can be positive or negative
}

#[derive(BorshSerialize, BorshDeserialize, PartialEq, Debug)]
pub struct GameState {
    pub players: HashMap<String, Player>, // Map of player ID to Player struct
    pub current_round: u32,
    pub events: Vec<GameEvent>, // Vec of enum
    pub game_version: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use borsh::to_vec;
    use borsh::BorshSerialize;
    use std::fs::File;
    use std::io::Write;

    fn write_test_data<T: BorshSerialize>(
        data: &T,
        base_path: &str,
        name: &str,
    ) -> Result<(), std::io::Error> {
        let bin_path = format!("{}/{}.bin", base_path, name);
        let serialized = to_vec(data)?;
        let mut bin_file = File::create(bin_path)?;
        bin_file.write_all(&serialized)?;
        Ok(())
    }

    #[test]
    #[ignore]
    fn generate_test_data() {
        let test_data_dir = "test_data";
        std::fs::create_dir_all(test_data_dir).expect("Failed to create test_data dir");

        // --- Create some sample data ---

        let mut players = HashMap::new();

        let player1 = Player {
            name: "Alice".to_string(),
            level: 10,
            stats: Stats {
                health: 100,
                mana: 50,
                attack: 20,
                defense: 15,
                magic_attack: 5,
                magic_defense: 10,
            },
            inventory: vec![
                Item {
                    id: "sword_001".to_string(),
                    name: "Iron Sword".to_string(),
                    weight: 2.5,
                    effects: vec![Effect::Damage(15)],
                },
                Item {
                    id: "potion_001".to_string(),
                    name: "Health Potion".to_string(),
                    weight: 0.125,
                    effects: vec![Effect::Heal(50)],
                },
            ],
            equipped_items: HashMap::from([("hand".to_string(), "sword_001".to_string())]),
            quest_log: HashSet::from(["quest_start".to_string(), "collect_herbs".to_string()]),
            last_login: Some(1678886400), // Example timestamp
        };

        let player2 = Player {
            name: "Bob".to_string(),
            level: 5,
            stats: Stats {
                health: 80,
                mana: 75,
                attack: 10,
                defense: 5,
                magic_attack: 30,
                magic_defense: 20,
            },
            inventory: vec![Item {
                id: "staff_001".to_string(),
                name: "Apprentice Staff".to_string(),
                weight: 1.25,
                effects: vec![
                    Effect::Damage(5),
                    Effect::Buff(StatBuff {
                        stat: "magic_attack".to_string(),
                        amount: 10,
                    }),
                ],
            }],
            equipped_items: HashMap::new(),
            quest_log: HashSet::new(),
            last_login: None,
        };

        players.insert("alice_id".to_string(), player1);
        players.insert("bob_id".to_string(), player2);

        let events = vec![
            GameEvent::PlayerJoined {
                player_id: "alice_id".to_string(),
            },
            GameEvent::ChatMessage {
                sender: "alice_id".to_string(),
                message: "Hello, world!".to_string(),
            },
            GameEvent::BattleResult {
                winner: "alice_id".to_string(),
                loser: "bob_id".to_string(),
                rewards: vec![Reward {
                    item_id: "gold_001".to_string(),
                    quantity: 100,
                }],
            },
        ];

        let game_state = GameState {
            players,
            current_round: 3,
            events,
            game_version: "1.2.3".to_string(),
        };

        write_test_data(&game_state, test_data_dir, "complex_game_state")
            .expect("Failed to write game state data");
    }
}
