// Depot-banking tests.
//
// Run: node --test web/test/test_depot.mjs   (from web/)
//
// Two things are being pinned here, and they fail differently:
//
//  * The WORLD FACTS -- box tiles, which side you stand on, the fact that the
//    boxes themselves are blocked. These come from the client bundle, and if a
//    redeploy moves the bank they must fail loudly rather than send the bot to
//    walk into a wall forever. So they are asserted against the real extracted
//    collision map, the same way the depth tests assert on real teleports.
//  * The POLICY -- when we leave, what we stow, what we refuse to stow, and that
//    the trip cannot be interrupted by a rat wandering past. These are asserted
//    against literal snapshots, like the rest of test_farm.mjs.
//
// The keep-food rule has a test of its own because the failure is invisible in a
// unit run and fatal in a live one: a bot that banks its food walks back out
// with no regeneration and dies of the fix.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const SRC = new URL('../src/core/', import.meta.url);
const load = (m) => import(new URL(m, SRC).href);

const { TILE } = await load('protocol.js');
const { AvalonBot } = await load('bot.js');
const nav = await load('nav.js');
const farm = await load('farm.js');
const depot = await load('depot.js');

const MAPS = JSON.parse(
  readFileSync(new URL('../maps.json', import.meta.url), 'utf8'));
nav.loadMaps(MAPS);

// ---- fixtures (same shapes as test_farm.mjs) ------------------------------

// `t * TILE`, not `(t + 0.5) * TILE`. The server maps pixels to tiles with
// round(), so the centre of tile N is at N*TILE and the half-tile form used
// elsewhere in the suite actually names tile N+1. The depot tests care about
// exact tiles -- being one off is the whole bug they exist to pin -- so they use
// the server's convention.
const px = (t) => t * TILE;

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

const rat = (tile = [10, 10], hp = 20, mid = 'rat1') => ({
  id: mid, monsterType: 'rat', x: px(tile[0]), y: px(tile[1]),
  z: 0, hp, maxHp: 20, enraged: false,
});

/** A pack with `n` distinct junk items -- the haul a full bot is carrying. */
const junk = (n, cap = 8) =>
  backpack(Array.from({ length: n }, (_, i) => item('dagger', 1, `j${i}`)), cap);

const logs = [];
const cfg = (o = {}) => new farm.FarmConfig({ healerName: 'aldric', ...o });
function run(bot, snap, o = {}) {
  logs.length = 0;
  farm.makeFarm(cfg(o), (m) => logs.push(m))(bot, snap);
  return bot;
}

/** Serve the depot container the way the server's depotUpdate would. */
function openDepot(bot, contents = [], cap = 40) {
  const slots = [...contents];
  while (slots.length < cap) slots.push(null);
  depot.handleDepot(bot, {
    type: 'depotUpdate', depot: item('depot', 1, 'depot-box', slots),
  }, () => {});
}

/**
 * Drive the loop until `pred` holds, advancing the clock between ticks.
 *
 * The clock has to move. Every step in here is throttled against
 * performance.now() (0.4 s between deposits, 2 s between open retries), and a
 * bare `for` loop runs 400 iterations in ~0.01 ms -- so without this the
 * throttles never elapse and the bot appears to do nothing forever. Live, the
 * server's ~100 ms snapshot cadence provides exactly this spacing, so stubbing
 * performance.now() to advance 100 ms per tick is not a fudge to make the test
 * pass: it is the only way to simulate the real clock the loop is written
 * against.
 */
function pump(bot, snap, o = {}, ticks = 400, pred = null) {
  const real = performance.now.bind(performance);
  let t = real();
  performance.now = () => t;
  const self = snap.players.find((p) => p.id === bot.me);
  try {
    for (let i = 0; i < ticks; i++) {
      run(bot, snap, o);
      if (pred && pred(bot)) return i + 1;
      // Apply the move the bot just asked for. Banking is a WALK to a fixed
      // tile, so a harness that leaves the bot standing still can never let it
      // arrive -- these tests would then pass or fail on whether the start tile
      // happened to be in reach, which is not what they are about. 8px/tick is
      // roughly the server's own speed at its 100 ms cadence.
      const mv = bot.sent.filter((m) => m.type === 'move').at(-1);
      if (self && mv) { self.x += mv.dx * 8; self.y += mv.dy * 8; }
      t += 100;                                  // one server snapshot apart
    }
    return ticks;
  } finally {
    performance.now = real;
  }
}

