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

// ---- prey behind a wall (the corner freeze) --------------------------------
//
// Prey selection is nearest-by-PIXEL, and pixels go through walls. The orc caves
// are not one open room: z=-2 has a 154-tile pocket around 13,47 whose orcs sit
// in a different connected region, and z=-1 has the same shape at 63,95. Locking
// onto one of those gave A* an unroutable goal, the chase fell through to
// pathStep's nudge, and safeStep vetoed every direction -- because the wall IS
// the thing in the way. Measured on the real maps before the fix: zero movement
// across 300 consecutive ticks, standing on the tile it started on.
//
// These run on a synthetic grid so the geometry is legible, and the freeze is
// asserted as "does it move", which is the symptom the user reported.

/** Two rooms with no door between them: column `wx` is solid wall. */
const splitMap = (w = 24, h = 12, wx = 12) => {
  const rows = [];
  for (let y = 0; y < h; y++) {
    let r = '';
    for (let x = 0; x < w; x++) {
      r += (y === 0 || y === h - 1 || x === 0 || x === w - 1 || x === wx) ? '#' : '.';
    }
    rows.push(r);
  }
  return rows;
};

/** Install a map, run the tick, and restore the real maps afterwards. */
function onMap(rows, fn) {
  nav.loadMaps({ 0: { widthTiles: rows[0].length, heightTiles: rows.length, rows,
                      teleports: [], spawns: [] } });
  try { return fn(); } finally { nav.loadMaps(MAPS); }
}

test('an orc walled off in another room does not freeze the bot', () => {
  onMap(splitMap(), () => {
    const bot = new FakeBot(backpack([]));
    // Us at x=5, orc at x=18 -- opposite sides of the solid column at x=12.
    const snap = snapshot([me([5, 5])], [rat([18, 5], 40, 'orc1', 'orc')]);
    run(bot, snap, hunting());
    const moves = bot.ofType('move').filter((m) => m.dx || m.dy);
    assert.ok(moves.length > 0,
      'must not stand still staring through a wall -- this is the freeze');
    assert.equal(stateOf(bot), 'ROAM',
      'unreachable prey falls through to roaming, which is what relocates us');
  });
});

test('a reachable orc is preferred over a nearer one behind a wall', () => {
  onMap(splitMap(), () => {
    const bot = new FakeBot(backpack([]));
    // The walled-off orc is CLOSER in pixels; the reachable one is further.
    const snap = snapshot([me([10, 5])], [
      rat([14, 5], 40, 'walled', 'orc'),
      rat([4, 5], 40, 'open', 'orc'),
    ]);
    run(bot, snap, hunting());
    assert.equal(stateOf(bot), 'FIGHT');
    assert.ok(logs.some((l) => l.includes('open') || !l.includes('walled')),
      'should be chasing the one it can actually get to');
    // It must be walking WEST, toward the reachable orc, not east into the wall.
    const moves = bot.ofType('move').filter((m) => m.dx || m.dy);
    assert.ok(moves.length > 0 && moves.every((m) => m.dx <= 0),
      `expected westward movement toward the reachable orc, got ${JSON.stringify(moves)}`);
  });
});

test('an orc in the same room is still chased normally', () => {
  onMap(splitMap(), () => {
    const bot = new FakeBot(backpack([]));
    const snap = snapshot([me([3, 5])], [rat([9, 5], 40, 'orc1', 'orc')]);
    run(bot, snap, hunting());
    assert.equal(stateOf(bot), 'FIGHT', 'the reach check must not break normal chases');
    const moves = bot.ofType('move').filter((m) => m.dx || m.dy);
    assert.ok(moves.length > 0 && moves.every((m) => m.dx >= 0), 'closes eastward');
  });
});

