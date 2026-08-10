// Port-fidelity tests: the JS must behave like the Python it was ported from.
//
// Run: node web/test/test_port.mjs
//
// These target the decisions that were expensive to learn on the Python side --
// the ones a careless port silently drops: groundItems null-vs-empty, corpse
// contents, retreat hysteresis, canDisengage, wellFed, stack merging, and A*
// corner-cutting. Round-trip encode/decode covers the wire format.

import assert from 'node:assert/strict';
import { test } from 'node:test';
// Import via file:// URLs -- on Windows a bare absolute path ('C:\...') is not
// a valid ESM specifier.
const SRC = new URL('../src/core/', import.meta.url);
const load = (m) => import(new URL(m, SRC).href);

const { decodeSnapshot, encodeMove, encodeAttack, Reader, TILE } =
  await load('protocol.js');
const { AvalonBot } = await load('bot.js');
const nav = await load('nav.js');
const farm = await load('farm.js');

// ---- helpers to build server frames ---------------------------------------

class W {
  constructor() { this.b = []; }
  u8(v) { this.b.push(v & 0xff); return this; }
  i8(v) { this.b.push(v < 0 ? v + 256 : v); return this; }
  u16(v) { this.b.push(v & 0xff, (v >> 8) & 0xff); return this; }
  u32(v) { for (let i = 0; i < 4; i++) this.b.push((v >>> (8 * i)) & 0xff); return this; }
  f32(v) { const a = new Uint8Array(4); new DataView(a.buffer).setFloat32(0, v, true); this.b.push(...a); return this; }
  f64(v) { const a = new Uint8Array(8); new DataView(a.buffer).setFloat64(0, v, true); this.b.push(...a); return this; }
  str(s) { const e = new TextEncoder().encode(s); this.u16(e.length); this.b.push(...e); return this; }
  buf() { return new Uint8Array(this.b).buffer; }
}

function item(w, { instanceId, itemId, quantity = 1, contents = null }) {
  w.str(instanceId).str(itemId).u8(0).u16(quantity).u8(0);
  if (contents) {
    w.u8(1).u8(contents.length);
    for (const c of contents) {
      if (c) { w.u8(1); item(w, c); } else w.u8(0);
    }
  } else w.u8(0);
  return w;
}

function snapshot({ z = 0, players = [], monsters = [], npcs = [], groundRev = 1, ground = null }) {
  const w = new W();
  w.u8(1).i8(z);
  w.u16(players.length);
  for (const p of players) {
    w.str(p.id).str(p.name).f32(p.x).f32(p.y)
      .u16(p.hp).u16(p.maxHp).u16(p.level || 1).u8(0).u16(0).u8(0);
  }
  w.u16(monsters.length);
  for (const m of monsters) {
    w.str(m.id).u8(m.type ?? 0).f32(m.x).f32(m.y)
      .u16(m.hp).u16(m.maxHp).u8(m.enraged ? 1 : 0);
  }
  w.u8(npcs.length);
  for (const n of npcs) w.str(n.id).str(n.npcType).str(n.name).f32(n.x).f32(n.y);
  w.u32(groundRev);
  if (ground) {
    w.u16(ground.length);
    for (const g of ground) {
      w.str(g.id).f32(g.x).f32(g.y).str(g.ownerId || '').f64(g.expires || 0);
      item(w, g.item);
    }
  }
  return w.buf();
}

const player = (o) => ({ id: 'me', name: 'Me', x: 100, y: 100, hp: 100, maxHp: 100, ...o });

function makeBot() {
  const sent = [];
  const bot = new AvalonBot((p) => { sent.push(p); return true; });
  bot.me = 'me';
  bot.sent = sent;
  return bot;
}

// ---- wire format ----------------------------------------------------------

test('encodeMove packs opcode + signed deltas', () => {
  const r = new Reader(encodeMove(-1, 1));
  assert.equal(r.u8(), 1);
  assert.equal(r.i8(), -1);
  assert.equal(r.i8(), 1);
});

test('encodeAttack packs length-prefixed target id', () => {
  const r = new Reader(encodeAttack('mob-7'));
  assert.equal(r.u8(), 2);
  assert.equal(r.u16(), 5);
});

