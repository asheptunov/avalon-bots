// Farm-loop tests ported from test_farm.py.
//
// Run: node --test web/test/test_farm.mjs   (from the repo root)
//
// test_port.mjs already pins the decisions that were expensive to learn on the
// Python side and it drives the machine through REAL decoded wire frames. This
// file covers what that one does not: the fight/chase split, the loot-vs-fight
// priority ladder, corpse mechanics beyond the happy path, the flag matrix
// (--no-loot / --no-cook / --no-stack), retreating toward a healer and healing
// there, roam-goal stability, and the whole depth/descend/escape dimension --
// which had no JS coverage at all.
//
// Style note: where test_port.mjs builds server frames byte-by-byte, these
// mirror test_farm.py and hand the state machine plain snapshot objects. Both
// shapes matter: the wire path proves the decoder, the literal path proves the
// policy in isolation, and a policy bug shows up here without a frame to build.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

// Import via file:// URLs -- on Windows a bare absolute path ('C:\...') is not
// a valid ESM specifier.
const SRC = new URL('../src/core/', import.meta.url);
const load = (m) => import(new URL(m, SRC).href);

const { TILE, MELEE_RANGE_PX } = await load('protocol.js');
const { AvalonBot } = await load('bot.js');
const nav = await load('nav.js');
const farm = await load('farm.js');

// The real extracted collision maps -- the depth tests assert a SAFETY property
// of the actual world (every hole has a return ladder), so a synthetic grid
// would prove nothing. This is the same snapshot the build embeds as its
// fallback; refresh it with `node src/cli/main.js maps --out maps.json`.
const MAPS = JSON.parse(
  readFileSync(new URL('../maps.json', import.meta.url), 'utf8'));
nav.loadMaps(MAPS);

// ---- fixtures (mirrors of test_farm.py's helpers) --------------------------

const px = (t) => (t + 0.5) * TILE;

/**
 * Stands in for AvalonBot: records what was sent, serves canned inventory.
 *
 * Subclassing the real bot rather than reimplementing it keeps the inventory
 * helpers (iterItems / backpack / packSpace / hasStatus) under test instead of
 * mocked -- the Python fake borrowed the same methods off AvalonBot for exactly
 * this reason. Only the transport is faked.
 */
class FakeBot extends AvalonBot {
  constructor(equipment = {}, stats = null) {
    super(() => true);
    this.me = 'me';
    this.sent = [];
    this.equipment = equipment;
    this.stats = stats || { statusEffects: [{ kind: 'wellFed', remainingMs: 60000 }] };
    this.z = 0;
  }

  send(msg) { this.sent.push(msg); return true; }
  move(dx, dy) { this.sent.push({ type: 'move', dx, dy }); return true; }
  attack(targetId) { this.sent.push({ type: 'attack', targetId }); return true; }

  kinds() { return this.sent.map((m) => m.type); }
  ofType(t) { return this.sent.filter((m) => m.type === t); }
}

const item = (itemId, quantity = 1, iid = null, contents = undefined) => {
  const it = { itemId, quantity, instanceId: iid || `${itemId}-${quantity}` };
  if (contents !== undefined) it.contents = contents;
  return it;
};

/** An equipped backpack with `contents` padded out to `cap` slots. */
function backpack(contents, cap = 8) {
  const slots = [...contents];
  while (slots.length < cap) slots.push(null);
  return { backpack: item('backpack', 1, 'pack', slots) };
}

const snapshot = (players = [], monsters = [], npcs = [], ground = []) => ({
  z: 0, players: [...players], monsters: [...monsters],
  npcs: [...npcs], groundItems: [...ground], groundRev: 1,
});

const me = (tile = [10, 10], hp = 100, maxHp = 100) => ({
  id: 'me', name: 'Sam Altman', x: px(tile[0]), y: px(tile[1]),
  z: 0, hp, maxHp, level: 5,
});

const rat = (tile = [10, 10], hp = 20, mid = 'rat1', mtype = 'rat') => ({
  id: mid, monsterType: mtype, x: px(tile[0]), y: px(tile[1]),
  z: 0, hp, maxHp: 20, enraged: false,
});

const drop = (tile = [10, 10], itemId = 'gold', qty = 5, gid = 'g1', owner = null) => ({
  id: gid, x: px(tile[0]), y: px(tile[1]), z: 0,
  item: item(itemId, qty, `i-${gid}`), ownerId: owner, ownerExpiresAt: 0,
});

/**
 * A killed monster's remains: a ground container whose `contents` are the real
 * drops. This is how rats actually leave loot -- taking the corpse itself loots
 * nothing, which is the bug that made the first live run come home empty.
 */
const corpse = (tile = [10, 10], contents = [], gid = 'c1', owner = null) => ({
  id: gid, x: px(tile[0]), y: px(tile[1]), z: 0,
  item: item('corpse', 1, `i-${gid}`, [...contents]),
  ownerId: owner, ownerExpiresAt: 0,
});

const HUNGRY = { statusEffects: [] };

/** cfg(): the Python default has a healer configured; the JS default does not. */
const cfg = (o = {}) => new farm.FarmConfig({ healerName: 'aldric', ...o });

