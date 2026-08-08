// Regressions for two live failure modes, both found on Dario during a real run.
//
// Run: node --test web/test/test_hazards.mjs   (from web/)
//
//  1. THE LOOT LOOP. He stood on a corpse asking for the same item several times
//     a second and being refused -- "too heavy to carry" -- forever. Two causes,
//     both fixed here: bot.js asserted that weight was flavour and slots were the
//     real limit (the client says otherwise: "Overloading stops you picking more
//     up"), and nothing ever gave up on an item the server had already refused.
//
//  2. THE ACCIDENTAL DESCENT. Chasing a rat across tile 58,22 dropped him to
//     z=-1, because a 'walk' teleport fires on contact and A* was happy to route
//     through one. Underground there are no rats, so the hunt filter matched
//     nothing, he never fought back, and he looped looting while cave bats ate
//     him. Nothing in the loop could climb back: descendStep only runs when the
//     configured depth is negative.
//
// Both are pinned against the REAL extracted maps, because both are properties
// of the actual world -- a synthetic grid with an invented hole would prove
// nothing about tile 58,22.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const SRC = new URL('../src/core/', import.meta.url);
const load = (m) => import(new URL(m, SRC).href);

const { TILE } = await load('protocol.js');
const { AvalonBot } = await load('bot.js');
const nav = await load('nav.js');
const farm = await load('farm.js');

const MAPS = JSON.parse(
  readFileSync(new URL('../maps.json', import.meta.url), 'utf8'));
nav.loadMaps(MAPS);

const px = (t) => (t + 0.5) * TILE;

class FakeBot extends AvalonBot {
  constructor(equipment = {}, stats = null) {
    super(() => true);
    this.me = 'me';
    this.sent = [];
    this.equipment = equipment;
    this.stats = stats || { statusEffects: [{ kind: 'wellFed' }] };
    this.z = 0;
  }

  send(msg) { this.sent.push(msg); return true; }
  move(dx, dy) { this.sent.push({ type: 'move', dx, dy }); return true; }
  attack(targetId) { this.sent.push({ type: 'attack', targetId }); return true; }

  ofType(t) { return this.sent.filter((m) => m.type === t); }
}

const item = (itemId, quantity = 1, iid = null, contents = undefined) => {
  const it = { itemId, quantity, instanceId: iid || `${itemId}-${quantity}` };
  if (contents !== undefined) it.contents = contents;
  return it;
};

function backpack(contents, cap = 8) {
  const slots = [...contents];
  while (slots.length < cap) slots.push(null);
  return { backpack: item('backpack', 1, 'pack', slots) };
}

const snapshot = (players = [], monsters = [], npcs = [], ground = [], z = 0) => ({
  z, players: [...players], monsters: [...monsters],
  npcs: [...npcs], groundItems: [...ground], groundRev: 1,
});

const me = (tile = [10, 10], hp = 100, maxHp = 100, z = 0) => ({
  id: 'me', name: 'Dario Amodei', x: px(tile[0]), y: px(tile[1]),
  z, hp, maxHp, level: 5,
});

const rat = (tile = [10, 10], hp = 20, mid = 'rat1', mtype = 'rat') => ({
  id: mid, monsterType: mtype, x: px(tile[0]), y: px(tile[1]),
  z: 0, hp, maxHp: 20, enraged: false,
});

const drop = (tile = [10, 10], itemId = 'plateArmor', qty = 1, gid = 'g1') => ({
  id: gid, x: px(tile[0]), y: px(tile[1]), z: 0,
  item: item(itemId, qty, `i-${gid}`), ownerId: null, ownerExpiresAt: 0,
});

/** Stats carrying the weight fields the server actually sends. */
const weighed = (carriedWeightOz, capacityOz) => ({
  statusEffects: [{ kind: 'wellFed' }], carriedWeightOz, capacityOz,
});

const logs = [];
const cfg = (o = {}) => new farm.FarmConfig({ healerName: 'aldric', ...o });
function run(bot, snap, o = {}) {
  logs.length = 0;
  farm.makeFarm(cfg(o), (m) => logs.push(m))(bot, snap);
  return bot;
}

/**
 * Run `ticks` ticks with the clock advancing 100 ms between them.
 *
 * Pickups are throttled to one per 0.4 s, and a bare loop runs 20 iterations in
 * microseconds -- so without moving the clock the throttle never expires and
 * every test of "does it try again?" trivially passes for the wrong reason.
 * 100 ms per tick is the server's real snapshot cadence.
 */