// Self-defense outranks the reach check: a monster landing hits on us is
// reachable by definition, whatever A* thinks of the tile it stands on. Without
// this ordering the fix would create a NEW freeze -- ignoring the thing eating us.
test('a monster attacking us is fought even if A* says it is unreachable', () => {
  onMap(splitMap(), () => {
    const bot = new FakeBot(backpack([]));
    // NOTE: the `px()` fixture adds a half tile, so me([10,5]) stands on nav
    // tile 11 -- just west of the wall column at 12 -- and the bat on tile 14,
    // in the far room. Pixel-near (~96px), tile-unroutable: exactly the shape
    // that must survive the reach check because it is hitting us.
    const snap = snapshot([me([10, 5])], [attacker(bot, [13, 5], 20, 'bat1', 'caveBat')]);
    run(bot, snap, hunting());
    // It is 3 tiles off, so the right answer is DEFEND-and-close, not a swing.
    // What matters is that it stays the target rather than being discarded as
    // unreachable and roamed away from.
    assert.equal(stateOf(bot), 'DEFEND',
      'something hitting us must never be filtered out as unreachable');
    assert.ok(logs.some((l) => l.includes('caveBat')),
      'the bat it is defending against should be the one named in the log');
  });
});

// The third freeze, and the one that actually made this intermittent: roaming
// picked a random point with no walkability check and CACHED it for 20 seconds.
// A goal that lands in rock commands no movement, so the bot stood still until
// the cache expired -- which is why jittering him by hand unstuck him. Measured
// from the real z=-1 ledge at 63,95: 30% of raw random goals pinned him.
test('roaming never settles on a goal it cannot move toward', () => {
  // The REAL z=-1 ledge at tile 63,95, where this was measured. A synthetic
  // grid does not reproduce it: nearestWalkable snaps a goal in a small pocket
  // back onto open ground, so the bad goals only exist at this scale -- a
  // 151-tile region whose neighbours are a long wall and a separate cave.
  // (The px() half-tile offset means me([62,94]) stands on nav tile 63,95.)
  const bot = new FakeBot(backpack([]));
  bot.z = -1;
  const snap = { ...snapshot([], []), z: -1 };
  snap.players = [{ id: 'me', name: 'Dario Amodei', x: 63 * TILE, y: 95 * TILE,
                    z: -1, hp: 100, maxHp: 100, level: 5 }];
  // Many independent ticks: the bug is probabilistic (~30% of goals), so one
  // tick could pass on luck alone. Each fresh bot re-samples the goal.
  for (let i = 0; i < 60; i++) {
    bot.sent.length = 0;
    bot.run = {};
    run(bot, snap, { ...hunting(), depth: -1 });
    assert.equal(stateOf(bot), 'ROAM');
    const moves = bot.ofType('move').filter((m) => m.dx || m.dy);
    assert.ok(moves.length > 0,
      `roam commanded no movement on iteration ${i} -- this is the 20s freeze`);
  }
});

// The residual freeze the fix above uncovers: a DEFEND target is kept even when
// unroutable (it is hitting us), so the chase asks A* for a path that does not
// exist and gets [0,0] back. Standing still while something eats you through a
// wall is the same bug in a narrower costume.
test('a chase that cannot be routed sidesteps instead of standing still', () => {
  onMap(splitMap(), () => {
    const bot = new FakeBot(backpack([]));
    const snap = snapshot([me([10, 5])], [attacker(bot, [13, 5], 20, 'bat1', 'caveBat')]);
    run(bot, snap, hunting());
    const moves = bot.ofType('move').filter((m) => m.dx || m.dy);
    assert.ok(moves.length > 0,
      'an unroutable chase must still move -- [0,0] here is the freeze');
  });
});

test('the hunt filter refuses a fight with the 16k-HP training dummy', () => {
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me()], [rat([10, 10], 20, 'd', 'trainingDummy')]);
  run(bot, snap, { huntTypes: ['rat'] });
  assert.equal(bot.ofType('attack').length, 0);
});

// ---- self-defense in mixed areas -------------------------------------------
//
// The orc hole (bottom left) is not an orc room -- it is an orc-and-bat room.
// Hunting orcs there meant the bats were invisible to prey selection, so the bot
// stood in the middle of them taking damage and never swinging back: it bled to
// retreatFrac, healed, walked back, and got chewed on again forever.
//
// The rule these pin down is the one swarm.js already settled for the party:
// huntTypes governs what we SEEK OUT, not what we fend off.