test('decodeSnapshot reads players, monsters, npcs and negative z', () => {
  const buf = snapshot({
    z: -2,
    players: [player({ x: 64, y: 96, hp: 42 })],
    monsters: [{ id: 'r1', type: 0, x: 70, y: 90, hp: 5, maxHp: 10, enraged: true }],
    npcs: [{ id: 'n1', npcType: 'healer', name: 'Brother Aldric' }],
    ground: [],
  });
  const s = decodeSnapshot(buf);
  assert.equal(s.z, -2);
  assert.equal(s.players[0].hp, 42);
  assert.equal(s.players[0].z, -2);
  assert.equal(s.monsters[0].monsterType, 'rat');
  assert.equal(s.monsters[0].enraged, true);
  assert.equal(s.npcs[0].name, 'Brother Aldric');
});

test('nested corpse contents decode recursively', () => {
  const buf = snapshot({
    players: [player()],
    ground: [{
      id: 'g1', x: 100, y: 100,
      item: {
        instanceId: 'c1', itemId: 'corpse',
        contents: [{ instanceId: 'i1', itemId: 'rawMeat', quantity: 2 }, null],
      },
    }],
  });
  const s = decodeSnapshot(buf);
  const c = s.groundItems[0].item;
  assert.equal(c.itemId, 'corpse');
  assert.equal(c.contents.length, 2);
  assert.equal(c.contents[0].itemId, 'rawMeat');
  assert.equal(c.contents[1], null);
});

// ---- the bandwidth trick that breaks looting if missed ---------------------

test('unchanged groundRev yields null, and the bot carries the last list forward', () => {
  const bot = makeBot();
  const g = [{ id: 'g1', x: 10, y: 10, item: { instanceId: 'i1', itemId: 'apple' } }];
  const first = bot.onBinary(snapshot({ players: [player()], groundRev: 7, ground: g }));
  assert.equal(first.groundItems.length, 1);

  // Same revision -> the server omits the list entirely.
  const raw = snapshot({ players: [player()], groundRev: 7, ground: null });
  assert.equal(decodeSnapshot(raw, 7, 0).groundItems, null,
    'decoder must report null for "unchanged"');

  const second = bot.onBinary(raw);
  assert.equal(second.groundItems.length, 1,
    'bot must carry the floor forward, not report an empty floor');
});

test('a changed groundRev replaces the carried list', () => {
  const bot = makeBot();
  bot.onBinary(snapshot({
    players: [player()], groundRev: 1,
    ground: [{ id: 'g1', x: 10, y: 10, item: { instanceId: 'i1', itemId: 'apple' } }],
  }));
  const s = bot.onBinary(snapshot({ players: [player()], groundRev: 2, ground: [] }));
  assert.equal(s.groundItems.length, 0, 'an emptied floor must actually empty');
});

// ---- inventory helpers ----------------------------------------------------

test('iterItems recurses into containers; packSpace counts null slots', () => {
  const bot = makeBot();
  bot.equipment = {
    back: {
      instanceId: 'bp', itemId: 'backpack',
      contents: [{ instanceId: 'a', itemId: 'apple', quantity: 3 }, null, null],
    },
    hand: { instanceId: 'sw', itemId: 'sword' },
  };
  const ids = [...bot.iterItems()].map((i) => i.itemId).sort();
  assert.deepEqual(ids, ['apple', 'backpack', 'sword']);
  assert.equal(bot.countItem('apple'), 3);
  assert.deepEqual(bot.packSpace(), [2, 3]);
  assert.equal(bot.backpack().instanceId, 'bp');
});

test('hasStatus reads wellFed -- the flag HP regen depends on', () => {
  const bot = makeBot();
  assert.equal(bot.hasStatus('wellFed'), false);
  bot.onJson({ type: 'playerStats', stats: { statusEffects: [{ kind: 'wellFed' }] } });
  assert.equal(bot.hasStatus('wellFed'), true);
});

// ---- loot selection -------------------------------------------------------

test('lootCandidates yields corpse CONTENTS, never the corpse itself', () => {
  const bot = makeBot();
  const snap = decodeSnapshot(snapshot({
    players: [player()],
    ground: [{
      id: 'g1', x: 100, y: 100,
      item: {
        instanceId: 'c1', itemId: 'corpse',
        contents: [{ instanceId: 'i1', itemId: 'gold', quantity: 9 }],
      },
    }],
  }));
  const got = [...farm.lootCandidates(bot, snap)];
  assert.equal(got.length, 1);
  assert.equal(got[0][1].itemId, 'gold');
});