// ---- world facts ----------------------------------------------------------

test('every depot box sits on a blocked tile, approached from a walkable one', () => {
  // The client adds the boxes to its collision set, so standing ON one is
  // impossible -- the bot must path to the tile the box faces. If a redeploy
  // ever makes a box walkable (or walls in its approach) this is the test that
  // says so, rather than a bot pinned on a wall for an hour.
  const z0 = MAPS['0'];
  const at = (x, y) => z0.rows[y][x];
  for (const box of depot.DEPOT_BOXES) {
    const [bx, by] = box.tile;
    assert.equal(at(bx, by), '#', `${box.id} box tile should be blocked`);
    const [sx, sy] = depot.standTile(box);
    assert.equal(at(sx, sy), '.', `${box.id} standing tile ${sx},${sy} must be walkable`);
  }
});

test('standTile follows the facing, not a fixed offset', () => {
  // south-facing boxes are used from below, east-facing from the right. Getting
  // this backwards sends the bot to the far side of a wall it cannot cross.
  assert.deepEqual(depot.standTile({ tile: [74, 39], facing: 'south' }), [74, 40]);
  assert.deepEqual(depot.standTile({ tile: [68, 43], facing: 'east' }), [69, 43]);
});

test('the nearest box is chosen by its standing tile', () => {
  // Standing next to depot-w1's approach (69,43) must pick depot-w1, even though
  // other boxes exist -- ranking by BOX position would prefer a box whose door
  // faces away.
  assert.equal(depot.nearestBox(me([69, 43])).id, 'depot-w1');
  assert.equal(depot.nearestBox(me([74, 41])).id, 'depot-n2');
});

// ---- when to go -----------------------------------------------------------

test('a full pack starts a banking trip', () => {
  const bot = new FakeBot(junk(8));
  run(bot, snapshot([me([74, 45])], []));
  assert.ok(bot.run.banking, 'should latch into banking');
  assert.equal(bot.run.farmState, 'BANK');
});

test('a pack with room keeps farming', () => {
  const bot = new FakeBot(junk(3));
  run(bot, snapshot([me([74, 45])], [rat([74, 45])]));
  assert.ok(!bot.run.banking);
  assert.equal(bot.ofType('attack').length, 1, 'should be fighting, not banking');
});

test('a small pack holding nothing bankable does not start a trip', () => {
  // A 1-slot pack is "full" the moment anything lands in it, and a pack of pure
  // food is full of things we refuse to stow. Triggering on slot count alone
  // sent both to the depot to deposit nothing and walk straight back -- a loop
  // that never farms. Caught by test_port's roam test, which uses a 1-slot pack.
  const oneSlot = new FakeBot(backpack([], 1));
  run(oneSlot, snapshot([me([74, 45])], []));
  assert.ok(!oneSlot.run.banking, 'an empty pack has nothing to bank');

  const allFood = new FakeBot(backpack(
    Array.from({ length: 8 }, (_, i) => item('apple', 1, `a${i}`)), 8));
  run(allFood, snapshot([me([74, 45])], []));
  assert.ok(!allFood.run.banking, 'food we keep is not a reason to go');
});

test('--no-bank keeps the old leave-it-on-the-ground behaviour', () => {
  const bot = new FakeBot(junk(8));
  run(bot, snapshot([me([74, 45])], [rat([74, 45])]), { bank: false });
  assert.ok(!bot.run.banking);
  assert.equal(bot.ofType('attack').length, 1);
});

test('banking outranks fighting but not retreating', () => {
  // Full pack AND badly hurt: staying alive wins. Banking a corpse's worth of
  // loot is no use if we die on the way to the box.
  const bot = new FakeBot(junk(8));
  run(bot, snapshot([me([74, 45], 10)], []));
  assert.equal(bot.run.farmState, 'RETREAT');
});

test('a full pack banks instead of chasing the next rat', () => {
  const bot = new FakeBot(junk(8));
  run(bot, snapshot([me([74, 45])], [rat([75, 45])]));
  assert.equal(bot.ofType('attack').length, 0, 'no swinging with a full bag');
  assert.equal(bot.run.farmState, 'BANK');
});