const logs = [];
function run(bot, snap, o = {}) {
  logs.length = 0;
  farm.makeFarm(cfg(o), (m) => logs.push(m))(bot, snap);
  return bot;
}

/** The farm state, which lives on bot.run -- not as a `_`-prefixed field. */
const stateOf = (bot) => bot.run.farmState;

// ---- fight / chase ---------------------------------------------------------
// test_port.mjs proves an in-melee monster is attacked; it never proves the
// CHASE half of the branch (walk, don't swing, at range).

test('a rat in melee range is attacked', () => {
  const bot = new FakeBot(backpack([]));
  run(bot, snapshot([me()], [rat([10, 10])]));
  assert.equal(bot.ofType('attack')[0].targetId, 'rat1');
});

test('a distant rat is chased, not swung at', () => {
  const bot = new FakeBot(backpack([]));
  run(bot, snapshot([me([10, 10])], [rat([16, 10])]));
  assert.equal(bot.ofType('attack').length, 0, 'out of melee range');
  assert.ok(bot.ofType('move').length > 0, 'must close the distance');
});

test('the hunt filter refuses a fight with the 16k-HP training dummy', () => {
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me()], [rat([10, 10], 20, 'd', 'trainingDummy')]);
  run(bot, snap, { huntTypes: ['rat'] });
  assert.equal(bot.ofType('attack').length, 0);
});

test('a dead bot respawns', () => {
  const bot = new FakeBot(backpack([]));
  run(bot, snapshot([me([10, 10], 0)], [rat()]));
  assert.ok(bot.kinds().includes('respawn'));
});

// ---- loot ------------------------------------------------------------------

test('a loose drop in reach is moved into the backpack', () => {
  const bot = new FakeBot(backpack([]));
  run(bot, snapshot([me([10, 10])], [], [], [drop([10, 10])]));
  const mv = bot.ofType('moveItem');
  assert.equal(mv.length, 1);
  assert.equal(mv[0].instanceId, 'i-g1');
  assert.equal(mv[0].to.containerInstanceId, 'pack');
});

test('a distant drop is walked to before it is taken', () => {
  const bot = new FakeBot(backpack([]));
  run(bot, snapshot([me([10, 10])], [], [], [drop([15, 10])]));
  assert.equal(bot.ofType('moveItem').length, 0);
  assert.ok(bot.ofType('move').length > 0);
});

test('loot reserved for someone else is left alone', () => {
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10])], [], [], [drop([10, 10], 'gold', 5, 'g1', 'someone-else')]);
  run(bot, snap);
  assert.equal(bot.ofType('moveItem').length, 0);
});

test('loot reserved for US is taken', () => {
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10])], [], [], [drop([10, 10], 'gold', 5, 'g1', 'me')]);
  run(bot, snap);
  assert.ok(bot.ofType('moveItem').length > 0);
});

test('fighting takes priority over looting when both are underfoot', () => {
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10])], [rat([10, 10])], [], [drop([10, 10])]);
  run(bot, snap);
  assert.ok(bot.ofType('attack').length > 0);
  assert.equal(bot.ofType('moveItem').length, 0);
});

test('a full backpack warns once and keeps farming instead of exiting', () => {
  // --bank off: with banking enabled a full pack is a trip to the depot, not a
  // warning (see test_depot.mjs). This pins the fallback that still applies
  // underground and whenever banking is disabled -- a full bag must never be a
  // reason to STOP.
  const junk = Array.from({ length: 8 }, (_, i) => item('junk', 1, `j${i}`));
  const bot = new FakeBot(backpack(junk, 8));
  const snap = snapshot([me([10, 10])], [], [], [drop([10, 10])]);
  run(bot, snap, { cook: false, stack: false, bank: false });
  assert.equal(bot.ofType('moveItem').length, 0);
  assert.equal(bot.run.farmWarnedFull, true);
  assert.equal(bot.done, false, 'a full bag is not a reason to stop');
});

test('looting takes the CONTENTS of a corpse, never the corpse itself', () => {
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10])], [], [],
    [corpse([10, 10], [item('gold', 7, 'loot-gold')])]);
  run(bot, snap);
  const mv = bot.ofType('moveItem');
  assert.equal(mv.length, 1);
  assert.equal(mv[0].instanceId, 'loot-gold', 'not the corpse id "i-c1"');
});

test('an empty corpse is not a loot target', () => {
  const bot = new FakeBot(backpack([]));
  run(bot, snapshot([me([10, 10])], [], [], [corpse([10, 10])]),
    { cook: false, stack: false });
  assert.equal(bot.ofType('moveItem').length, 0);
});

test('a distant corpse is walked to', () => {
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10])], [], [],
    [corpse([16, 10], [item('gold', 7, 'loot-gold')])]);
  run(bot, snap);
  assert.equal(bot.ofType('moveItem').length, 0);
  assert.ok(bot.ofType('move').length > 0);
});