test("loot owned by someone else is skipped", () => {
  const bot = makeBot();
  const snap = decodeSnapshot(snapshot({
    players: [player()],
    ground: [
      { id: 'g1', x: 100, y: 100, ownerId: 'someone-else', item: { instanceId: 'i1', itemId: 'gold' } },
      { id: 'g2', x: 101, y: 100, ownerId: 'me', item: { instanceId: 'i2', itemId: 'apple' } },
    ],
  }));
  const got = [...farm.lootCandidates(bot, snap)].map((c) => c[1].itemId);
  assert.deepEqual(got, ['apple'], 'reserved drops must not be chased');
});

// ---- combat policy --------------------------------------------------------

test('canDisengage is false while a monster is on top of us', () => {
  const me = { x: 100, y: 100 };
  const close = { monsters: [{ hp: 3, x: 100 + TILE, y: 100 }] };
  const far = { monsters: [{ hp: 3, x: 100 + TILE * 10, y: 100 }] };
  const dead = { monsters: [{ hp: 0, x: 100, y: 100 }] };
  assert.equal(farm.canDisengage(me, close), false,
    'fleeing an engaged monster feeds it free hits -- this killed Sam');
  assert.equal(farm.canDisengage(me, far), true);
  assert.equal(farm.canDisengage(me, dead), true);
});

test('nearestHuntable respects the hunt filter and ignores corpses', () => {
  const snap = {
    monsters: [
      { id: 'o', monsterType: 'orc', hp: 9, maxHp: 9, x: 101, y: 100 },
      { id: 'r', monsterType: 'rat', hp: 4, maxHp: 4, x: 140, y: 100 },
      { id: 'd', monsterType: 'rat', hp: 0, maxHp: 4, x: 100, y: 100 },
    ],
  };
  const me = { x: 100, y: 100 };
  assert.equal(farm.nearestHuntable(snap, me, ['rat']).id, 'r');
  assert.equal(farm.nearestHuntable(snap, me, null).id, 'o');
  assert.equal(farm.nearestHuntable(snap, me, ['ghost']), null);
});

test('nameMatches is forgiving about underscores, case and first names', () => {
  for (const q of ['sam', 'sam_altman', 'Sam Altman', 'SAM']) {
    assert.equal(farm.nameMatches(q, 'Sam Altman'), true, q);
  }
  assert.equal(farm.nameMatches('dario', 'Sam Altman'), false);
});

test('findNpc falls back to a known healer when given no query', () => {
  const snap = { npcs: [{ id: 'n1', npcType: 'shop', name: 'Merchant' },
                        { id: 'n2', npcType: 'healer', name: 'Brother Aldric' }] };
  assert.equal(farm.findNpc(snap).id, 'n2');
  assert.equal(farm.findNpc(snap, 'merchant').id, 'n1');
});

// ---- navigation -----------------------------------------------------------

const GRID = {
  bundle: 'test',
  0: {
    widthTiles: 7, heightTiles: 5,
    rows: ['.......', '.......', '..###..', '.......', '.......'],
    teleports: [
      { fromTile: [1, 1], toTile: [1, 1], toZ: -1, oneWay: false, mode: 'walk' },
      { fromTile: [5, 3], toTile: [5, 3], toZ: 1, oneWay: false, mode: 'interact' },
    ],
  },
};

test('A* routes around a wall instead of through it', () => {
  nav.loadMaps(GRID);
  const path = nav.findPath(0, [3, 1], [3, 3]);
  assert.ok(path.length > 0, 'must find a route');
  for (const [x, y] of path) {
    assert.notEqual(GRID[0].rows[y][x], '#', `path enters a wall at ${x},${y}`);
  }
  assert.deepEqual(path[path.length - 1], [3, 3]);
});

test('A* returns [] when the goal is walled in beyond the snap radius', () => {
  nav.loadMaps({
    bundle: 't',
    0: { widthTiles: 5, heightTiles: 5,
         rows: ['.....', '.###.', '.#.#.', '.###.', '.....'], teleports: [] },
  });
  assert.deepEqual(nav.findPath(0, [0, 0], [2, 2], null, 500), [],
    'a sealed pocket is unreachable');
});

test('diagonals may not cut a wall corner', () => {
  nav.loadMaps({
    bundle: 't',
    0: { widthTiles: 3, heightTiles: 3, rows: ['...', '.#.', '...'], teleports: [] },
  });
  const path = nav.findPath(0, [0, 1], [2, 1]);
  assert.ok(path.every(([x, y]) => !(x === 1 && y === 1)));
});