/**
 * A monster that has just hit us.
 *
 * The bot learns this from COMBAT EVENTS, not the snapshot -- so this marks the
 * bot, not the monster. That distinction is the whole bug: the first version of
 * this feature keyed off the snapshot's `enraged` flag, these fixtures set
 * `enraged: true`, every test passed, and the feature did nothing in production
 * because the real server never sets that flag on a monster fighting you.
 * Measured live in the orc cave: ~100 hits, 199 HP to 20, `enraged` false
 * throughout.
 *
 * So: build the monster, and tell the bot it was hit by it, the way the wire
 * would. `attackedBy` is what nearestAttacker actually reads.
 */
const attacker = (bot, tile = [10, 10], hp = 20, mid = 'bat1', mtype = 'caveBat') => {
  bot.attackedBy.set(mid, bot._now());
  return rat(tile, hp, mid, mtype);
};

/**
 * Hunt orcs right here, without the trip.
 *
 * `travel` is on by default and orcs live underground, so a plain orc hunt spends
 * these snapshots in DESCEND and never reaches prey selection at all. Every test
 * below is about WHO gets picked once we are standing in the mixed room, so the
 * trip is exactly the part to switch off -- the one test that does care about it
 * travels deliberately, at the end.
 */
const hunting = (o = {}) =>
  ({ huntTypes: ['orc'], travel: false, cook: false, stack: false, ...o });

test('a bat attacking us is fought back even while hunting orcs', () => {
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10])], [attacker(bot, [10, 10])]);
  run(bot, snap, hunting());
  assert.equal(bot.ofType('attack')[0]?.targetId, 'bat1',
    'the hunt filter must not make our own attacker invisible');
  assert.equal(stateOf(bot), 'DEFEND');
});

test('an idle off-type monster is still left alone', () => {
  // The other half of the rule: this is what stops DEFEND collapsing into
  // "hunt everything". A bat that is not fighting us is not our business.
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10])], [rat([10, 10], 20, 'bat1', 'caveBat')]);
  run(bot, snap, hunting());
  assert.equal(bot.ofType('attack').length, 0, 'it never hit us -- not our fight');
  assert.equal(stateOf(bot), 'ROAM');
});

test('a monster we have outrun stops being our fight', () => {
  // The leash half of the rule. The combat event is what makes a monster ours,
  // but it must not keep us tethered to something 15 tiles behind us for the
  // whole memory window -- otherwise walking away re-targets it forever.
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10])], [attacker(bot, [25, 10])]);
  run(bot, snap, hunting());
  assert.equal(bot.ofType('attack').length, 0);
  assert.notEqual(stateOf(bot), 'DEFEND');
});

test('its hit is remembered across ticks, not just the one it landed on', () => {
  // Attacks land about once a second and the loop ticks at 10 Hz, so a signal
  // that only survived its own tick would flicker: the bot would swing on the
  // hit tick and wander back to the hunt on the nine after it. This is what
  // ATTACKER_MEMORY_S is for.
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10])], [attacker(bot, [10, 10])]);
  for (let i = 0; i < 5; i++) run(bot, snap, hunting());
  assert.equal(bot.ofType('attack').at(-1)?.targetId, 'bat1',
    'still our fight several ticks after the blow');
});

test('an attacker is forgotten once it has stopped hitting us', () => {
  // The other end of the memory: a monster that gave up (or that we killed and
  // whose id got reused) must not stay our target forever.
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10])], [attacker(bot, [10, 10])]);
  // Backdate the hit past the memory window.
  bot.attackedBy.set('bat1', bot._now() - 999);
  run(bot, snap, hunting());
  assert.equal(bot.ofType('attack').length, 0, 'stale hit must not re-target it');
  assert.equal(bot.attackedBy.has('bat1'), false, 'and the entry is pruned');
});

test('--no-defend restores the old ignore-everything-off-type behaviour', () => {
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10])], [attacker(bot, [10, 10])]);
  run(bot, snap, hunting({ defend: false }));
  assert.equal(bot.ofType('attack').length, 0);
});

test('the hunted monster still wins when nothing is attacking us', () => {
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10])],
    [rat([10, 10], 20, 'orc1', 'orc'), rat([11, 10], 20, 'bat1', 'caveBat')]);
  run(bot, snap, hunting());
  assert.equal(bot.ofType('attack')[0]?.targetId, 'orc1');
  assert.equal(stateOf(bot), 'FIGHT');
});