test('the trip is latched -- a rat on the way does not cancel it', () => {
  // Without the latch the bot re-decides every tick: one step toward the box,
  // see a rat, fight, get full again, turn around. It never arrives.
  const bot = new FakeBot(junk(8));
  const snap = snapshot([me([90, 60])], [rat([90, 60])]);
  run(bot, snap);
  assert.ok(bot.run.banking);
  run(bot, snap);
  assert.equal(bot.ofType('attack').length, 0);
  assert.equal(bot.run.farmState, 'BANK');
});

test('underground, banking does not apply', () => {
  // There is no depot below the surface and no way to reach one without
  // unwinding the descent -- so a full pack underground keeps farming.
  const bot = new FakeBot(junk(8));
  bot.z = -1;
  const snap = { ...snapshot([me([10, 10])], [rat([10, 10])]), z: -1 };
  run(bot, snap, { depth: -1 });
  assert.notEqual(bot.run.farmState, 'BANK');
});

// ---- getting there and opening it -----------------------------------------

test('the bot walks to the box and opens it', () => {
  const bot = new FakeBot(junk(8));
  // Two tiles below depot-n2, so it has to walk the last step to the doorstep.
  const snap = snapshot([me([74, 42])], []);
  pump(bot, snap, {}, 60, (b) => b.ofType('openDepot').length > 0);
  const opens = bot.ofType('openDepot');
  assert.ok(opens.length > 0, 'should have sent openDepot');
  assert.equal(opens[0].boxId, 'depot-n2', 'the box it walked to');
});

test('openDepot is not sent until we are in the SERVER\'s reach of the box', () => {
  // The bug the first live run found: arrival was measured to the standing
  // tile, but the server measures from the box. Standing at 74,41 is "arrived"
  // by the old rule and 2 tiles from the box -- every openDepot from there came
  // back "You are too far away", and every deposit "Container not reachable".
  const bot = new FakeBot(junk(8));
  const snap = snapshot([me([74, 41])], []);
  run(bot, snap);                                   // one tick, no walking yet
  assert.equal(bot.ofType('openDepot').length, 0,
    'must still be walking, not opening, from 2 tiles out');
});

test('a depot refusal reopens instead of deposit-looping', () => {
  // The live loop: the server answered every moveItem with "Container not
  // reachable" and the bot re-sent it twice a second for two minutes, because
  // nothing was listening to the refusal.
  const bot = new FakeBot(junk(8));
  bot.run.banking = true;
  openDepot(bot);
  assert.ok(bot.run.depotOpen);
  depot.handleDepot(bot, {
    type: 'statusMessage', kind: 'error', text: 'Container not reachable',
  }, () => {});
  assert.ok(!bot.run.depotOpen, 'the box must no longer count as open');
  assert.equal(bot.depot, null, 'and the stale container is dropped');
});

test('an item the depot keeps refusing is eventually skipped', () => {
  // nextDeposit is deterministic, so an item the server will not take would be
  // re-offered forever. Bounded by an attempt count, and the give-up must stick.
  //
  // The pack has to stay FULL for this to be reachable: with room to spare the
  // trip finishes on arrival and never reaches the deposit loop at all.
  const stuck = [item('dagger', 1, 'stuck'),
    ...Array.from({ length: 7 }, (_, i) => item('rock', 1, `r${i}`))];
  const bot = new FakeBot(backpack(stuck, 8));
  const snap = snapshot([me([74, 42])], []);
  pump(bot, snap, {}, 40, (b) => b.ofType('openDepot').length > 0);
  openDepot(bot);
  // Never empty a slot: the server is silently refusing every deposit.
  pump(bot, snap, {}, 200, (b) => b.run.bankSkip?.has('stuck'));
  assert.ok(bot.run.bankSkip?.has('stuck'), 'should have given up on it');
  // Every other item gets the same treatment, so eventually nothing is offered
  // and the trip can end instead of spinning.
  pump(bot, snap, {}, 400, (b) => !b.run.banking);
  assert.ok(!bot.run.banking, 'the trip must end rather than retry forever');
});

test('openDepot is retried, so a dropped reply does not park the bot', () => {
  const bot = new FakeBot(junk(8));
  const snap = snapshot([me([74, 40])], []);
  // Never answer with depotUpdate: the bot must keep asking rather than
  // standing at the box forever.
  pump(bot, snap, {}, 200);
  assert.ok(bot.ofType('openDepot').length >= 2, 'should retry the open');
});