test('tileOf rounds (matches the server), it does not floor', () => {
  assert.equal(nav.tileOf(2067), 65, 'server labels px 2067 as tile 65');
  assert.equal(nav.tileOf(TILE * 4 + 20), 5, 'straddling a boundary rounds up');
});

test('teleport lookup finds the nearest down-hole and up-ladder', () => {
  nav.loadMaps(GRID);
  assert.equal(nav.nearestTeleport(0, -1, [1, 1]).mode, 'walk');
  assert.equal(nav.nearestTeleport(0, -1, [1, 1], 'interact'), null);
  assert.deepEqual(nav.nearestUpwardTeleport(0, [5, 3]).fromTile, [5, 3]);
});

test('unknown z is treated as open ground so movement still degrades safely', () => {
  nav.loadMaps(GRID);
  assert.equal(nav.haveMap(-9), false);
  assert.equal(nav.walkable(-9, 0, 0), true);
  const step = nav.pathStep({ run: {} }, { x: 0, y: 0 }, -9, [320, 0]);
  assert.deepEqual(step, [1, 0], 'greedy fallback with no map');
});

test('pathStep walks the cached path and repaths when the goal moves', () => {
  nav.loadMaps(GRID);
  const bot = { run: {} };
  const me = { x: 3 * TILE, y: 1 * TILE };
  const step = nav.pathStep(bot, me, 0, [3 * TILE, 3 * TILE]);
  assert.ok(bot.run.path, 'path is cached in the per-run state');
  assert.ok(Math.abs(step[0]) <= 1 && Math.abs(step[1]) <= 1);
  const goal = [bot.run.path.goalX, bot.run.path.goalY];
  nav.pathStep(bot, me, 0, [5 * TILE, 3 * TILE]);
  assert.notDeepEqual([bot.run.path.goalX, bot.run.path.goalY], goal,
    'goal change repaths');
});

// ---- the farm state machine -----------------------------------------------

function runTick(bot, snap, cfg = {}) {
  const logs = [];
  const tick = farm.makeFarm(new farm.FarmConfig(cfg), (m) => logs.push(m));
  tick(bot, snap);
  return logs;
}

function withBackpack(bot, contents = []) {
  bot.equipment = { back: { instanceId: 'bp', itemId: 'backpack', contents } };
  return bot;
}

test('a dead bot respawns and does nothing else', () => {
  const bot = withBackpack(makeBot());
  const snap = decodeSnapshot(snapshot({ players: [player({ hp: 0 })], ground: [] }));
  runTick(bot, snap);
  const msgs = bot.sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s).type);
  assert.ok(msgs.includes('respawn'));
});

test('retreat/resume is hysteretic: it does not flip at a single threshold', () => {
  const bot = withBackpack(makeBot());
  const at = (hp) => decodeSnapshot(snapshot({ players: [player({ hp })], ground: [] }));
  const cfg = { retreatFrac: 0.35, resumeFrac: 0.85, eat: false, cook: false, stack: false };

  runTick(bot, at(30), cfg);
  assert.equal(bot.fleeing, true, 'below retreat -> flee');
  runTick(bot, at(50), cfg);
  assert.equal(bot.fleeing, true, 'between the lines -> KEEP fleeing (hysteresis)');
  runTick(bot, at(90), cfg);
  assert.equal(bot.fleeing, false, 'above resume -> fight again');
  runTick(bot, at(50), cfg);
  assert.equal(bot.fleeing, false, 'between the lines -> keep fighting');
});

test('a hurt bot cornered by a monster fights instead of feeding it free hits', () => {
  const bot = withBackpack(makeBot());
  const snap = decodeSnapshot(snapshot({
    players: [player({ hp: 20 })],
    monsters: [{ id: 'r1', type: 0, x: 110, y: 100, hp: 3, maxHp: 5 }],
    ground: [],
  }));
  runTick(bot, snap, { eat: false, cook: false, stack: false });
  assert.equal(bot.fleeing, true);
  const attacked = bot.sent.some(
    (s) => s instanceof ArrayBuffer && new Uint8Array(s)[0] === 2);
  assert.ok(attacked, 'must attack the adjacent monster, not walk away from it');
});