// ---- the corner standoff ---------------------------------------------------
//
// Melee is decided on pixel distance; the server enforces its own reachability.
// Around a wall corner they disagree, and the fight branch's `move(0, 0)` turned
// that disagreement into a livelock: the bot stopped dead, swung at a rock, and
// was eaten by a cave bat it could not reach while the log said FIGHT.
//
// The evidence of the bad case is the absence of OUR combat events while we are
// in range and swinging -- so these drive it the way the wire does, through
// bot.lastHitAt, rather than asserting on a flag no server sends.

/** Pretend we have been toe to toe with `mid` for `s` seconds already. */
function inMeleeFor(bot, mid, s) {
  bot.run.farmMeleeTarget = mid;
  bot.run.farmMeleeSince = (performance.now() / 1000) - s;
}

/** Record that one of our swings just landed on `mid`, as the wire would. */
function weHit(bot, mid) {
  bot.lastHitAt = bot._now();
  bot.lastHitTargetId = mid;
}

test('a monster we cannot reach is stepped around, not stood in front of', () => {
  // The bug, reduced: in range, swinging, and nothing of ours has landed for
  // longer than a swing cooldown. Standing still here is what got us killed.
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10])], [attacker(bot, [10, 10])]);
  run(bot, snap, hunting());          // first tick starts the melee clock
  inMeleeFor(bot, 'bat1', 5);         // ...and five seconds of nothing landing
  run(bot, snap, hunting());
  const move = bot.ofType('move').at(-1);
  assert.ok(move.dx !== 0 || move.dy !== 0,
    'must move to break the standoff instead of holding still');
});

test('we keep swinging while stepping around the corner', () => {
  // The attack is the only evidence of whether we can reach it. Going quiet to
  // reposition would delete the standoff's own signal and make it permanent.
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10])], [attacker(bot, [10, 10])]);
  run(bot, snap, hunting());
  inMeleeFor(bot, 'bat1', 5);
  bot.sent.length = 0;
  run(bot, snap, hunting());
  assert.equal(bot.ofType('attack').at(-1)?.targetId, 'bat1');
});

test('a fight that IS landing hits stands its ground', () => {
  // The other half of the rule, and the one that stops this collapsing into
  // "always jitter": when our swings connect, holding position is correct.
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10])], [attacker(bot, [10, 10])]);
  run(bot, snap, hunting());
  inMeleeFor(bot, 'bat1', 5);
  weHit(bot, 'bat1');                 // our damage is landing
  run(bot, snap, hunting());
  const move = bot.ofType('move').at(-1);
  assert.deepEqual([move.dx, move.dy], [0, 0], 'reachable -- do not wander off');
});

test('a fresh melee is given time before being called a standoff', () => {
  // Attacks are on a ~1s cooldown and the loop runs at 10 Hz, so silence between
  // swings is the NORMAL state. Reacting to one quiet tick would make the bot
  // sidestep out of every fight it ever started.
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10])], [attacker(bot, [10, 10])]);
  run(bot, snap, hunting());
  run(bot, snap, hunting());
  const move = bot.ofType('move').at(-1);
  assert.deepEqual([move.dx, move.dy], [0, 0], 'too early to conclude anything');
});

test('switching targets restarts the clock rather than inheriting it', () => {
  // A long fight with one monster must not make the NEXT one look stuck the
  // instant we turn to it.
  const bot = new FakeBot(backpack([]));
  const first = snapshot([me([10, 10])], [attacker(bot, [10, 10], 20, 'bat1')]);
  run(bot, first, hunting());
  inMeleeFor(bot, 'bat1', 5);
  const second = snapshot([me([10, 10])], [attacker(bot, [10, 10], 20, 'bat2')]);
  run(bot, second, hunting());
  const move = bot.ofType('move').at(-1);
  assert.deepEqual([move.dx, move.dy], [0, 0], 'bat2 is a brand new fight');
});

test('chasing clears the melee clock, so arriving is a fresh fight', () => {
  // Without this a bot that fought, lost the target, chased it down and caught it
  // again would be instantly "in a standoff" on arrival.
  const bot = new FakeBot(backpack([]));
  run(bot, snapshot([me([10, 10])], [attacker(bot, [10, 10])]), hunting());
  inMeleeFor(bot, 'bat1', 5);
  run(bot, snapshot([me([10, 10])], [attacker(bot, [16, 10])]), hunting());
  assert.equal(bot.run.farmMeleeSince, undefined, 'the clock is reset by the chase');
});