test('no deposit is sent before the depot is described', () => {
  // openDepot is not enough: until depotUpdate arrives we have no
  // containerInstanceId to move things into.
  const bot = new FakeBot(junk(8));
  pump(bot, snapshot([me([74, 40])], []), {}, 60);
  assert.equal(bot.ofType('moveItem').length, 0);
});

// ---- what gets stowed -----------------------------------------------------

test('the haul is deposited into the depot container', () => {
  const bot = new FakeBot(junk(8));
  const snap = snapshot([me([74, 40])], []);
  pump(bot, snap, {}, 20, (b) => b.ofType('openDepot').length > 0);
  openDepot(bot);
  pump(bot, snap, {}, 20, (b) => b.ofType('moveItem').length > 0);
  const mv = bot.ofType('moveItem')[0];
  assert.equal(mv.to.kind, 'container');
  assert.equal(mv.to.containerInstanceId, 'depot-box', 'into the DEPOT, not the pack');
});

test('food and potions are kept back, junk is stowed', () => {
  // The rule that keeps the bot alive on the walk back: the server only
  // regenerates HP while wellFed, so banking the last apple banks the regen.
  const bot = new FakeBot(backpack([
    item('cookedMeat', 3, 'food1'), item('healthPotion', 2, 'pot1'),
    item('dagger', 1, 'junk1'),
  ]));
  const next = depot.nextDeposit(bot);
  assert.equal(next.item.instanceId, 'junk1', 'junk goes first');

  const onlyFood = new FakeBot(backpack([
    item('cookedMeat', 3, 'food1'), item('healthPotion', 2, 'pot1'),
  ]));
  assert.equal(depot.nextDeposit(onlyFood), null, 'a pack of food banks nothing');
});

test('surplus food above the reserve IS stowed, as a partial stack', () => {
  // Keeping food is not the same as hoarding it: a long run fills the bag with
  // meat, and refusing to bank any of it would make the trip free almost nothing.
  const bot = new FakeBot(backpack([item('cookedMeat', 25, 'food1')]));
  const next = depot.nextDeposit(bot);
  assert.ok(next, 'the surplus should be depositable');
  assert.equal(next.item.instanceId, 'food1');
  assert.equal(next.quantity, 15, '25 held - 10 reserved');
});

test('equipped gear is never banked', () => {
  // nextDeposit walks the BACKPACK, not iterItems() -- which recurses through
  // equipment and would happily stow the sword we are fighting with.
  const bot = new FakeBot({
    rightHand: item('ironSword', 1, 'sword'),
    chest: item('plateArmor', 1, 'armor'),
    backpack: item('backpack', 1, 'pack', [item('dagger', 1, 'junk1'), null]),
  });
  const seen = new Set();
  for (let i = 0; i < 5; i++) {
    const n = depot.nextDeposit(bot);
    if (!n) break;
    seen.add(n.item.instanceId);
    // Simulate the move by emptying the slot.
    const pack = bot.backpack();
    pack.contents = pack.contents.map((c) => (c && c.instanceId === n.item.instanceId ? null : c));
  }
  assert.ok(seen.has('junk1'));
  assert.ok(!seen.has('sword'), 'the equipped sword must stay equipped');
  assert.ok(!seen.has('armor'));
});

test('a nested bag is storage, not haul', () => {
  const bot = new FakeBot(backpack([
    item('largeBackpack', 1, 'bag2', [null, null]), item('dagger', 1, 'junk1'),
  ]));
  const next = depot.nextDeposit(bot);
  assert.equal(next.item.instanceId, 'junk1');
});

// ---- finishing ------------------------------------------------------------

test('the trip ends once there is room again, and the box is closed', () => {
  const bot = new FakeBot(junk(8));
  const snap = snapshot([me([74, 40])], []);
  pump(bot, snap, {}, 20, (b) => b.ofType('openDepot').length > 0);
  openDepot(bot);

  // Deposit until the loop lets go of the tick. Emptying the slot on each
  // moveItem stands in for the server's equipmentUpdate -- without it the pack
  // never drains and the trip could never finish.
  let seen = 0;
  pump(bot, snap, {}, 400, (b) => {
    const mv = b.ofType('moveItem');
    if (mv.length > seen) {
      seen = mv.length;
      const moved = mv[mv.length - 1].instanceId;
      const pack = b.backpack();
      pack.contents = pack.contents.map((c) => (c && c.instanceId === moved ? null : c));
    }
    return !b.run.banking;
  });
  assert.ok(!bot.run.banking, 'banking should have finished');
  assert.equal(bot.ofType('closeDepot').length, 1, 'the box should be closed');
  const [free] = bot.packSpace();
  assert.ok(free >= 4, `should have freed real room, got ${free}`);
});