test('an unfed bot eats before doing anything else', () => {
  const bot = withBackpack(makeBot(),
    [{ instanceId: 'f1', itemId: 'apple', quantity: 1 }]);
  bot.equipment.back.contents = [{ instanceId: 'f1', itemId: 'apple', quantity: 1 }];
  const snap = decodeSnapshot(snapshot({ players: [player()], ground: [] }));
  runTick(bot, snap, { cook: false, stack: false });
  const used = bot.sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s))
    .find((m) => m.type === 'useItem');
  assert.ok(used, 'wellFed is the only thing that regenerates HP');
  assert.equal(used.instanceId, 'f1');
});

test('a wellFed bot does not eat', () => {
  const bot = withBackpack(makeBot(),
    [{ instanceId: 'f1', itemId: 'apple', quantity: 1 }]);
  bot.stats = { statusEffects: [{ kind: 'wellFed' }] };
  const snap = decodeSnapshot(snapshot({ players: [player()], ground: [] }));
  runTick(bot, snap, { cook: false, stack: false });
  const used = bot.sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s))
    .some((m) => m.type === 'useItem');
  assert.equal(used, false);
});

test('eating prefers the shortest-lasting food, saving the good stuff', () => {
  const bot = withBackpack(makeBot(), [
    { instanceId: 'fish', itemId: 'fish', quantity: 1 },      // 1200s
    { instanceId: 'apple', itemId: 'apple', quantity: 1 },    // 120s
  ]);
  const snap = decodeSnapshot(snapshot({ players: [player()], ground: [] }));
  runTick(bot, snap, { cook: false, stack: false });
  const used = bot.sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s))
    .find((m) => m.type === 'useItem');
  assert.equal(used.instanceId, 'apple', 'a 2-minute apple does the job right now');
});

test('raw meat is cooked before it is eaten', () => {
  const bot = withBackpack(makeBot(),
    [{ instanceId: 'm1', itemId: 'rawMeat', quantity: 1 }]);
  bot.stats = { statusEffects: [{ kind: 'wellFed' }] };  // isolate cooking from eating
  const snap = decodeSnapshot(snapshot({ players: [player()], ground: [] }));
  runTick(bot, snap, { stack: false });
  const used = bot.sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s))
    .find((m) => m.type === 'useItem');
  assert.ok(used && used.instanceId === 'm1', 'cookedMeat lasts >2x rawMeat');
});

test('split stacks are merged smallest-into-largest to free a slot', () => {
  const bot = withBackpack(makeBot(), [
    { instanceId: 'g1', itemId: 'gold', quantity: 5 },
    { instanceId: 'g2', itemId: 'gold', quantity: 40 },
  ]);
  bot.stats = { statusEffects: [{ kind: 'wellFed' }] };
  const snap = decodeSnapshot(snapshot({ players: [player()], ground: [] }));
  runTick(bot, snap, { cook: false });
  const mv = bot.sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s))
    .find((m) => m.type === 'moveItem');
  assert.ok(mv, 'should merge');
  assert.equal(mv.instanceId, 'g1', 'pour the small stack into the big one');
  assert.equal(mv.to.slotIndex, 1);
});

test('equipment never merges even when duplicated', () => {
  const bot = withBackpack(makeBot(), [
    { instanceId: 's1', itemId: 'sword', quantity: 1 },
    { instanceId: 's2', itemId: 'sword', quantity: 1 },
  ]);
  bot.stats = { statusEffects: [{ kind: 'wellFed' }] };
  const snap = decodeSnapshot(snapshot({ players: [player()], ground: [] }));
  runTick(bot, snap, { cook: false });
  const mv = bot.sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s))
    .some((m) => m.type === 'moveItem');
  assert.equal(mv, false, 'a second sword is not a merge candidate');
});

test('loot within reach is taken out of the corpse', () => {
  const bot = withBackpack(makeBot(), [null, null]);
  bot.stats = { statusEffects: [{ kind: 'wellFed' }] };
  const snap = decodeSnapshot(snapshot({
    players: [player()],
    ground: [{
      id: 'g1', x: 100, y: 100,
      item: {
        instanceId: 'c1', itemId: 'corpse',
        contents: [{ instanceId: 'i1', itemId: 'gold', quantity: 9 }],
      },
    }],
  }));
  runTick(bot, snap, { cook: false, stack: false });
  const mv = bot.sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s))
    .find((m) => m.type === 'moveItem');
  assert.ok(mv, 'should loot');
  assert.equal(mv.instanceId, 'i1', 'take the contents, not the corpse');
  assert.equal(mv.to.containerInstanceId, 'bp');
});