test('several drops sharing one corpse are taken one per tick', () => {
  const bot = new FakeBot(backpack([]));
  const body = corpse([10, 10], [item('gold', 7, 'l1'), item('rawMeat', 2, 'l2')]);
  const o = { cook: false, stack: false };
  run(bot, snapshot([me([10, 10])], [], [], [body]), o);
  const first = bot.ofType('moveItem')[0].instanceId;

  // Simulate the server removing the taken item from the corpse.
  body.item.contents = body.item.contents.filter((c) => c.instanceId !== first);
  bot.sent.length = 0;
  // Clear the pickup throttle -- in Python this was `_farm_last_pickup = 0.0`,
  // which worked only because time.monotonic() is uptime. performance.now()
  // starts near zero, so 0.0 would still be inside the 0.4 s window; -Infinity
  // is what "long ago" actually means here.
  bot.run.farmLastPickup = -Infinity;

  run(bot, snapshot([me([10, 10])], [], [], [body]), o);
  const second = bot.ofType('moveItem')[0].instanceId;
  assert.notEqual(first, second);
  assert.deepEqual([first, second].sort(), ['l1', 'l2']);
});

test('a corpse owned by a rival is skipped', () => {
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10])], [], [],
    [corpse([10, 10], [item('gold', 7, 'l1')], 'c1', 'rival')]);
  run(bot, snap, { cook: false, stack: false });
  assert.equal(bot.ofType('moveItem').length, 0);
});

test('--no-loot disables pickup entirely', () => {
  const bot = new FakeBot(backpack([]));
  run(bot, snapshot([me([10, 10])], [], [], [drop([10, 10])]), { loot: false });
  assert.equal(bot.ofType('moveItem').length, 0);
});

// ---- cook / stack ----------------------------------------------------------

test('raw meat is cooked', () => {
  const bot = new FakeBot(backpack([item('rawMeat', 3, 'raw1')]));
  run(bot, snapshot([me()], []));
  assert.equal(bot.ofType('useItem')[0].instanceId, 'raw1');
});

test('--no-cook leaves the meat raw', () => {
  const bot = new FakeBot(backpack([item('rawMeat', 3, 'raw1')]));
  run(bot, snapshot([me()], []), { cook: false, stack: false });
  assert.equal(bot.ofType('useItem').filter((m) => m.instanceId === 'raw1').length, 0);
});

test('an unknown item held at qty>1 is stackable by proof', () => {
  // 'widget' is in no table; the server holding 4 of them in one slot IS the
  // evidence that it stacks.
  const bot = new FakeBot(backpack([item('widget', 4, 'w1'), item('widget', 2, 'w2')]));
  run(bot, snapshot([me()], []), { cook: false });
  assert.equal(bot.ofType('moveItem')[0].instanceId, 'w2', 'smaller stack pours');
});

test('cooking happens before stacking', () => {
  const bot = new FakeBot(backpack([
    item('rawMeat', 1, 'raw1'), item('gold', 5, 'g-a'), item('gold', 1, 'g-b'),
  ]));
  run(bot, snapshot([me()], []));
  assert.ok(bot.ofType('useItem').length > 0);
  assert.equal(bot.ofType('moveItem').length, 0, 'one inventory action per tick');
});

// ---- eating ----------------------------------------------------------------

test('pickFood saves the good food when healthy', () => {
  // Healthy: burn the 2-minute apple, keep the 20-minute sushi.
  const bot = new FakeBot(backpack([item('fish', 1, 'f1'), item('apple', 1, 'a1')]), HUNGRY);
  assert.equal(farm.pickFood(bot, false).itemId, 'apple');
});

test('pickFood in an emergency takes the longest-lasting food', () => {
  // Hurt: eat the sushi so we don't break off to eat again mid-retreat.
  const bot = new FakeBot(backpack([item('fish', 1, 'f1'), item('apple', 1, 'a1')]), HUNGRY);
  assert.equal(farm.pickFood(bot, true).itemId, 'fish');
});

test('a hurt bot eats the long food, a healthy one the short food', () => {
  // The same rule as above, but through the machine: `hurt` is derived from
  // resumeFrac inside eatStep, so this pins the wiring, not just the picker.
  const held = () => backpack([item('fish', 1, 'f1'), item('apple', 1, 'a1')]);
  const hurt = new FakeBot(held(), HUNGRY);
  run(hurt, snapshot([me([10, 10], 20)], []), { cook: false, stack: false });
  assert.equal(hurt.ofType('useItem')[0].instanceId, 'f1', 'emergency -> sushi');

  const healthy = new FakeBot(held(), HUNGRY);
  run(healthy, snapshot([me([10, 10], 100)], []), { cook: false, stack: false });
  assert.equal(healthy.ofType('useItem')[0].instanceId, 'a1', 'healthy -> apple');
});

test('running out of food warns loudly -- HP will not regenerate', () => {
  const bot = new FakeBot(backpack([]), HUNGRY);
  run(bot, snapshot([me()], []), { cook: false, stack: false });
  assert.equal(bot.run.farmWarnedFood, true);
  assert.ok(logs.some((l) => l.includes('OUT OF FOOD')));
});