test('the sidestep goes around the target, never straight into it', () => {
  // Stepping toward the monster just re-runs the approach and re-enters the same
  // standoff; the step has to be perpendicular (or, in a dead end, back out).
  const bot = new FakeBot(backpack([]));
  const m = rat([12, 10]);            // due east of us
  const step = farm.sidestep(bot, me([10, 10]), m);
  assert.notDeepEqual(step, [1, 0], 'must not press into the wall we are stuck on');
  assert.ok(step[0] !== 0 || step[1] !== 0, 'and it must actually move');
});

test('a monster on our own tile still produces a step', () => {
  // Sub-pixel separation rounds the approach vector to (0,0), and rotating that
  // yields nothing -- so the bot would freeze in exactly the standoff it just
  // decided to break out of.
  const bot = new FakeBot(backpack([]));
  const step = farm.sidestep(bot, me([10, 10]), rat([10, 10]));
  assert.ok(step[0] !== 0 || step[1] !== 0, 'any direction beats standing still');
});

test('being attacked outranks the hunted monster across the room', () => {
  // The orc we came for is 8 tiles off; the bat is in our face. Walking to the
  // orc means eating hits the whole way and arriving hurt.
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10])],
    [rat([18, 10], 20, 'orc1', 'orc'), attacker(bot, [10, 10])]);
  run(bot, snap, hunting());
  assert.equal(bot.ofType('attack')[0]?.targetId, 'bat1');
});

test('two attackers: the one nearest death is finished first', () => {
  // Lowest HP first, matching threatsToParty -- it is the one that stops hitting
  // us soonest.
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10])],
    [attacker(bot, [10, 10], 18, 'healthy'), attacker(bot, [10, 10], 3, 'nearlyDead')]);
  run(bot, snap, hunting());
  assert.equal(bot.ofType('attack')[0]?.targetId, 'nearlyDead');
});

test('an attacker is fought rather than yielded to another player', () => {
  // Courtesy is about not taking what is someone else's. A monster hitting US is
  // not a kill we are stealing -- yielding it just means standing still while it
  // kills us.
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10]), other([10, 10])], [attacker(bot, [10, 10])]);
  run(bot, snap, hunting());
  assert.equal(bot.ofType('attack')[0]?.targetId, 'bat1');
});

test('loot at our feet waits until the thing hitting us is dealt with', () => {
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10])], [attacker(bot, [10, 10])], [],
    [drop([10, 10], 'gold', 5)]);
  run(bot, snap, hunting());
  assert.equal(stateOf(bot), 'DEFEND');
  assert.equal(bot.ofType('moveItem').length, 0, 'do not loot mid-mauling');
});

test('an enraged HUNTED monster is a plain FIGHT, not a DEFEND', () => {
  // The orc we came for is also the one hitting us. Both selectors return it, so
  // `defending` must stay false -- otherwise every ordinary fight (prey retaliate
  // the moment you hit them) would relabel itself as self-defense and the log
  // would stop distinguishing the two.
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10])], [attacker(bot, [10, 10], 20, 'orc1', 'orc')]);
  run(bot, snap, hunting());
  assert.equal(bot.ofType('attack')[0]?.targetId, 'orc1');
  assert.equal(stateOf(bot), 'FIGHT');
});