test('a full backpack warns once and keeps fighting instead of looting', () => {
  // bank:false -- with banking on, a full pack goes to the depot instead of
  // warning (test_depot.mjs covers that). This still pins the no-bank fallback:
  // a full bag stops LOOTING, never fighting.
  const bot = withBackpack(makeBot(), [{ instanceId: 'x', itemId: 'rock' }]);
  bot.stats = { statusEffects: [{ kind: 'wellFed' }] };
  const snap = decodeSnapshot(snapshot({
    players: [player()],
    ground: [{ id: 'g1', x: 100, y: 100, item: { instanceId: 'i1', itemId: 'gold' } }],
  }));
  const logs = runTick(bot, snap, { cook: false, stack: false, bank: false });
  assert.ok(logs.some((l) => l.includes('BACKPACK FULL')));
  const mv = bot.sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s))
    .some((m) => m.type === 'moveItem');
  assert.equal(mv, false);
});

test('an in-melee monster is fought before nearby loot is collected', () => {
  const bot = withBackpack(makeBot(), [null, null]);
  bot.stats = { statusEffects: [{ kind: 'wellFed' }] };
  const snap = decodeSnapshot(snapshot({
    players: [player()],
    monsters: [{ id: 'r1', type: 0, x: 110, y: 100, hp: 4, maxHp: 5 }],
    ground: [{ id: 'g1', x: 104, y: 100, item: { instanceId: 'i1', itemId: 'gold' } }],
  }));
  runTick(bot, snap, { cook: false, stack: false, huntTypes: ['rat'] });
  const attacked = bot.sent.some(
    (s) => s instanceof ArrayBuffer && new Uint8Array(s)[0] === 2);
  assert.ok(attacked, 'a monster already in melee comes first');
});

test('with no prey and no loot the bot roams rather than standing still', () => {
  const bot = withBackpack(makeBot(), [null]);
  bot.stats = { statusEffects: [{ kind: 'wellFed' }] };
  const snap = decodeSnapshot(snapshot({ players: [player()], ground: [] }));
  const logs = runTick(bot, snap, { cook: false, stack: false });
  assert.ok(logs.some((l) => l.includes('ROAM')));
  assert.ok(bot.run.farmRoamGoal, 'picks a wander target');
});

test('untilHpFrac stops the loop', () => {
  const bot = withBackpack(makeBot(), [null]);
  bot.stats = { statusEffects: [{ kind: 'wellFed' }] };
  const snap = decodeSnapshot(snapshot({ players: [player({ hp: 20 })], ground: [] }));
  runTick(bot, snap, { untilHpFrac: 0.5, cook: false, stack: false });
  assert.equal(bot.done, true);
});

// ---- self-defense: driven by combat events, NOT the enraged flag -----------
//
// These exist because the first version of DEFEND shipped broken and every
// policy test passed. It read the snapshot's `enraged` flag, on the assumption
// that the server sets it on a monster fighting you. It does not.
//
// Measured live in the orc cave: an orc hit Dario ~100 times, taking him from
// 199 HP to 20, and `enraged` was false in every snapshot of it. The policy
// tests fed hand-written `enraged: true` monsters the server never sends, so
// they proved nothing about production.
//
// That is exactly the class of bug this file exists to catch, so the fix is
// pinned HERE, against real frames, not against literal objects.

/** A server combat-event frame (opcode 2). */
function combatEvent({ attackerId, targetId, damage = 3, targetHpAfter = 50, targetMaxHp = 100, flags = 0 }) {
  return new W().u8(2).str(attackerId).str(targetId)
    .u16(damage).u16(targetHpAfter).u16(targetMaxHp).u8(flags).buf();
}

test('a combat event naming us as target records the attacker', () => {
  const bot = makeBot();
  bot.onBinary(combatEvent({ attackerId: 'orc-9', targetId: 'me' }));
  assert.equal(bot.isAttacking('orc-9'), true);
});

test('a combat event between two OTHER parties is not our fight', () => {
  const bot = makeBot();
  bot.onBinary(combatEvent({ attackerId: 'orc-9', targetId: 'someone-else' }));
  assert.equal(bot.isAttacking('orc-9'), false);
});