test('eating continues while retreating -- regen is the healing mechanism', () => {
  const bot = new FakeBot(backpack([item('cookedMeat', 2, 'cm1')]), HUNGRY);
  run(bot, snapshot([me([10, 10], 20)], [rat([12, 10])]));
  assert.ok(bot.ofType('useItem').length > 0);
});

// ---- retreat / heal --------------------------------------------------------
// NB: these place the monster well away from the player. A monster in melee
// deliberately overrides the retreat (see canDisengage) -- fleeing from
// something already swinging just feeds it free hits.

test('below the retreat threshold the bot flees instead of fighting', () => {
  const bot = new FakeBot(backpack([]));
  run(bot, snapshot([me([10, 10], 20)], [rat([25, 10])]));
  assert.equal(bot.fleeing, true);
  assert.equal(bot.ofType('attack').length, 0);
});

test('fighting resumes once healed past resumeFrac', () => {
  const bot = new FakeBot(backpack([]));
  run(bot, snapshot([me([10, 10], 20)], [rat([10, 10])]));
  bot.sent.length = 0;
  run(bot, snapshot([me([10, 10], 95)], [rat([10, 10])]));
  assert.equal(bot.fleeing, false);
  assert.ok(bot.ofType('attack').length > 0);
});

test('retreat runs TOWARD the healer, not away from the monster', () => {
  const aldric = { id: 'n1', npcType: 'healer', name: 'Brother Aldric', x: px(20), y: px(10), z: 0 };
  const bot = new FakeBot(backpack([]));
  // Aldric is east, the rat is west: running "away" would go east too, so the
  // rat sits west of us to make the two rules disagree.
  const snap = snapshot([me([10, 10], 20)], [rat([2, 10])], [aldric]);
  run(bot, snap);
  const mv = bot.ofType('move').at(-1);
  assert.equal(mv.dx, 1, 'east toward Aldric');
});

test('standing on the healer opens the heal dialogue', () => {
  const aldric = { id: 'n1', npcType: 'healer', name: 'Brother Aldric', x: px(10), y: px(10), z: 0 };
  const bot = new FakeBot(backpack([]));
  run(bot, snapshot([me([10, 10], 20)], [], [aldric]));
  assert.equal(bot.ofType('talkTo')[0].npcId, 'n1');
});

test('a held potion is drunk before the healer is bothered', () => {
  const aldric = { id: 'n1', npcType: 'healer', name: 'Brother Aldric', x: px(10), y: px(10), z: 0 };
  const bot = new FakeBot(backpack([item('healthPotion', 2, 'hp1')]));
  run(bot, snapshot([me([10, 10], 20)], [], [aldric]));
  assert.equal(bot.ofType('useItem')[0].instanceId, 'hp1');
  assert.equal(bot.ofType('talkTo').length, 0, 'the potion satisfies this tick');
});

// ---- live-run regressions --------------------------------------------------
// Three bugs that together killed Sam on the first live run: he starved with a
// bag of apples, fled from a rat that hits for 1, and never looted.

test('the bot eats MID-FIGHT (the bug that starved Sam)', () => {
  // Eating sat in the idle branch, but the rat field always has a rat in view,
  // so the fight branch returned first and he never ate -- and without wellFed,
  // HP never regenerates.
  const bot = new FakeBot(backpack([item('apple', 7, 'a1')]), HUNGRY);
  run(bot, snapshot([me([10, 10])], [rat([10, 10])]));
  assert.ok(bot.ofType('useItem').some((m) => m.instanceId === 'a1'), 'should eat mid-fight');
  assert.ok(bot.ofType('attack').length > 0, 'and still fight');
});

test('the bot eats while chasing', () => {
  const bot = new FakeBot(backpack([item('apple', 7, 'a1')]), HUNGRY);
  run(bot, snapshot([me([10, 10])], [rat([16, 10])]));
  assert.ok(bot.ofType('useItem').length > 0);
});

test('the bot stacks while fighting', () => {
  // Stacking sat in the idle branch too, so a pack full of split slivers never
  // got merged on a field that always has prey.
  const bot = new FakeBot(backpack([item('gold', 9, 'g-a'), item('gold', 2, 'g-b')]));
  run(bot, snapshot([me([10, 10])], [rat([16, 10])]), { cook: false });
  assert.equal(bot.ofType('moveItem')[0].instanceId, 'g-b');
});

test('the bot cooks while fighting', () => {
  const bot = new FakeBot(backpack([item('rawMeat', 2, 'raw1')]));
  run(bot, snapshot([me([10, 10])], [rat([16, 10])]));
  assert.equal(bot.ofType('useItem')[0].instanceId, 'raw1');
});

test('a corpse underfoot is looted before the next rat is chased', () => {
  // He left every corpse behind because loot sat behind the fight branch and
  // there was always another rat to chase.
  const bot = new FakeBot(backpack([]));
  const snap = snapshot(
    [me([10, 10])],
    [rat([20, 10])],                       // next rat, 10 tiles away
    [],
    [corpse([10, 10], [item('gold', 3, 'l1')])]);
  run(bot, snap);
  assert.equal(bot.ofType('moveItem')[0].instanceId, 'l1');
});

