use borsh::BorshSchema;
use std::collections::{HashMap, HashSet};

#[derive(BorshSchema)]
pub struct Location {
    lat: f64,
    lng: f64,
    altitude: Option<u32>,
}

#[derive(BorshSchema)]
pub enum ItemRarity {
    Common,
    Uncommon,
    Rare,
    Epic,
    Legendary,
}

#[derive(BorshSchema)]
pub struct Stats {
    strength: u16,
    dexterity: u16,
    intelligence: u16,
    health: u32,
    mana: u32,
}

#[derive(BorshSchema)]
pub enum ItemEffect {
    Damage(u32),
    Heal {
        amount: u32,
        duration: u16,
    },
    Status {
        effect_type: String,
        power: u16,
        duration: u32,
    },
    None,
}

#[derive(BorshSchema)]
pub struct Item {
    id: String,
    name: String,
    description: String,
    rarity: ItemRarity,
    level_requirement: u8,
    effects: Vec<ItemEffect>,
    stats: Option<Stats>,
    metadata: HashMap<String, String>,
}

#[derive(BorshSchema)]
pub struct Achievement {
    id: String,
    name: String,
    description: String,
    reward_points: u32,
    completed_at: Option<u64>,
    prerequisites: Vec<String>,
}

#[derive(BorshSchema)]
pub enum CharacterClass {
    Warrior(Stats),
    Mage {
        base_stats: Stats,
        spells_known: Vec<String>,
        mana_regen: f32,
    },
    Rogue {
        base_stats: Stats,
        stealth_level: u8,
        critical_chance: f32,
    },
}

#[derive(BorshSchema)]
pub struct GuildMembership {
    guild_id: String,
    guild_name: String,
    joined_at: u64,
    rank: String,
    permissions: HashSet<String>,
}

#[derive(BorshSchema)]
pub struct Trade {
    id: String,
    from_player: String,
    to_player: String,
    items: Vec<Item>,
    gold_amount: u64,
    status: String,
    created_at: u64,
    completed_at: Option<u64>,
}

#[derive(BorshSchema)]
pub struct QuestProgress {
    quest_id: String,
    started_at: u64,
    steps_completed: Vec<u32>,
    current_step: u32,
    collected_items: HashMap<String, u32>,
}

#[derive(BorshSchema)]
pub struct PlayerCharacter {
    id: String,
    name: String,
    created_at: u64,
    last_login: u64,
    character_class: CharacterClass,
    level: u32,
    experience: u64,
    location: Location,
    inventory: Vec<Item>,
    equipped_items: HashMap<String, Item>,
    achievements: Vec<Achievement>,
    completed_quests: HashSet<String>,
    active_quests: Vec<QuestProgress>,
    guild: Option<GuildMembership>,
    current_trades: Vec<Trade>,
    friends: HashSet<String>,
    blocked_players: HashSet<String>,
    settings: HashMap<String, String>,
    // Tuple test
    last_deaths: Vec<(u64, Location, String)>, // timestamp, location, cause
    skill_levels: HashMap<String, (u16, f32)>, // skill name -> (level, progress)
}

#[cfg(test)]
mod tests {
    use super::*;
    use borsh::schema::BorshSchemaContainer;
    use std::fs;

    #[test]
    fn test_complex_schema() -> std::io::Result<()> {
        let container = BorshSchemaContainer::for_type::<PlayerCharacter>();
        let data = borsh::to_vec(&container).unwrap();
        fs::write("test_data/complex_schema.bin", data)?;
        Ok(())
    }
}