function runFor(bot, snap, o = {}, ticks = 20) {
  const real = performance.now.bind(performance);
  let t = real();
  performance.now = () => t;
  try {
    for (let i = 0; i < ticks; i++) { run(bot, snap, o); t += 100; }
  } finally {
    performance.now = real;
  }
  return bot;
}

// ---- 1. the loot loop -----------------------------------------------------

test('weight is read from the server stats, not assumed away', () => {
  const bot = new FakeBot(backpack([]), weighed(180, 200));
  assert.deepEqual(bot.weight(), [180, 200]);
  assert.equal(bot.overloaded(), false);
  assert.equal(bot.overloaded(20), true, 'within 20oz of the cap is overloaded');
});

test('with no weight stats yet, we do not guess', () => {
  // Before the first playerStats we know nothing. Guessing "overloaded" would
  // stop a perfectly healthy bot from ever looting.
  const bot = new FakeBot(backpack([]), { statusEffects: [] });
  assert.equal(bot.overloaded(), false);
});

test('an overloaded bot does not even ask -- no takeItem is sent', () => {
  // The loop: slots free, so the old code sent takeItem; the server refused on
  // weight; nothing changed; repeat at 2.5 Hz forever.
  const bot = new FakeBot(backpack([]), weighed(200, 200));
  run(bot, snapshot([me([10, 10])], [], [], [drop([10, 10])]),
    { cook: false, stack: false, bank: false });
  assert.equal(bot.ofType('moveItem').length, 0, 'must not request a pickup');
  assert.ok(logs.some((l) => /OVERLOADED/.test(l)), `expected a warning, got ${logs}`);
});

test('a bot with room still loots normally', () => {
  const bot = new FakeBot(backpack([]), weighed(10, 200));
  run(bot, snapshot([me([10, 10])], [], [], [drop([10, 10])]),
    { cook: false, stack: false, bank: false });
  assert.equal(bot.ofType('moveItem').length, 1);
});

test('a refused item is banned, so the request is not repeated', () => {
  // The proactive check cannot catch everything: it knows our total weight, not
  // what the next item weighs. So one request gets through, is refused, and the
  // refusal has to be what stops the second.
  const bot = new FakeBot(backpack([]), weighed(150, 200));
  const snap = snapshot([me([10, 10])], [], [], [drop([10, 10])]);
  run(bot, snap, { cook: false, stack: false, bank: false });
  assert.equal(bot.ofType('moveItem').length, 1, 'the first ask goes out');

  farm.handleLootRefusal(bot, {
    type: 'statusMessage', text: 'That is too heavy to carry.',
  }, (m) => logs.push(m));

  // Now it must be skipped rather than re-requested, however long we stand here.
  runFor(bot, snap, { cook: false, stack: false, bank: false }, 20);
  assert.equal(bot.ofType('moveItem').length, 1, 'no second request for a refused item');
});

test('a refusal only bans the item it was about', () => {
  const bot = new FakeBot(backpack([]), weighed(150, 200));
  const snap = snapshot([me([10, 10])], [], [],
    [drop([10, 10], 'plateArmor', 1, 'g1'), drop([10, 10], 'gold', 5, 'g2')]);
  run(bot, snap, { cook: false, stack: false, bank: false });
  const first = bot.ofType('moveItem')[0].instanceId;
  farm.handleLootRefusal(bot, { type: 'statusMessage', text: 'Too heavy.' }, () => {});
  runFor(bot, snap, { cook: false, stack: false, bank: false }, 20);
  const asked = new Set(bot.ofType('moveItem').map((m) => m.instanceId));
  assert.ok(asked.size > 1, 'the other drop should still be attempted');
  assert.equal([...asked].filter((a) => a === first).length, 1, 'the refused one, once');
});

test('unrelated status messages are not treated as refusals', () => {
  const bot = new FakeBot(backpack([]), weighed(10, 200));
  bot.run.farmPendingLoot = { instanceId: 'x', itemId: 'gold' };
  assert.equal(
    farm.handleLootRefusal(bot, { type: 'statusMessage', text: 'You feel rested.' }, () => {}),
    false);
  assert.ok(!bot.run.farmLootSkip?.has('x'));
});