test('but a monster already in melee still beats looting', () => {
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10])], [rat([10, 10])], [],
    [corpse([10, 10], [item('gold', 3, 'l1')])]);
  run(bot, snap);
  assert.ok(bot.ofType('attack').length > 0);
  assert.equal(bot.ofType('moveItem').length, 0, "don't stop mid-swing");
});

test('distant loot does not distract from a close monster', () => {
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10])], [rat([12, 10])], [],
    [corpse([40, 40], [item('gold', 3, 'l1')])]);
  run(bot, snap);
  assert.equal(bot.ofType('moveItem').length, 0);
});

test('a hurt bot with nothing adjacent genuinely retreats', () => {
  const bot = new FakeBot(backpack([]));
  run(bot, snapshot([me([10, 10], 20)], [rat([25, 10])]));
  assert.equal(bot.ofType('attack').length, 0);
  assert.equal(stateOf(bot), 'RETREAT');
});

// ---- depth: descend and escape --------------------------------------------
// The safety property these pin down: every down-hole has a matching up-ladder
// on the SAME tile, so the way out is always where he landed.

const HOLE = [58, 22];   // the z=0 hole -> z=-1 (a 'walk' hole)

test('the surface hole has a return ladder on the same tile', () => {
  const down = nav.teleports(0).find(
    (t) => t.fromTile[0] === HOLE[0] && t.fromTile[1] === HOLE[1]);
  assert.ok(down, 'the named entry hole exists on z=0');
  assert.equal(down.toZ, -1);
  assert.equal(down.mode, 'walk');

  const up = nav.nearestUpwardTeleport(-1, HOLE);
  assert.deepEqual(up.fromTile, HOLE, 'the exit is exactly where he landed');
  assert.equal(up.toZ, 0);
  assert.equal(up.mode, 'interact');
});

test('every underground floor has a way up -- no one-way trips', () => {
  for (const z of [-1, -2, -3, -4, -5, -6]) {
    assert.notEqual(nav.nearestUpwardTeleport(z, [50, 50]), null, `z=${z} has no up-teleport`);
  }
});

test('with --depth the bot walks toward the named entry hole', () => {
  const bot = new FakeBot(backpack([]));
  bot.z = 0;
  run(bot, snapshot([me([50, 30])], []), { depth: -1, entryTile: HOLE });
  assert.ok(bot.ofType('move').length > 0);
  assert.equal(stateOf(bot), 'DESCEND');
});

test('once on the target floor it farms instead of diving further', () => {
  const bot = new FakeBot(backpack([]));
  bot.z = -1;
  const snap = snapshot([me([58, 22])], [rat([58, 22], 20, 'b1', 'caveBat')]);
  run(bot, snap, { depth: -1, huntTypes: null });
  assert.ok(bot.ofType('attack').length > 0);
});

test('hurt underground it climbs out rather than fleeing sideways', () => {
  const bot = new FakeBot(backpack([]));
  bot.z = -1;
  const snap = snapshot([me([58, 22], 20)], [rat([59, 22], 20, 'b1', 'caveBat')]);
  run(bot, snap, { depth: -1 });
  assert.equal(stateOf(bot), 'ESCAPE');
});

test('escape uses the ladder when already standing on it', () => {
  const bot = new FakeBot(backpack([]));
  bot.z = -1;
  run(bot, snapshot([me(HOLE, 20)], []), { depth: -1 });
  assert.ok(bot.kinds().includes('useTeleport'));
});

test('on the SURFACE a hurt bot still goes to the healer -- escape is underground-only', () => {
  const aldric = { id: 'n1', npcType: 'healer', name: 'Brother Aldric', x: px(20), y: px(10), z: 0 };
  const bot = new FakeBot(backpack([]));
  bot.z = 0;
  run(bot, snapshot([me([10, 10], 20)], [], [aldric]), { depth: -1 });
  assert.equal(stateOf(bot), 'RETREAT');
});

test('never dive on the way out of a fight we barely survived', () => {
  const bot = new FakeBot(backpack([]));
  bot.z = 0;
  run(bot, snapshot([me([50, 30], 20)], []),
    { depth: -1, entryTile: HOLE, healerName: null });
  assert.notEqual(stateOf(bot), 'DESCEND');
});

// ---- roaming ---------------------------------------------------------------

test('with nothing to do the bot roams and records a goal', () => {
  const bot = new FakeBot(backpack([]));
  run(bot, snapshot([me()], []), { cook: false, stack: false });
  assert.ok(bot.ofType('move').length > 0);
  assert.notEqual(bot.run.farmRoamGoal, undefined);
  assert.notEqual(bot.run.farmRoamGoal, null);
});

test('the roam goal is stable between ticks -- no jitter', () => {
  const bot = new FakeBot(backpack([]));
  const o = { cook: false, stack: false };
  run(bot, snapshot([me()], []), o);
  const first = bot.run.farmRoamGoal;
  run(bot, snapshot([me()], []), o);
  assert.deepEqual(bot.run.farmRoamGoal, first, 'a re-rolled goal means it never arrives');
});