test('after banking, the bot goes back to fighting', () => {
  const bot = new FakeBot(junk(8));
  depot.endBanking(bot, () => {});
  // Empty the pack the way the deposits would have.
  bot.equipment = junk(1);
  run(bot, snapshot([me([74, 45])], [rat([74, 45])]));
  assert.equal(bot.ofType('attack').length, 1);
});

test('a trip that runs out of bankable items ends rather than spinning', () => {
  // shouldBank now refuses to START such a trip, so reach this by draining the
  // pack mid-trip: the guard and this exit cover the same hazard at different
  // moments, and the loop must let go of the tick either way.
  const bot = new FakeBot(junk(8));
  const snap = snapshot([me([74, 40])], []);
  pump(bot, snap, {}, 20, (b) => b.ofType('openDepot').length > 0);
  openDepot(bot);
  // Everything left is food we keep -- as if the deposits had already landed.
  bot.equipment = backpack([item('apple', 1, 'a0')], 8);
  pump(bot, snap, {}, 40, (b) => !b.run.banking);
  assert.ok(!bot.run.banking, 'the trip must end rather than spin');
  assert.equal(bot.ofType('closeDepot').length, 1, 'and close the box behind it');
});

test('banking gives up rather than standing at the box forever', () => {
  // The server never answers. After the timeout the bot must go back to
  // farming with a full pack -- degraded, but not frozen.
  const bot = new FakeBot(junk(8));
  const snap = snapshot([me([74, 40])], []);
  run(bot, snap);
  bot.run.bankSince = (performance.now() / 1000) - 1000;
  run(bot, snap);
  assert.ok(logs.some((m) => /timed out/.test(m)), `expected a timeout log, got ${logs}`);
});

// ---- the JSON handler -----------------------------------------------------

test('depotUpdate is what makes the container available', () => {
  const bot = new FakeBot(junk(8));
  bot.run.banking = true;                    // only a trip in progress claims it
  assert.ok(!bot.run.depotOpen);
  openDepot(bot, [item('gold', 100, 'stored')]);
  assert.ok(bot.run.depotOpen);
  assert.equal(bot.depot.instanceId, 'depot-box');
});

test('heavy gear we cannot bank does not strand the bot at the depot', () => {
  // Worn armour and the food we keep both count against the weight cap, so a
  // bot can sit above the "keep stowing" line with nothing left it is willing
  // to give. Holding it there would end the run: it never farms again.
  const bot = new FakeBot(backpack([item('apple', 1, 'a0')], 8));
  bot.stats = {
    statusEffects: [{ kind: 'wellFed' }], carriedWeightOz: 240, capacityOz: 250,
  };
  assert.ok(depot.bankDone(bot, new farm.FarmConfig({})),
    'must be able to finish with nothing bankable, however heavy');
});

test('while still heavy AND holding haul, the trip keeps going', () => {
  const bot = new FakeBot(backpack([item('plateArmor', 1, 'loot')], 8));
  bot.stats = {
    statusEffects: [{ kind: 'wellFed' }], carriedWeightOz: 240, capacityOz: 250,
  };
  assert.ok(!depot.bankDone(bot, new farm.FarmConfig({})),
    'free slots are not enough while we are still overloaded');
});

test('a depotUpdate arriving after the trip does not re-arm the next one', () => {
  // The server keeps sending these for a while after closeDepot. Acting on them
  // would leave depotOpen set, so the next trip would believe it was already
  // standing at an open box and never walk to one.
  const bot = new FakeBot(junk(8));
  bot.run.banking = false;
  openDepot(bot, [item('gold', 100, 'stored')]);
  assert.ok(!bot.run.depotOpen, 'a late update must not open anything');
});

test('unrelated JSON is ignored', () => {
  const bot = new FakeBot(junk(8));
  assert.equal(depot.handleDepot(bot, { type: 'playerStats' }, () => {}), false);
  assert.ok(!bot.run.depotOpen);
});
