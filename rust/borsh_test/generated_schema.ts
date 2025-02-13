import { b } from "zorsh";

export const AchievementSchema = b.struct({
  id: b.string(),
  name: b.string(),
  description: b.string(),
  reward_points: b.u32(),
  completed_at: b.option(b.u64()),
  prerequisites: b.vec(b.string()),
  });

export type Achievement = b.infer<typeof AchievementSchema>;

export const CharacterClassMageSchema = b.struct({
  base_stats: StatsSchema,
  spells_known: b.vec(b.string()),
  mana_regen: b.f32(),
  });

export type CharacterClassMage = b.infer<typeof CharacterClassMageSchema>;

export const CharacterClassRogueSchema = b.struct({
  base_stats: StatsSchema,
  stealth_level: b.u8(),
  critical_chance: b.f32(),
  });

export type CharacterClassRogue = b.infer<typeof CharacterClassRogueSchema>;

export const GuildMembershipSchema = b.struct({
  guild_id: b.string(),
  guild_name: b.string(),
  joined_at: b.u64(),
  rank: b.string(),
  permissions: b.hashSet(b.string()),
  });

export type GuildMembership = b.infer<typeof GuildMembershipSchema>;

export const ItemSchema = b.struct({
  id: b.string(),
  name: b.string(),
  description: b.string(),
  rarity: b.enum({
  Common: b.unit(),
  Uncommon: b.unit(),
  Rare: b.unit(),
  Epic: b.unit(),
  Legendary: b.unit(),
}),
  level_requirement: b.u8(),
  effects: b.vec(b.enum({
  Damage: b.tuple([b.u32(), ]),
  Heal: b.struct({
    amount: b.u32(),
    duration: b.u16(),
  }),
  Status: b.struct({
    effect_type: b.string(),
    power: b.u16(),
    duration: b.u32(),
  }),
  None: b.unit(),
})),
  stats: b.option(StatsSchema),
  metadata: b.hashMap(b.string(), b.string()),
  });

export type Item = b.infer<typeof ItemSchema>;

export const ItemEffectHealSchema = b.struct({
  amount: b.u32(),
  duration: b.u16(),
  });

export type ItemEffectHeal = b.infer<typeof ItemEffectHealSchema>;

export const ItemEffectStatusSchema = b.struct({
  effect_type: b.string(),
  power: b.u16(),
  duration: b.u32(),
  });

export type ItemEffectStatus = b.infer<typeof ItemEffectStatusSchema>;

export const LocationSchema = b.struct({
  lat: b.f64(),
  lng: b.f64(),
  altitude: b.option(b.u32()),
  });

export type Location = b.infer<typeof LocationSchema>;

export const PlayerCharacterSchema = b.struct({
  id: b.string(),
  name: b.string(),
  created_at: b.u64(),
  last_login: b.u64(),
  character_class: b.enum({
  Warrior: b.tuple([StatsSchema, ]),
  Mage: b.struct({
    base_stats: StatsSchema,
    spells_known: b.vec(b.string()),
    mana_regen: b.f32(),
  }),
  Rogue: b.struct({
    base_stats: StatsSchema,
    stealth_level: b.u8(),
    critical_chance: b.f32(),
  }),
}),
  level: b.u32(),
  experience: b.u64(),
  location: LocationSchema,
  inventory: b.vec(ItemSchema),
  equipped_items: b.hashMap(b.string(), ItemSchema),
  achievements: b.vec(AchievementSchema),
  completed_quests: b.hashSet(b.string()),
  active_quests: b.vec(QuestProgressSchema),
  guild: b.option(GuildMembershipSchema),
  current_trades: b.vec(TradeSchema),
  friends: b.hashSet(b.string()),
  blocked_players: b.hashSet(b.string()),
  settings: b.hashMap(b.string(), b.string()),
  last_deaths: b.vec([b.u64(), LocationSchema, b.string()]),
  skill_levels: b.hashMap(b.string(), [b.u16(), b.f32()]),
  });

export type PlayerCharacter = b.infer<typeof PlayerCharacterSchema>;

export const QuestProgressSchema = b.struct({
  quest_id: b.string(),
  started_at: b.u64(),
  steps_completed: b.vec(b.u32()),
  current_step: b.u32(),
  collected_items: b.hashMap(b.string(), b.u32()),
  });

export type QuestProgress = b.infer<typeof QuestProgressSchema>;

export const StatsSchema = b.struct({
  strength: b.u16(),
  dexterity: b.u16(),
  intelligence: b.u16(),
  health: b.u32(),
  mana: b.u32(),
  });

export type Stats = b.infer<typeof StatsSchema>;

export const TradeSchema = b.struct({
  id: b.string(),
  from_player: b.string(),
  to_player: b.string(),
  items: b.vec(ItemSchema),
  gold_amount: b.u64(),
  status: b.string(),
  created_at: b.u64(),
  completed_at: b.option(b.u64()),
  });

export type Trade = b.infer<typeof TradeSchema>;