// ---- courtesy: staying out of other players' way ---------------------------
//
// The bots share a live server with humans. Every test here is about NOT doing
// something -- not tagging their mob, not taking their drop -- which is exactly
// the class of behaviour that has no in-game feedback and so goes unnoticed
// until someone complains.

/** Another player, at a tile. Same shape as me(), different id. */
const other = (tile = [10, 10], id = 'them', name = 'Stranger') => ({
  id, name, x: px(tile[0]), y: px(tile[1]), z: 0, hp: 100, maxHp: 100, level: 5,
});

test('a rat standing next to another player is left for them', () => {
  const bot = new FakeBot(backpack([]));
  // Their rat is ON them and 10 tiles from us: clearly theirs.
  const snap = snapshot([me([10, 10]), other([20, 10])], [rat([20, 10])]);
  run(bot, snap, { cook: false, stack: false });
  assert.equal(bot.ofType('attack').length, 0, 'must not tag their monster');
  assert.equal(stateOf(bot), 'ROAM', 'and should go find its own instead');
});

test('with courtesy off the same rat is fair game', () => {
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10]), other([20, 10])], [rat([20, 10])]);
  run(bot, snap, { cook: false, stack: false, courtesy: false });
  assert.ok(bot.ofType('move').length > 0, 'should chase it');
  assert.equal(stateOf(bot), 'FIGHT');
});

test('a free rat is preferred over one next to another player', () => {
  const bot = new FakeBot(backpack([]));
  // Theirs is CLOSER to us than the free one, so only the claim rule can make
  // the bot pick the far one.
  const snap = snapshot(
    [me([10, 10]), other([13, 10])],
    [rat([13, 10], 20, 'theirs'), rat([22, 10], 20, 'free')]);
  run(bot, snap, { cook: false, stack: false });
  assert.equal(stateOf(bot), 'FIGHT');
  // It is out of melee range, so we see a chase rather than an attack; prove the
  // target by walking it in and checking who gets hit.
  const closer = new FakeBot(backpack([]));
  run(closer, snapshot(
    [me([21, 10]), other([13, 10])],
    [rat([13, 10], 20, 'theirs'), rat([21, 10], 20, 'free')]),
  { cook: false, stack: false });
  assert.equal(closer.ofType('attack')[0].targetId, 'free');
});

test('a rat we are already closest to stays ours even with a player nearby', () => {
  // Otherwise a passer-by makes us abandon a half-killed monster: we lose the
  // damage AND hand them a mob they never engaged.
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10]), other([13, 10])], [rat([10, 10])]);
  run(bot, snap, { cook: false, stack: false });
  assert.equal(bot.ofType('attack')[0]?.targetId, 'rat1');
});

test('a drop next to another player is not touched', () => {
  const bot = new FakeBot(backpack([]));
  // Underfoot for us AND next to them -- the tempting case. Theirs wins.
  const snap = snapshot([me([10, 10]), other([12, 10])], [], [], [drop([10, 10])]);
  run(bot, snap, { cook: false, stack: false });
  assert.equal(bot.ofType('moveItem').length, 0, 'that is their kill\'s loot');
});

test('contested loot is skipped even when it is the only loot around', () => {
  // Unlike a monster, loot has no "take it if there is nothing else" fallback:
  // loot stealing is irreversible and the drop is not going anywhere.
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10]), other([10, 10])], [], [],
    [corpse([10, 10], [item('gold', 5, 'inner')])]);
  run(bot, snap, { cook: false, stack: false });
  assert.equal(bot.ofType('moveItem').length, 0);
});

test('with courtesy off contested loot is taken', () => {
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10]), other([12, 10])], [], [], [drop([10, 10])]);
  run(bot, snap, { cook: false, stack: false, courtesy: false });
  assert.ok(bot.ofType('moveItem').length > 0);
});

test('a far-off player claims nothing', () => {
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10]), other([60, 60])], [rat([10, 10])], [],
    [drop([10, 10], 'gold', 5, 'g1')]);
  run(bot, snap, { cook: false, stack: false });
  assert.equal(bot.ofType('attack')[0]?.targetId, 'rat1');
});

test('an ally by name is not a stranger to be avoided', () => {
  // Two of our own characters on one field are cooperating. Without allyNames
  // each would yield every monster to the other and the pair would farm nothing.
  const bot = new FakeBot(backpack([]));
  const snap = snapshot(
    [me([10, 10]), other([20, 10], 'buddy', 'Dario Amodei')],
    [rat([20, 10])]);
  run(bot, snap, { cook: false, stack: false, allyNames: ['dario'] });
  assert.equal(stateOf(bot), 'FIGHT', 'our own escort claims nothing');
});

test('roaming heads away from the crowd, not into it', () => {
  // Statistical, so it is run over many goals: with a player parked to our east
  // the chosen goals should sit further from them than blind random would give.
  const there = other([22, 10]);
  let picked = 0; const n = 40;
  for (let i = 0; i < n; i++) {
    const bot = new FakeBot(backpack([]));
    run(bot, snapshot([me([10, 10]), there], []), { cook: false, stack: false });
    const g = bot.run.farmRoamGoal;
    if (farm.distPx(g[0], g[1], there.x, there.y)
        > farm.distPx(px(10), px(10), there.x, there.y)) picked++;
  }
  assert.ok(picked > n * 0.7,
    `only ${picked}/${n} roam goals moved away from the other player`);
});

