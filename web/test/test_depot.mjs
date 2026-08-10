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

test('a full pack underground climbs out to reach the depot', () => {
  // The bug this pins: the trigger was gated on being ON z=0, so a bot that
  // filled up in a cave never latched -- it farmed on forever, dropping every
  // further kill's loot on the floor. Since travel routes bots underground for
  // any monster that lives there, that was the normal case, and the symptom was
  // "he never returns to bank". The trip now starts down there and the walk out
  // is its first step.
  const bot = new FakeBot(junk(8));
  bot.z = -1;
  // A real cave tile with a real way up: the ladder table is the same one
  // climbStep reads, so asserting on CLIMB here asserts against the world.
  const up = nav.nearestUpwardTeleport(-1, [10, 10]);
  assert.ok(up, 'fixture needs a z=-1 floor with a ladder out');
  const snap = { ...snapshot([me([10, 10])], [rat([10, 10])]), z: -1 };
  run(bot, snap, { depth: -1 });
  assert.ok(bot.run.banking, 'should latch the trip underground');
  assert.equal(bot.run.farmState, 'CLIMB', 'and walk toward the way up');
});

test('the bank run retargets the floor, so the climb is not undone', () => {
  // cfg.depth is recomputed every tick from the hunt spot. If banking did not
  // override it, climbStep would read the bot as already on the right floor and
  // never fire -- the trip would latch and then sit there. This is the assertion
  // that the override actually lands.
  const bot = new FakeBot(junk(8));
  bot.z = -1;
  const c = cfg({ depth: -1 });
  const snap = { ...snapshot([me([10, 10])], [rat([10, 10])]), z: -1 };
  farm.makeFarm(c, () => {})(bot, snap);
  assert.ok(bot.run.banking);
  assert.equal(c.depth, depot.DEPOT_Z, 'depth should point at the surface');
});