test('the walk to the hunt spot pauses to kill what is chewing on us', () => {
  // This one keeps travel ON -- it is the point. travelStep only ever yielded for
  // a HUNTED monster, so something off-type that aggroed on the way used to get a
  // free escort across the floor, hitting us the whole trip.
  //
  // Hunting cave bats (a real underground spot) with an ORC on us: far enough
  // from the spot that TRAVEL is what would otherwise win this tick.
  const bot = new FakeBot(backpack([]));
  bot.z = -1;
  const spot = farm.huntSpot(bot, cfg({ huntTypes: ['caveBat'] }));
  const here = [spot.tile[0] + 30, spot.tile[1] + 30];
  const snap = snapshot([me(here)], [attacker(bot, here, 20, 'orc1', 'orc')]);
  snap.z = -1;
  run(bot, snap, { huntTypes: ['caveBat'], cook: false, stack: false });
  assert.equal(bot.ofType('attack')[0]?.targetId, 'orc1',
    'must turn and fight rather than walk on being hit');
  assert.equal(stateOf(bot), 'DEFEND');
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

// Banking used to be a surface-only trip: the trigger was gated on being ON z=0,
// so a bot that filled its pack in a cave never latched and farmed on dropping
// loot it could not carry. That was tolerable while only --depth put bots
// underground; once travel started routing them there by default it meant the
// pack was never banked at all. The trip now starts underground and climbs out,
// with cfg.depth retargeted at the surface so climbStep actually fires.
test('a full pack underground latches the trip and heads for the surface', () => {
  const bot = new FakeBot(backpack(
    Array.from({ length: 8 }, (_, i) => item('emberOre', 1, `ore${i}`))));
  bot.z = -1;
  const snap = snapshot([me([68, 16])], []);
  snap.z = -1;
  run(bot, snap, { huntTypes: ['caveBat'] });
  assert.ok(bot.run.banking,
    'a full pack is worth the walk out, not more un-lootable kills');
  assert.equal(bot.run.farmState, 'CLIMB', 'and the first step is the way up');
});

test('a full pack on the surface still banks', () => {
  const bot = new FakeBot(backpack(
    Array.from({ length: 8 }, (_, i) => item('emberOre', 1, `ore${i}`))));
  bot.z = 0;
  run(bot, snapshot([me([74, 41])], []), { huntTypes: ['rat'] });
  assert.ok(bot.run.banking, 'the depot is right here -- go and use it');
});

// The two-item loot loop that pinned Dario to a corpse: he asked for a
// shortsword, the server refused it as too heavy, he banned it -- then asked for
// the leather armor beside it, and BANNING THE ARMOR UN-BANNED THE SWORD. Round
// and round, forever.
//
// The cause is that banLoot pruned its list to "still on the floor" using
// lootCandidates, which already hides banned items. So every previously-banned
// id failed the on-floor test and was dropped: the list could never hold more
// than the single most recent item, and two heavy items ping-pong.
test('banning a second item does not un-ban the first', () => {
  const bot = new FakeBot(backpack([]));
  const ground = [
    drop([10, 10], 'shortsword', 1, 'g-sword'),
    drop([10, 10], 'leatherArmor', 1, 'g-armor'),
  ];
  const snap = snapshot([me([10, 10])], [], [], ground);

  farm.banLoot(bot, snap, 'i-g-sword');
  assert.ok(bot.run.farmLootSkip.has('i-g-sword'), 'the sword is banned');

  farm.banLoot(bot, snap, 'i-g-armor');
  assert.ok(bot.run.farmLootSkip.has('i-g-armor'), 'the armor is banned');
  assert.ok(bot.run.farmLootSkip.has('i-g-sword'),
    'banning the armor must NOT un-ban the sword -- that is the infinite loop');
});

// The corpse case: a monster's drops live INSIDE a container, so pruning has to
// see through it or every banned drop is re-offered on the next refusal.
test('a ban on an item inside a corpse survives the next ban', () => {
  const bot = new FakeBot(backpack([]));
  const corpse = drop([10, 10], 'corpse', 1, 'g-corpse');
  corpse.item = item('corpse', 1, 'i-corpse',
    [item('shortsword', 1, 'in-sword'), item('leatherArmor', 1, 'in-armor')]);
  const snap = snapshot([me([10, 10])], [], [], [corpse]);

  farm.banLoot(bot, snap, 'in-sword');
  farm.banLoot(bot, snap, 'in-armor');
  assert.ok(bot.run.farmLootSkip.has('in-sword'),
    'the first corpse drop must stay banned when the second is banned');
  assert.ok(bot.run.farmLootSkip.has('in-armor'));
});

// Pruning must still happen -- a multi-hour run otherwise accumulates thousands
// of despawned ids and tests every one on every tick.
test('a ban on an item that has left the floor is pruned', () => {
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10])], [], [],
    [drop([10, 10], 'leatherArmor', 1, 'g-armor')]);
  bot.run.farmLootSkip = new Set(['i-g-gone']);

  farm.banLoot(bot, snap, 'i-g-armor');
  assert.ok(!bot.run.farmLootSkip.has('i-g-gone'),
    'a despawned id must not be kept forever');
});