test('claimedMonsters ignores corpses and blames the nearest player', () => {
  const them = other([20, 10]);
  const snap = snapshot([me([10, 10]), them],
    [rat([20, 10], 20, 'live'), rat([20, 11], 0, 'dead')]);
  const claimed = farm.claimedMonsters(snap, me([10, 10]), [them]);
  assert.ok(claimed.has('live'));
  assert.ok(!claimed.has('dead'), 'a dead monster is nobody\'s kill to steal');
});

test('otherPlayers excludes us and our allies', () => {
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([
    me([10, 10]),
    other([20, 10], 'a', 'Dario Amodei'),
    other([21, 10], 'b', 'Stranger'),
  ]);
  const got = farm.otherPlayers(bot, snap, { allyNames: ['dario'] });
  assert.deepEqual(got.map((p) => p.id), ['b']);
});

// ---- inventory helpers -----------------------------------------------------

test('groundItems null means "unchanged", not "the floor is empty"', () => {
  const bot = new FakeBot(backpack([]));
  bot.groundItems = [drop()];
  const snap = { groundItems: null };
  if (snap.groundItems == null) snap.groundItems = bot.groundItems;
  assert.equal(snap.groundItems.length, 1);
});

test('packSpace counts free slots', () => {
  const bot = new FakeBot(backpack([item('gold', 1, 'g')], 8));
  assert.deepEqual(bot.packSpace(), [7, 8]);
});

test('packSpace with no backpack is [0, 0]', () => {
  assert.deepEqual(new FakeBot({}).packSpace(), [0, 0]);
});

// ---- travel: go where the prey actually lives ------------------------------
//
// The bug this fixes, verbatim from the issue: "when i'm on floor 0 and i farm
// cave bats, it just gets stuck roaming not knowing what to do." Every cave bat
// in the game spawns underground, and nothing ever told the bot to go down --
// cfg.depth was 0, descendStep is gated on depth < 0, so it roamed the surface
// forever looking for a monster that does not spawn there.
//
// These use the REAL extracted spawn table (maps.json, loaded at the top of this
// file), because the behaviour being tested is "does it know where cave bats
// live" -- and a synthetic world would prove only that the plumbing runs.

test('hunting cave bats on the surface heads for the hole instead of roaming', () => {
  const bot = new FakeBot(backpack([]));
  bot.z = 0;
  run(bot, snapshot([me([58, 26])], []), { huntTypes: ['caveBat'] });
  assert.equal(stateOf(bot), 'DESCEND',
    'cave bats are underground, so the trip starts by going down -- not ROAM');
  assert.ok(bot.ofType('move').length > 0, 'and it actually walks');
});

// The regression guard proper: ROAM is exactly the wrong answer here, and it is
// what the bot did before this existed.
test('a surface caveBat hunt never settles for roaming the surface', () => {
  const bot = new FakeBot(backpack([]));
  bot.z = 0;
  for (let i = 0; i < 5; i++) run(bot, snapshot([me([58, 26])], []), { huntTypes: ['caveBat'] });
  assert.notEqual(stateOf(bot), 'ROAM',
    'roaming a floor with no cave bats on it is the bug being fixed');
});

test('the spot it picks for cave bats is underground, and it is where it aims', () => {
  const bot = new FakeBot(backpack([]));
  bot.z = 0;
  const c = cfg({ huntTypes: ['caveBat'] });
  const spot = farm.huntSpot(bot, c);
  assert.ok(spot, 'the spawn table knows where cave bats are');
  assert.ok(spot.z < 0, `cave bats live underground, got z=${spot.z}`);
  assert.ok(nav.walkable(spot.z, spot.tile[0], spot.tile[1]),
    'and the destination is ground we can stand on');
});

// Rats DO spawn on the surface, so a rat hunt must not wander off looking for a
// better field -- the travel logic has to be a no-op when we are already right.
test('hunting rats on the surface stays put and fights', () => {
  const bot = new FakeBot(backpack([]));
  bot.z = 0;
  const spot = farm.huntSpot(bot, cfg({ huntTypes: ['rat'] }));
  assert.equal(spot.z, 0, 'rats are a surface monster');
  // Standing right at the spot with a rat in reach: it fights, it does not travel.
  const snap = snapshot([me(spot.tile)], [rat(spot.tile, 20)]);
  run(bot, snap, { huntTypes: ['rat'] });
  assert.ok(bot.ofType('attack').length > 0, 'prey in reach is fought, not walked past');
});

// A monster in view beats the nominal centre of the spot. Otherwise the bot
// shoves through a room full of prey to stand on one particular tile.
test('prey in view interrupts the walk to the spot', () => {
  const bot = new FakeBot(backpack([]));
  bot.z = -1;
  const spot = farm.huntSpot(bot, cfg({ huntTypes: ['caveBat'] }));
  // Far from the spot, but with a bat right next to us.
  const here = [spot.tile[0] + 30, spot.tile[1] + 30];
  const snap = snapshot([me(here)], [rat(here, 20, 'b1', 'caveBat')]);
  snap.z = -1;
  run(bot, snap, { huntTypes: ['caveBat'] });
  assert.ok(bot.ofType('attack').length > 0,
    'a bat in melee is killed now, not after a 40-tile walk');
});