test('underground with no way up, the trip is abandoned rather than latched', () => {
  // The failure the old z-gate existed to prevent: `banking` set for good while
  // bankStep declines every tick off z=0, so the bot farms on believing it is
  // shopping. A floor with no ladder is the one case that still reaches it, so
  // it gives up and goes back to farming -- and does not re-latch every tick.
  const bot = new FakeBot(junk(8));
  // A floor with no ladder out. Rather than stub nav (its module namespace is
  // frozen, so the export cannot be reassigned), use a z the teleport table has
  // no upward link from -- which is the same condition climbStep tests.
  const orphan = [...Array(40).keys()]
    .map((i) => -1 - i)
    .find((z) => nav.nearestUpwardTeleport(z, [10, 10]) == null);
  assert.ok(orphan != null, 'fixture needs a floor with no way up');
  bot.z = orphan;
  const snap = { ...snapshot([me([10, 10])], [rat([10, 10])]), z: orphan };
  run(bot, snap, { depth: orphan });
  assert.ok(!bot.run.banking, 'should not stay latched with no way out');
  assert.notEqual(bot.run.farmState, 'BANK');
  // Second tick: the pack is still full, so without the stranded flag the
  // trigger fires again and the log fills with abandoned trips.
  run(bot, snap, { depth: orphan });
  assert.ok(!bot.run.banking, 'and should not re-latch on the next tick');
  assert.ok(!logs.some((m) => /heading to the depot/.test(m)),
    'no repeated trip announcements');
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

test('a spare torch is banked -- the one we light is equipped', () => {
  // The torch used to be a keeper, on the reasoning that you cannot improvise
  // one underground. But the lit torch is EQUIPPED, and nextDeposit walks the
  // pack only, so keeping one in the bag protected nothing and cost 12oz -- six
  // times the heaviest food -- plus a slot, every trip.
  const bot = new FakeBot({
    leftHand: item('torch', 1, 'lit'),
    backpack: item('backpack', 1, 'pack', [item('torch', 1, 'spare'), null]),
  });
  const next = depot.nextDeposit(bot);
  assert.ok(next, 'the spare is haul');
  assert.equal(next.item.instanceId, 'spare');
  // And the equipped one is still untouchable, for the same reason as the sword.
  const pack = bot.backpack();
  pack.contents = [null, null];
  assert.equal(depot.nextDeposit(bot), null, 'the equipped torch is not in the pack');
});

test('only one food type is kept -- the largest stack wins', () => {
  // Five kinds of food is five slots doing one slot's job: every food restores
  // regen identically and only the wellFed duration differs. The slot is the
  // scarce thing on a bank trip, so the biggest stack wins even against
  // longer-lasting food.
  assert.equal(depot.foodToKeep([
    item('cookedMeat', 11, 'm'), item('apple', 1, 'a'), item('fish', 2, 'f'),
  ]), 'cookedMeat', '11 meat beats 2 fish despite fish lasting longer');

  // Split stacks of the same food count together -- cookAndStack merges them
  // every tick, so their combined size is what that food is really worth.
  assert.equal(depot.foodToKeep([
    item('apple', 4, 'a1'), item('apple', 4, 'a2'), item('cheese', 6, 'c'),
  ]), 'apple', '4+4 apples outweigh 6 cheese once merged');

  // Ties go to the longer-lasting food, by FOOD_PREFERENCE order.
  assert.equal(depot.foodToKeep([
    item('apple', 3, 'a'), item('fish', 3, 'f'),
  ]), 'fish', 'equal stacks -> the better food');

  assert.equal(depot.foodToKeep([item('dagger', 1, 'j')]), null, 'no food at all');
});

test('the reserve caps what a stack is worth when choosing the food', () => {
  // A stack of 40 apples against a reserve of 10 is worth 10 kept apples, not
  // 40. Ranking on the raw count would keep the food with the most surplus to
  // bank -- the opposite of the point.
  assert.equal(depot.foodToKeep([
    item('apple', 40, 'a'), item('fish', 10, 'f'),
  ]), 'fish', 'both cap at 10, so the better food wins the tie');
});

test('food we did not pick is banked entirely, reserve and all', () => {
  const bot = new FakeBot(backpack([
    item('cookedMeat', 11, 'meat'), item('apple', 1, 'apple'),
    item('fish', 2, 'fish'),
  ]));
  // Applying the deposit has to honour `quantity`: a partial stack deposit
  // leaves the rest in the slot, and a harness that clears the whole slot makes
  // the chosen food disappear -- which then hands the choice to the next food and
  // fails for a reason that has nothing to do with the policy.
  const banked = new Set();
  for (let i = 0; i < 6; i++) {
    const n = depot.nextDeposit(bot);
    if (!n) break;
    banked.add(n.item.instanceId);
    const pack = bot.backpack();
    const qty = n.quantity ?? n.item.quantity ?? 1;
    pack.contents = pack.contents.map((c) => {
      if (!c || c.instanceId !== n.item.instanceId) return c;
      if (qty < (c.quantity || 1)) return { ...c, quantity: c.quantity - qty };
      return null;
    });
  }
  assert.ok(banked.has('apple'), 'the lone apple is not worth a slot');
  assert.ok(banked.has('fish'), 'nor two fish when we hold eleven meat');
  // The meat stays as a stack -- its surplus of 1 is banked, the reserve is not.
  const left = bot.backpack().contents.filter(Boolean);
  assert.deepEqual(left.map((c) => [c.itemId, c.quantity]), [['cookedMeat', 10]],
    'one food type, at its reserve, and nothing else');
});

test('rawMeat keeps its own reserve for the cooking loop', () => {
  // rawMeat is not in FOOD_PREFERENCE -- it is haul we happen to be able to
  // cook -- so the one-food rule must not strip it entirely while cookAndStack
  // still wants a couple to work on.
  const bot = new FakeBot(backpack([item('rawMeat', 2, 'raw')]));
  assert.equal(depot.nextDeposit(bot), null, 'two raw meat is the cooking reserve');

  const lots = new FakeBot(backpack([item('rawMeat', 9, 'raw')]));
  const next = depot.nextDeposit(lots);
  assert.equal(next.quantity, 7, '9 held - 2 reserved');
});

test('the chosen food still banks its own surplus', () => {
  // Picking one type is not a licence to hoard it: the reserve still applies to
  // the winner, or a long run would come home with 40 meat and bank nothing.
  const bot = new FakeBot(backpack([item('cookedMeat', 25, 'meat')]));
  const next = depot.nextDeposit(bot);
  assert.equal(next.item.instanceId, 'meat');
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

test('a bag with something in it is storage, not haul', () => {
  // The rule that protects the player's own arrangement: a bag we are carrying
  // with anything inside stays put, so a trip can never quietly bank the kit
  // somebody deliberately packed.
  const bot = new FakeBot(backpack([
    item('largeBackpack', 1, 'bag2', [item('cookedMeat', 5, 'stash'), null]),
    item('dagger', 1, 'junk1'),
  ]));
  const seen = new Set();
  for (let i = 0; i < 5; i++) {
    const n = depot.nextDeposit(bot);
    if (!n) break;
    seen.add(n.item.instanceId);
    const pack = bot.backpack();
    pack.contents = pack.contents.map(
      (c) => (c && c.instanceId === n.item.instanceId ? null : c));
  }
  assert.ok(seen.has('junk1'), 'the loose junk is still haul');
  assert.ok(!seen.has('bag2'), 'a bag holding something must not be banked');
});

test('an EMPTY spare bag is haul -- it is what grows the depot', () => {
  // The other half of the split. Stowing an empty spare is precisely how a full
  // box gains another bag's worth of slots, so refusing to bank it (the old
  // blanket skip) made the nesting impossible to set up from the bot.
  const bot = new FakeBot(backpack([
    item('largeBackpack', 1, 'spare', [null, null, null]),
  ]));
  const next = depot.nextDeposit(bot);
  assert.ok(next, 'an empty bag should be depositable');
  assert.equal(next.item.instanceId, 'spare');
});

test('a corpse in the pack is never treated as spare storage', () => {
  // isContainer excludes corpses: an empty one would otherwise look exactly
  // like a spare backpack, and the depot would end up holding a corpse.
  const bot = new FakeBot(backpack([item('corpse', 1, 'body', [null, null])]));
  assert.equal(depot.nextDeposit(bot), null, 'a corpse is not haul and not storage');
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
  //
  // Under the default (empty-to-essentials) this is bankStep's `!next` branch
  // rather than bankDone's -- so it is asserted through the loop, below. Here it
  // is pinned for the legacy threshold path, which is where the bug was.
  const bot = new FakeBot(backpack([item('apple', 1, 'a0')], 8));
  bot.stats = {
    statusEffects: [{ kind: 'wellFed' }], carriedWeightOz: 240, capacityOz: 250,
  };
  assert.ok(depot.bankDone(bot, new farm.FarmConfig({ bankEmpty: false })),
    'must be able to finish with nothing bankable, however heavy');
});

test('while still heavy AND holding haul, the trip keeps going', () => {
  const bot = new FakeBot(backpack([item('plateArmor', 1, 'loot')], 8));
  bot.stats = {
    statusEffects: [{ kind: 'wellFed' }], carriedWeightOz: 240, capacityOz: 250,
  };
  assert.ok(!depot.bankDone(bot, new farm.FarmConfig({ bankEmpty: false })),
    'free slots are not enough while we are still overloaded');
});

// ---- how much comes out of the bag ----------------------------------------
//
// The old rule stopped at two thresholds (under 80% carried weight, 40% of slots
// free) and the weight one bound first on any real haul: a pack of orc gear
// stopped after 5 deposits of 12 and walked out with 144oz still in it, at 72%
// loaded. One plate drop overflowed that and sent the bot straight back. These
// pin the replacement -- empty down to the essentials, nothing else.

test('banking empties the pack down to the essentials', () => {
  // The headline behaviour. Every piece of gear goes; the food stays.
  // A FULL pack -- shouldBank only fires with no free slots, so a roomy pack
  // never starts a trip and the test would silently assert nothing.
  const bot = new FakeBot(backpack([
    item('plateArmor', 1, 'g1'), item('chainmail', 1, 'g2'),
    item('ironSword', 1, 'g3'), item('warspear', 1, 'g4'),
    item('steelHelmet', 1, 'g5'), item('cookedMeat', 3, 'food'),
    item('healthPotion', 2, 'pot'),
  ], 7));
  const snap = snapshot([me([74, 40])], []);
  pump(bot, snap, {}, 20, (b) => b.ofType('openDepot').length > 0);
  openDepot(bot);
  // Deposits are one per 0.4 s and the harness applies them, so drive until the
  // trip ends of its own accord.
  pump(bot, snap, {}, 400, (b) => !b.run.banking);

  const banked = new Set(bot.ofType('moveItem').map((m) => m.instanceId));
  for (const g of ['g1', 'g2', 'g3', 'g4', 'g5']) {
    assert.ok(banked.has(g), `${g} should have been banked`);
  }
  assert.ok(!banked.has('food'), 'the food reserve stays');
  assert.ok(!banked.has('pot'), 'the potion reserve stays');
});

test('the 80% weight line no longer stops the trip early', () => {
  // The specific regression. Heavy, with haul left: the old rule returned
  // "done" here as soon as carried weight crossed under 80%, stranding the rest
  // of the gear in the bag.
  const bot = new FakeBot(backpack([item('plateArmor', 1, 'loot')], 8));
  bot.stats = {
    statusEffects: [{ kind: 'wellFed' }], carriedWeightOz: 100, capacityOz: 250,
  };
  assert.ok(!depot.bankDone(bot, new farm.FarmConfig({})),
    'well under the old weight line, but there is still haul -- keep stowing');
});

test('the 40% free-slots line no longer stops the trip early', () => {
  // Plenty of free slots by the old rule (7 of 8), but haul still in the bag.
  const bot = new FakeBot(backpack([item('ironSword', 1, 'loot')], 8));
  assert.ok(!depot.bankDone(bot, new farm.FarmConfig({})),
    'free slots are not a reason to leave haul behind');
});

test('--no-bank-empty restores the old thresholds', () => {
  // The escape hatch has to actually change behaviour, or it is decoration.
  const bot = new FakeBot(backpack([item('ironSword', 1, 'loot')], 8));
  assert.ok(depot.bankDone(bot, new farm.FarmConfig({ bankEmpty: false })),
    '7 of 8 slots free clears the old 40% bar');
  assert.ok(!depot.bankDone(bot, new farm.FarmConfig({ bankEmpty: true })),
    'and the default still empties');
});

test('an emptied pack still ends the trip rather than spinning', () => {
  // Removing the thresholds removed a stopping condition, so the `!next` branch
  // in bankStep is now the ONLY way a trip ends normally. If that regressed the
  // bot would stand at the bank until the timeout, every trip.
  const bot = new FakeBot(backpack([
    item('dagger', 1, 'j1'), item('cookedMeat', 3, 'food'),
  ], 2));                                            // full: 2 items, 2 slots
  const snap = snapshot([me([74, 40])], []);
  pump(bot, snap, {}, 20, (b) => b.ofType('openDepot').length > 0);
  openDepot(bot);
  pump(bot, snap, {}, 400, (b) => !b.run.banking);
  assert.ok(!bot.run.banking, 'the trip must end once only essentials remain');
  assert.ok(logs.some((m) => /nothing left to deposit|banking done/.test(m)),
    `expected a finishing log, got ${logs}`);
});

test('raw meat is mostly haul -- it is heavier raw than cooked', () => {
  // rawMeat 3oz vs cookedMeat 2oz, and raw gives a third of the wellFed
  // duration. Holding ten of it was ten slots of half-value food.
  const bot = new FakeBot(backpack([item('rawMeat', 9, 'raw')]));
  const next = depot.nextDeposit(bot);
  assert.ok(next, 'the surplus raw meat should be depositable');
  assert.equal(next.quantity, 7, '9 held - 2 reserved');
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

// ---- nested bags ----------------------------------------------------------
//
// The depot box is a container whose slots can hold BAGS, and those bags hold
// items -- so a box reporting every slot occupied is usually not out of room at
// all. These pin the search that finds the real free slot, because the failure
// is quiet: without it the bot walks to a "full" bank, deposits nothing, and
// goes back out with the same full pack, forever.

/** A container with `contents` padded out to `cap` slots. */
const bag = (iid, contents = [], cap = 4, itemId = 'backpack') => {
  const slots = [...contents];
  while (slots.length < cap) slots.push(null);
  return item(itemId, 1, iid, slots);
};

/** A container with every slot occupied. */
const fullBag = (iid, cap = 4, itemId = 'backpack') =>
  item(itemId, 1, iid, Array.from({ length: cap }, (_, i) => item('rock', 1, `${iid}-r${i}`)));

test('with room at the top level, the box itself is the destination', () => {
  // The pre-nesting behaviour has to be exactly preserved: the common case is a
  // box that is not full, and it must not start burying things in bags.
  const box = bag('depot-box', [item('gold', 5, 'g')], 10, 'depot');
  assert.equal(depot.depotSlot(box).instanceId, 'depot-box');
});

test('a full box with a bag in it deposits INTO the bag', () => {
  // The whole point of the issue: this box has no free slot of its own, but it
  // is nowhere near full.
  const inner = bag('inner', [], 4);
  const box = item('depot', 1, 'depot-box',
    [inner, item('rock', 1, 'r1'), item('rock', 1, 'r2')]);
  assert.equal(depot.depotSlot(box).instanceId, 'inner');
});

test('depth 2 -- a bag inside a bag, which is how Dario has his', () => {
  // The arrangement the issue points at. The outer bag is full, so the free slot
  // is one level deeper again.
  const deep = bag('deep', [], 4);
  const outer = item('backpack', 1, 'outer',
    [deep, item('rock', 1, 'x1'), item('rock', 1, 'x2'), item('rock', 1, 'x3')]);
  const box = item('depot', 1, 'depot-box', [outer, item('rock', 1, 'r1')]);
  assert.equal(depot.depotSlot(box).instanceId, 'deep');
});

test('the search is breadth-first, so the haul stays as shallow as it can', () => {
  // Ordering is policy, not an accident. A depth-first walk would descend into
  // the first bag and bury a dagger three levels down while a sibling bag at
  // depth 1 sat empty -- storage a human can no longer read.
  const deepInner = bag('deep-inner', [], 4);
  const deepOuter = item('backpack', 1, 'deep-outer',
    [deepInner, item('rock', 1, 'd1'), item('rock', 1, 'd2'), item('rock', 1, 'd3')]);
  const shallow = bag('shallow', [], 4);
  // deepOuter comes FIRST, so a depth-first search would find deep-inner.
  const box = item('depot', 1, 'depot-box', [deepOuter, shallow]);
  assert.equal(depot.depotSlot(box).instanceId, 'shallow',
    'the depth-1 bag must win over a depth-2 one');
});

test('a genuinely full nest returns nothing rather than looping', () => {
  const box = item('depot', 1, 'depot-box', [fullBag('b1'), fullBag('b2')]);
  assert.equal(depot.depotSlot(box), null);
});

test('a corpse in the depot is not filled up', () => {
  // An empty corpse in the bank looks exactly like a spare bag. Putting the haul
  // in one is funny right up until it despawns.
  const box = item('depot', 1, 'depot-box',
    [item('corpse', 1, 'body', [null, null]), item('rock', 1, 'r')]);
  assert.equal(depot.depotSlot(box), null, 'the corpse must not count as storage');
});

test('a container cycle cannot hang the tick', () => {
  // The depot structure comes from the server, so this walk is over data we do
  // not control. A cycle has never been sent; an unbounded search over one would
  // spin forever rather than fail, which is the worst way to find out.
  const a = item('backpack', 1, 'a', []);
  const b = item('backpack', 1, 'b', [a]);
  a.contents = [b];                                  // a -> b -> a
  const box = item('depot', 1, 'depot-box', [a, item('rock', 1, 'r')]);
  assert.equal(depot.depotSlot(box), null);
});

test('free-slot counting sees through the nesting', () => {
  // The number a human uses to decide whether to buy another backpack. Counting
  // only the box's own slots would report a full bank while bags inside it sit
  // empty.
  const box = item('depot', 1, 'depot-box', [bag('inner', [], 4), item('rock', 1, 'r')]);
  const [free, cap] = depot.depotFree(box);
  // 2 box slots (both used) + 4 inner slots (all free).
  assert.equal(cap, 6);
  assert.equal(free, 4);
});

test('the deposit is addressed to the nested bag, not the box', () => {
  // End to end through the real loop: the moveItem the server receives must name
  // the inner container, because addressing the full box is what the server
  // refuses.
  const bot = new FakeBot(junk(8));
  const snap = snapshot([me([74, 40])], []);
  pump(bot, snap, {}, 20, (b) => b.ofType('openDepot').length > 0);
  // A box with no free slot of its own, holding one empty bag.
  depot.handleDepot(bot, {
    type: 'depotUpdate',
    depot: item('depot', 1, 'depot-box', [bag('inner', [], 6), item('rock', 1, 'r')]),
  }, () => {});
  pump(bot, snap, {}, 20, (b) => b.ofType('moveItem').length > 0);
  const mv = bot.ofType('moveItem')[0];
  assert.ok(mv, 'a deposit should have been sent');
  assert.equal(mv.to.containerInstanceId, 'inner',
    'must deposit into the nested bag, not the full box');
});

test('a full depot ends the trip instead of retrying forever', () => {
  // Without the check the bot re-offers the same item until the 90 s timeout,
  // standing at a bank that cannot take it.
  const bot = new FakeBot(junk(8));
  const snap = snapshot([me([74, 40])], []);
  pump(bot, snap, {}, 20, (b) => b.ofType('openDepot').length > 0);
  depot.handleDepot(bot, {
    type: 'depotUpdate', depot: item('depot', 1, 'depot-box', [fullBag('b1')]),
  }, () => {});
  pump(bot, snap, {}, 60, (b) => !b.run.banking);
  assert.ok(!bot.run.banking, 'the trip must end');
  assert.equal(bot.ofType('moveItem').length, 0, 'and deposit nothing');
  assert.ok(logs.some((m) => /depot is full/.test(m)),
    `expected a full-depot log, got ${logs}`);
});