// ---- 2. the accidental descent --------------------------------------------

test('the surface holes are known, and they are the real ones', () => {
  const holes = [...nav.trapdoorTiles(0)]
    .map((k) => `${Math.floor(k / 100000)},${k % 100000}`).sort();
  assert.ok(holes.includes('58,22'), `58,22 is the hole Dario fell down: ${holes}`);
  assert.equal(holes.length, 6, 'all six surface holes');
});

test('a surface bot treats holes as walls', () => {
  // The fix: a walk-mode hole fires on contact, so it has to be a wall to A*.
  const bot = new FakeBot(backpack([]));
  farm.setNavObstacles(bot, snapshot([me([58, 24])]), me([58, 24]), 0);
  assert.ok(bot.run.occupied.has(nav.tileKey(58, 22)), 'the hole must be blocked');
});

test('a bot that WANTS to go down keeps the holes open', () => {
  // Same tiles, opposite intent: with --depth -1 the hole is the route, and
  // blocking it would make descending impossible.
  const bot = new FakeBot(backpack([]));
  farm.setNavObstacles(bot, snapshot([me([58, 24])]), me([58, 24]), -1);
  assert.ok(!bot.run.occupied.has(nav.tileKey(58, 22)), 'the route down stays open');
});

test('chasing a rat never routes through a hole', () => {
  // The live failure, end to end: rat on the far side of the hole from us.
  // The step taken must not be onto the hole tile.
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([58, 24])], [rat([58, 20])]);
  run(bot, snap, { cook: false, stack: false, bank: false });
  const mv = bot.ofType('move').at(-1);
  const landed = [nav.tileOf(px(58)) + mv.dx, nav.tileOf(px(24)) + mv.dy];
  assert.notDeepEqual(landed, [58, 22], 'stepped straight into the hole');
});

test('a bot that fell to z=-1 climbs back instead of farming there', () => {
  // What actually happened: he kept looting at z=-1 among monsters he would not
  // fight. The loop must now recognise the wrong floor and leave.
  const bot = new FakeBot(backpack([]));
  bot.z = -1;
  // Land on the z=-1 ladder tile's neighbourhood, with loot and a bat present --
  // exactly the state that used to pin him: loot to grab, prey he won't hunt.
  const up = nav.nearestUpwardTeleport(-1, [58, 22]);
  assert.ok(up, 'z=-1 must have a way up');
  const here = [up.fromTile[0] + 3, up.fromTile[1]];
  const snap = snapshot(
    [me(here, 100, 100, -1)],
    [{ id: 'b1', monsterType: 'caveBat', x: px(here[0]), y: px(here[1]), z: -1, hp: 10, maxHp: 10, enraged: true }],
    [], [drop(here, 'gold', 5)], -1);
  run(bot, snap, { cook: false, stack: false, bank: false, depth: 0 });
  assert.equal(bot.run.farmState, 'CLIMB', `expected CLIMB, got ${bot.run.farmState}`);
  assert.equal(bot.ofType('moveItem').length, 0, 'must not stop to loot down there');
});

test('a bot farming underground on purpose does not climb out', () => {
  // --depth -1 means we belong here. Climbing would make the mode useless.
  const bot = new FakeBot(backpack([]));
  bot.z = -1;
  const snap = snapshot([me([58, 22], 100, 100, -1)], [], [], [], -1);
  run(bot, snap, { cook: false, stack: false, bank: false, depth: -1 });
  assert.notEqual(bot.run.farmState, 'CLIMB');
});

test('being on the wrong floor outranks looting and fighting', () => {
  const bot = new FakeBot(backpack([]));
  bot.z = -1;
  const up = nav.nearestUpwardTeleport(-1, [58, 22]);
  const here = [up.fromTile[0] + 2, up.fromTile[1]];
  const snap = snapshot(
    [me(here, 100, 100, -1)],
    [{ id: 'r9', monsterType: 'rat', x: px(here[0]), y: px(here[1]), z: -1, hp: 5, maxHp: 20, enraged: false }],
    [], [drop(here, 'gold', 5)], -1);
  run(bot, snap, { cook: false, stack: false, bank: false, depth: 0 });
  assert.equal(bot.ofType('attack').length, 0, 'no fighting on the way out');
  assert.equal(bot.ofType('moveItem').length, 0, 'no looting on the way out');
});