// An explicit --depth is the caller naming a floor. Overriding it would ignore
// them, and would break every existing depth test's intent.
test('an explicit depth turns travel off and is obeyed', () => {
  assert.equal(new farm.FarmConfig({ depth: -1 }).travel, false,
    '--depth means "farm this floor"');
  assert.equal(new farm.FarmConfig({}).travel, true,
    'with no depth given, going to the prey is the default');
  assert.equal(new farm.FarmConfig({ travel: false }).travel, false,
    'and it can be switched off outright');
});

test('with travel off a surface caveBat hunt roams, exactly as it used to', () => {
  const bot = new FakeBot(backpack([]));
  bot.z = 0;
  run(bot, snapshot([me([50, 50])], []), { huntTypes: ['caveBat'], travel: false });
  assert.equal(stateOf(bot), 'ROAM', 'opting out restores the old behaviour');
});

// "(anything)" in the UI means hunt whatever is here; every floor has something,
// so there is nowhere better to be.
test('hunting anything picks no spot and just farms where it stands', () => {
  const bot = new FakeBot(backpack([]));
  assert.equal(farm.huntSpot(bot, cfg({ huntTypes: null })), null);
});

// ghost is in MONSTER_TYPES but has no spawn point anywhere in the bundle. The
// honest answer is to farm where we are, not to walk somewhere arbitrary.
test('a monster that spawns nowhere degrades to farming in place', () => {
  const bot = new FakeBot(backpack([]));
  bot.z = 0;
  assert.equal(farm.huntSpot(bot, cfg({ huntTypes: ['ghost'] })), null);
  run(bot, snapshot([me([50, 50])], []), { huntTypes: ['ghost'] });
  assert.equal(stateOf(bot), 'ROAM', 'no spawns known -> roam, rather than freeze');
});

// The spot must not be re-chosen mid-walk: two clusters of equal value would have
// the bot oscillate between them and never arrive at either.
test('the chosen spot is stable across ticks', () => {
  const bot = new FakeBot(backpack([]));
  bot.z = 0;
  const c = cfg({ huntTypes: ['caveBat'] });
  const first = farm.huntSpot(bot, c);
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(farm.huntSpot(bot, c), first, 'the destination does not drift');
  }
});

// A hurt bot heals before travelling: the trip can cross a floor or two, and
// starting it at 20% HP walks a nearly-dead character past everything.
test('a hurt bot retreats rather than starting the trip', () => {
  const aldric = { id: 'n1', npcType: 'healer', name: 'Brother Aldric', x: px(20), y: px(10), z: 0 };
  const bot = new FakeBot(backpack([]));
  bot.z = 0;
  run(bot, snapshot([me([50, 30], 20)], [], [aldric]), { huntTypes: ['caveBat'] });
  assert.equal(stateOf(bot), 'RETREAT', 'heal first, travel after');
});

// Travelling underground must not make the bot treat the hole it needs as a wall.
// setNavObstacles blocks trapdoors unless we MEAN to descend, and it reads
// cfg.depth -- which travelStep sets. Resolving the spot after that ran would
// route A* around the very hole the trip depends on.
test('the trapdoor to the target floor is not treated as a wall', () => {
  const bot = new FakeBot(backpack([]));
  bot.z = 0;
  run(bot, snapshot([me([58, 26])], []), { huntTypes: ['caveBat'] });
  const holeKey = nav.tileKey(HOLE[0], HOLE[1]);
  assert.ok(!bot.run.occupied.has(holeKey),
    'the hole we are travelling to must stay open to the pathfinder');
});

// Banking is a surface-only trip -- bankStep declines every tick off z=0, since
// there is no depot underground. Latching `banking` down there therefore sets it
// for good: the bot farms on with a full pack while permanently believing it is on
// a bank run, and the real trip never happens once it climbs out. Harmless while
// only --depth put bots underground; now that travel routes them there by default
// it is the normal case.
test('a full pack underground does not latch a bank trip that cannot run', () => {
  const bot = new FakeBot(backpack(
    Array.from({ length: 8 }, (_, i) => item('emberOre', 1, `ore${i}`))));
  bot.z = -1;
  const snap = snapshot([me([68, 16])], []);
  snap.z = -1;
  run(bot, snap, { huntTypes: ['caveBat'] });
  assert.ok(!bot.run.banking,
    'no depot down here, so the trip must not be latched until we surface');
});

test('a full pack on the surface still banks', () => {
  const bot = new FakeBot(backpack(
    Array.from({ length: 8 }, (_, i) => item('emberOre', 1, `ore${i}`))));
  bot.z = 0;
  run(bot, snapshot([me([74, 41])], []), { huntTypes: ['rat'] });
  assert.ok(bot.run.banking, 'the depot is right here -- go and use it');
});
