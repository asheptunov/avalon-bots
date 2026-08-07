// Protocol codec -- a direct port of avalon_bot.py's binary reader/writer.
//
// Same wire format, same field order, same quirks. The only thing that changes
// versus the Python client is the transport: there we owned the socket, here we
// piggyback on the one the game page already opened (see hook.js). Everything
// below is pure data<->bytes and has no idea which socket it came from.
//
// Frames are little-endian; strings are u16 byte-length + utf-8.

// Client->server binary opcodes.
export const OP_MOVE = 1;
export const OP_ATTACK = 2;

// Server->client frame opcodes.
export const SRV_SNAPSHOT = 1;
export const SRV_COMBAT_EVENT = 2;
export const SRV_ENTITY_DIED = 3;

export const TILE = 32; // px per tile, from the `welcome` message
export const MELEE_RANGE_PX = 40;

export const MONSTER_TYPES = [
  'rat', 'caveBat', 'orc', 'goblin', 'ghost', 'orcZealot', 'orrinVale',
  'iceWizard', 'wraith', 'hellMage', 'lizardman', 'hellArchmage',
  'trainingDummy',
];
export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
export const GENDERS = ['male', 'female'];

const PK_TIER_MASK = 0x3f;
const PVP_FLAG_BIT = 0x40;

const UTF8 = new TextDecoder('utf-8');
const UTF8ENC = new TextEncoder();

/** Sequential little-endian reader over an ArrayBuffer. Mirrors Python's Reader. */
export class Reader {
  constructor(buf) {
    this.view = new DataView(buf);
    this.bytes = new Uint8Array(buf);
    this.o = 0;
  }
  u8() { return this.view.getUint8(this.o++); }
  i8() { return this.view.getInt8(this.o++); }
  u16() { const v = this.view.getUint16(this.o, true); this.o += 2; return v; }
  u32() { const v = this.view.getUint32(this.o, true); this.o += 4; return v; }
  f32() { const v = this.view.getFloat32(this.o, true); this.o += 4; return v; }
  f64() { const v = this.view.getFloat64(this.o, true); this.o += 8; return v; }
  string() {
    const n = this.u16();
    const s = UTF8.decode(this.bytes.subarray(this.o, this.o + n));
    this.o += n;
    return s;
  }
}

/** dx/dy are -1, 0 or 1 -- a movement *intent*, not a step. */
export function encodeMove(dx, dy) {
  const b = new ArrayBuffer(3);
  const v = new DataView(b);
  v.setUint8(0, OP_MOVE);
  v.setInt8(1, dx);
  v.setInt8(2, dy);
  return b;
}

export function encodeAttack(targetId) {
  const raw = UTF8ENC.encode(targetId);
  const b = new ArrayBuffer(3 + raw.length);
  const v = new DataView(b);
  v.setUint8(0, OP_ATTACK);
  v.setUint16(1, raw.length, true);
  new Uint8Array(b).set(raw, 3);
  return b;
}

/** Nested item struct; containers recurse via the `contents` flag. */
export function readItem(r) {
  const instanceId = r.string();
  const itemId = r.string();
  const rarity = r.u8();
  const item = {
    instanceId,
    itemId,
    rarity: rarity < RARITIES.length ? RARITIES[rarity] : 'common',
    quantity: r.u16(),
  };
  if (r.u8() === 1) item.lit = true;
  if (r.u8() === 1) {
    const n = r.u8();
    const contents = [];
    for (let i = 0; i < n; i++) contents.push(r.u8() === 1 ? readItem(r) : null);
    item.contents = contents;
  }
  return item;
}

/**
 * Decode a server snapshot frame into plain objects.
 *
 * `knownGroundRev`/`knownZ` reproduce the server's bandwidth trick: ground items
 * are only re-sent when the revision changes, so an unchanged snapshot returns
 * groundItems === null meaning "unchanged", NOT "the floor is empty". The caller
 * (bot.js) carries the last known list forward -- getting this wrong makes the
 * floor look empty on ~99% of ticks and looting silently never fires.
 */
export function decodeSnapshot(buf, knownGroundRev = -1, knownZ = null) {
  const r = new Reader(buf);
  r.u8(); // opcode, already known to be SRV_SNAPSHOT
  const z = r.i8();
  const out = { z, players: [], monsters: [], npcs: [], groundItems: null };

  let n = r.u16();
  for (let i = 0; i < n; i++) {
    const id = r.string();
    const name = r.string();
    const x = r.f32();
    const y = r.f32();
    const hp = r.u16();
    const maxHp = r.u16();
    const level = r.u16();
    const g = r.u8();
    const lightRadiusPx = r.u16();
    const flags = r.u8();
    out.players.push({
      id, name, x, y, z, hp, maxHp, level,
      gender: g < GENDERS.length ? GENDERS[g] : 'male',
      lightRadiusPx,
      pkTier: flags & PK_TIER_MASK,
      pvpFlagOn: !!(flags & PVP_FLAG_BIT),
    });
  }

  n = r.u16();
  for (let i = 0; i < n; i++) {
    const id = r.string();
    const t = r.u8();
    out.monsters.push({
      id,
      monsterType: t < MONSTER_TYPES.length ? MONSTER_TYPES[t] : 'unknown',
      x: r.f32(), y: r.f32(), z,
      hp: r.u16(), maxHp: r.u16(), enraged: r.u8() === 1,
    });
  }

  n = r.u8();
  for (let i = 0; i < n; i++) {
    out.npcs.push({
      id: r.string(), npcType: r.string(), name: r.string(),
      x: r.f32(), y: r.f32(), z,
    });
  }

  const groundRev = r.u32();
  out.groundRev = groundRev;
  if (groundRev === knownGroundRev && z === knownZ) return out;

  const items = [];
  n = r.u16();
  for (let i = 0; i < n; i++) {
    const id = r.string();
    const x = r.f32();
    const y = r.f32();
    const owner = r.string();
    const expires = r.f64();
    items.push({
      id, x, y, z, item: readItem(r),
      ownerId: owner || null, ownerExpiresAt: expires,
    });
  }
  out.groundItems = items;
  return out;
}

export function decodeCombatEvent(buf) {
  const r = new Reader(buf);
  r.u8();
  const ev = {
    attackerId: r.string(), targetId: r.string(),
    damage: r.u16(), targetHpAfter: r.u16(), targetMaxHp: r.u16(),
  };
  const f = r.u8();
  ev.crit = !!(f & 1);
  ev.spell = !!(f & 2);
  ev.blocked = !!(f & 4);
  ev.frost = !!(f & 8);
  return ev;
}
