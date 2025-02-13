// src/complex-schema.ts
import { b } from "../../src/schema"

const StatBuffSchema = b.struct({
  stat: b.string(),
  amount: b.i32(),
})

const EffectSchema = b.enum({
  Damage: b.u32(),
  Heal: b.u32(),
  Buff: StatBuffSchema,
  Debuff: StatBuffSchema,
})

const ItemSchema = b.struct({
  id: b.string(),
  name: b.string(),
  weight: b.f32(),
  effects: b.vec(EffectSchema),
})
type Item = b.infer<typeof ItemSchema>

const StatsSchema = b.struct({
  health: b.u32(),
  mana: b.u32(),
  attack: b.u32(),
  defense: b.u32(),
  magic_attack: b.u32(),
  magic_defense: b.u32(),
})

const PlayerSchema = b.struct({
  name: b.string(),
  level: b.u8(),
  stats: StatsSchema,
  inventory: b.vec(ItemSchema),
  equipped_items: b.hashMap(b.string(), b.string()),
  quest_log: b.hashSet(b.string()),
  last_login: b.option(b.u64()),
})
type Player = b.infer<typeof PlayerSchema>

const RewardSchema = b.struct({
  item_id: b.string(),
  quantity: b.u32(),
})

const GameEventSchema = b.enum({
  PlayerJoined: b.struct({ player_id: b.string() }),
  PlayerLeft: b.struct({ player_id: b.string() }),
  ChatMessage: b.struct({ sender: b.string(), message: b.string() }),
  ItemUsed: b.struct({ item_id: b.string(), target: b.option(b.string()) }),
  BattleResult: b.struct({
    winner: b.string(),
    loser: b.string(),
    rewards: b.vec(RewardSchema),
  }),
})

const GameStateSchema = b.struct({
  players: b.hashMap(b.string(), PlayerSchema),
  current_round: b.u32(),
  events: b.vec(GameEventSchema),
  game_version: b.string(),
})
type GameState = b.infer<typeof GameStateSchema>

export { GameStateSchema, type GameState, PlayerSchema, type Player, ItemSchema, type Item }