test('a miss (damage=0) still counts as being attacked', () => {
  // The live capture is full of dmg=0 events. A monster swinging and missing is
  // still a monster fighting us.
  const bot = makeBot();
  bot.onBinary(combatEvent({ attackerId: 'orc-9', targetId: 'me', damage: 0 }));
  assert.equal(bot.isAttacking('orc-9'), true);
});

test('an off-type monster that HIT us is fought back, from real frames', () => {
  // The whole bug, end to end: hunting orcs, a cave bat hits us, and the bot
  // must swing back. No `enraged` anywhere -- the frames say what the server
  // actually says.
  const bot = withBackpack(makeBot(), [null]);
  bot.stats = { statusEffects: [{ kind: 'wellFed' }] };
  bot.onBinary(combatEvent({ attackerId: 'bat-1', targetId: 'me' }));
  const snap = decodeSnapshot(snapshot({
    players: [player({ x: 100, y: 100 })],
    // type 1 = caveBat, and enraged is FALSE, as the real server sends it.
    monsters: [{ id: 'bat-1', type: 1, x: 100, y: 100, hp: 22, maxHp: 22, enraged: false }],
    ground: [],
  }));
  runTick(bot, snap, { huntTypes: ['orc'], travel: false, cook: false, stack: false });
  const attacked = bot.sent.some(
    (s) => s instanceof ArrayBuffer && new Uint8Array(s)[0] === 2);
  assert.ok(attacked, 'must fight back at the bat that hit us');
});

test('the enraged flag alone does NOT trigger self-defense', () => {
  // The inverse, and the one that pins the lesson: enraged is not the signal.
  // A monster flagged enraged that has never hit us is not our fight -- if this
  // ever starts passing by way of the flag, the old bug is back.
  const bot = withBackpack(makeBot(), [null]);
  bot.stats = { statusEffects: [{ kind: 'wellFed' }] };
  const snap = decodeSnapshot(snapshot({
    players: [player({ x: 100, y: 100 })],
    monsters: [{ id: 'bat-1', type: 1, x: 100, y: 100, hp: 22, maxHp: 22, enraged: true }],
    ground: [],
  }));
  runTick(bot, snap, { huntTypes: ['orc'], travel: false, cook: false, stack: false });
  const attacked = bot.sent.some(
    (s) => s instanceof ArrayBuffer && new Uint8Array(s)[0] === 2);
  assert.equal(attacked, false, 'enraged is not evidence it is fighting US');
});

// Our OWN hits, which are what the corner standoff reads. The server only emits
// this event when an attack actually resolved against the target, so its absence
// while we swing is the one available proof that a wall is in the way.

test('a combat event where WE are the attacker records the landed hit', () => {
  const bot = makeBot();
  bot.onBinary(combatEvent({ attackerId: 'me', targetId: 'bat-1' }));
  assert.equal(bot.isHitting('bat-1'), true);
});

test('someone else hitting that monster is not evidence WE can reach it', () => {
  // The failure this guards: a crowded room where another player is beating on
  // the same bat would otherwise look, to us, like our swings were connecting.
  const bot = makeBot();
  bot.onBinary(combatEvent({ attackerId: 'other-player', targetId: 'bat-1' }));
  assert.equal(bot.isHitting('bat-1'), false);
});

test('landing a hit on one monster says nothing about another', () => {
  const bot = makeBot();
  bot.onBinary(combatEvent({ attackerId: 'me', targetId: 'bat-1' }));
  assert.equal(bot.isHitting('bat-2'), false);
});

test('a blocked hit still proves the target is reachable', () => {
  // flags bit 4 = blocked. The swing resolved -- it just did nothing. That is a
  // reachability fact, and treating it as a miss would sidestep out of a real
  // fight against a well-armoured monster.
  const bot = makeBot();
  bot.onBinary(combatEvent({ attackerId: 'me', targetId: 'bat-1', damage: 0, flags: 4 }));
  assert.equal(bot.isHitting('bat-1'), true);
});

test('a stale attacker is forgotten once its memory window lapses', () => {
  const bot = makeBot();
  bot.onBinary(combatEvent({ attackerId: 'orc-9', targetId: 'me' }));
  // Backdate the hit well past ATTACKER_MEMORY_S.
  bot.attackedBy.set('orc-9', bot._now() - 999);
  assert.equal(bot.isAttacking('orc-9'), false);
  assert.equal(bot.attackedBy.has('orc-9'), false, 'and the entry is pruned');
});
