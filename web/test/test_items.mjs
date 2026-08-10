// Loot priority and "make room instead of banking" -- issue #9.
//
// Run: node --test web/test/test_items.mjs   (from web/)
//
// Three separable things are pinned here and they fail differently:
//
//  * The TABLES. Weights, equip requirements and equip slots are extracted from
//    the client bundle, and every one of them is anchored on structure because
//    the minifier renames the variables on each deploy. These tests assert the
//    extractor against the REAL live bundle text where one is available, and
//    against the baked fallback otherwise -- the same split test_maps.mjs uses,
//    and for the same reason: a name-matched table breaks silently, and silent
//    is the failure mode worth spending a test on.
//  * The CLASSIFICATION. Which items are junk. This is where the interesting
//    mistakes live, because "no stat requirement" is a good proxy for "low tier"
//    only among things you can WEAR -- applied to everything it also condemns
//    emberOre and gold, and a bot that pours its gold on the floor to save a
//    shabby shirt is worse than one that never had this feature.
//  * The BEHAVIOUR. That a full pack drops junk rather than walking to the
//    depot, that it walks to the depot anyway once there is no junk left, and
//    that a --keep type is never the thing thrown away.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const SRC = new URL('../src/core/', import.meta.url);
const load = (m) => import(new URL(m, SRC).href);

const { TILE } = await load('protocol.js');
const { AvalonBot } = await load('bot.js');
const nav = await load('nav.js');
const farm = await load('farm.js');
const items = await load('items.js');
const depot = await load('depot.js');

const MAPS = JSON.parse(
  readFileSync(new URL('../maps.json', import.meta.url), 'utf8'));
nav.loadMaps(MAPS);

// ---- fixtures (same shapes as test_farm.mjs) ------------------------------

const px = (t) => (t + 0.5) * TILE;

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

const drop = (tile, itemId, qty = 1, gid = 'g1') => ({
  id: gid, x: px(tile[0]), y: px(tile[1]), z: 0,
  item: item(itemId, qty, `i-${gid}`), ownerId: null, ownerExpiresAt: 0,
});

const logs = [];
const cfg = (o = {}) => new farm.FarmConfig({ healerName: 'aldric', ...o });
function run(bot, snap, o = {}) {
  logs.length = 0;
  farm.makeFarm(cfg(o), (m) => logs.push(m))(bot, snap);
  return bot;
}

// ---- the tables ------------------------------------------------------------

// A stand-in for the real bundle: the three tables in the shapes and the ORDER
// the client emits them, surrounded by the neighbours that make each anchor
// ambiguous. Synthetic rather than the live bundle because the suite must run
// offline -- what is being pinned is that each regex picks the right one out of
// a crowd, and a fixture states that far more sharply than 360 KB of minified
// JS. `node src/cli/main.js maps` re-checks these against the live client, and
// warns when a table stops matching.
const FAKE_BUNDLE = [
  // The stat-BONUS table comes first in the real bundle, and it opens with the
  // same key as the requirement table. This is the decoy.
  'yy={dagger:{dex:2},crescentPendant:{dex:2},cleaver:{str:1}},',
  // A display-name table: itemId -> string, the decoy for the slot extractor.
  'Xy={dagger:"Dagger",gold:"Gold",shabbyShirt:"Shabby Shirt"},',
  'iy={dagger:8,gold:.1,shabbyShirt:8,plateArmor:72,emberOre:12},',
  'vi={dagger:"hand",gold:null,shabbyShirt:"chest",plateArmor:"chest",emberOre:null},',
  'Ty={backpack:12,largeBackpack:16},',
  '_y={dagger:{dex:11},shortsword:{str:11},plateArmor:{str:16}}',
].join('');

test('the baked tables agree with each other', () => {
  // Every item with a weight needs a slot entry, or isJunk cannot judge it and
  // silently keeps it forever. A drift between the two tables is exactly the
  // kind of thing that survives review.
  for (const id of Object.keys(items.ITEM_WEIGHT_OZ)) {
    assert.ok(id in items.ITEM_SLOT, `${id} has a weight but no slot entry`);
  }
  // Every requirement must name gear. A requirement on a non-equippable item
  // would mean the slot table is the one that is wrong.
  for (const id of Object.keys(items.ITEM_REQS)) {
    assert.ok(items.ITEM_SLOT[id], `${id} has an equip requirement but no slot`);
  }
});

test('each table is picked out of a bundle full of lookalikes', () => {
  assert.deepEqual(items.extractWeights(FAKE_BUNDLE),
    { dagger: 8, gold: 0.1, shabbyShirt: 8, plateArmor: 72, emberOre: 12 });
  assert.deepEqual(items.extractSlots(FAKE_BUNDLE), {
    dagger: 'hand', gold: null, shabbyShirt: 'chest',
    plateArmor: 'chest', emberOre: null,
  });
  // The one that matters most: NOT the bonus table sitting in front of it.
  assert.deepEqual(items.extractReqs(FAKE_BUNDLE), {
    dagger: { dex: 11 }, shortsword: { str: 11 }, plateArmor: { str: 16 },
  });
});

// The requirement table and the stat-BONUS table both begin `dagger:{dex:N}`,
// and reading the bonus table as the requirement inverts the whole ranking:
// plateArmor grants str 2 and requires str 16, so a bot reading bonuses would
// rank plate at tier 2 -- below a shortsword's 11 -- and throw the plate away.
test('the bonus table alone is refused rather than read as requirements', () => {
  const bonuses = 'yy={dagger:{dex:2},crescentPendant:{dex:2},cleaver:{str:1}}';
  assert.equal(items.extractReqs(bonuses), null,
    'single-digit values and the wrong second key: not the requirement table');
});

// Extraction is matched by STRUCTURE precisely so it survives the minifier
// renaming everything, which it does on every deploy. Same tables, new names.
test('renaming every variable does not break extraction', () => {
  const renamed = FAKE_BUNDLE
    .replace(/\biy=/, 'q7=').replace(/\bvi=/, 'zz=').replace(/\b_y=/, 'Ab=');
  assert.deepEqual(items.extractWeights(renamed), items.extractWeights(FAKE_BUNDLE));
  assert.deepEqual(items.extractSlots(renamed), items.extractSlots(FAKE_BUNDLE));
  assert.deepEqual(items.extractReqs(renamed), items.extractReqs(FAKE_BUNDLE));
});

// The tables really do come out of the live client -- but the suite must run
// offline, so this is opt-in via AVALON_LIVE=1 rather than a default gate.
test('the baked tables match the live client', { skip: !process.env.AVALON_LIVE }, async () => {
  const { extractFromLive } = await load('maps.js');
  await extractFromLive();                       // installs the live tables
  assert.equal(items.weightOz('plateArmor'), items.ITEM_WEIGHT_OZ.plateArmor);
  assert.equal(items.itemTier('ghostblade'), 16);
  assert.equal(items.equipSlot('emberOre'), null);
  items.resetItems();
});

test('a bundle with no tables falls back to the baked ones', () => {
  const got = items.loadItems('nothing recognisable in here');
  assert.deepEqual(got, { weights: false, reqs: false, slots: false });
  // Still answers, using the baked copy -- the bot must not start treating
  // every item as weightless because a redeploy moved a table.
  assert.equal(items.weightOz('plateArmor'), 72);
  items.resetItems();
});

// ---- classification --------------------------------------------------------

test('junk is heavy gear the game asks nothing to wear', () => {
  for (const id of ['shabbyShirt', 'helmet', 'leatherArmor', 'shield', 'crowbar']) {
    assert.ok(items.isJunk(id), `${id} should be junk`);
  }
});

// The mistake this pins is the one that broke two existing tests when the junk
// rule first went in: emberOre has no equip requirement, so a rule that only
// read the requirement table called a bag of ore junk and threw it away. Ore is
// the haul. So is gold, and so is a trophy.
test('non-equipment is never junk, whatever its tier', () => {
  for (const id of ['emberOre', 'gold', 'ratKingsCrown', 'cookedMeat', 'healthPotion']) {
    assert.ok(!items.isJunk(id), `${id} is not gear and must not be dropped`);
    assert.equal(items.equipSlot(id), null, `${id} should have no equip slot`);
  }
});

test('anything the game gates behind a stat is kept', () => {
  for (const id of ['shortsword', 'plateArmor', 'ghostblade', 'chainmail']) {
    assert.ok(items.itemTier(id) > 0, `${id} should have a tier`);
    assert.ok(!items.isJunk(id), `${id} is gated gear and must be kept`);
  }
});

test('backpacks and torches are kept despite being requirement-free gear', () => {
  // A backpack IS the storage the depot trip depends on -- depot.js stows empty
  // ones deliberately, and dropping them would undo that.
  for (const id of ['backpack', 'largeBackpack', 'torch']) {
    assert.equal(items.itemTier(id), 0, `${id} genuinely has no requirement`);
    assert.ok(!items.isJunk(id), `${id} must never be thrown away`);
  }
});

test('light junk is left alone -- dropping it buys nothing', () => {
  // pocketWatch is 3oz of requirement-free gear: junk by tier, not worth the
  // moveItem. The floor is what stops this being a nuisance.
  assert.ok(!items.isJunk('pocketWatch'), '3oz does not move a 250oz limit');
  assert.ok(items.isJunk('pocketWatch', 1), 'but it is junk if the floor says so');
});

test('an unknown item is never junk', () => {
  // A brand new drop the tables have not heard of. Guessing here would mean the
  // bot throws away precisely the thing that just got added to the game.
  assert.ok(!items.isJunk('someNewSword2027'));
  assert.equal(items.weightOz('someNewSword2027'), 0);
});

test('the drop order is worst tier first, then heaviest', () => {
  const order = ['crowbar', 'leatherBoots', 'shabbyShirt']
    .sort((a, b) => {
      const x = items.junkRank(a); const y = items.junkRank(b);
      return x[0] - y[0] || x[1] - y[1];
    });
  // All tier 0, so weight decides -- and the heaviest goes first, because weight
  // is the limit we are trying to fix. Dropping the lightest first would need
  // four drops to buy what one buys.
  assert.deepEqual(order, ['crowbar', 'leatherBoots', 'shabbyShirt']);
});

// ---- worstJunk -------------------------------------------------------------

test('worstJunk picks the heaviest worthless thing in the pack', () => {
  const bot = new FakeBot(backpack([
    item('shabbyShirt', 1, 'a'), item('crowbar', 1, 'b'), item('helmet', 1, 'c'),
  ]));
  assert.equal(farm.worstJunk(bot, cfg()).instanceId, 'b', 'crowbar is 30oz');
});

test('worstJunk never picks a --keep type', () => {
  const bot = new FakeBot(backpack([item('crowbar', 1, 'a')]));
  assert.equal(farm.worstJunk(bot, cfg({ keepItems: ['crowbar'] })), null,
    'the run is FOR crowbars -- they are not junk today');
});

test('worstJunk ignores equipped gear and nested bags', () => {
  // The armour we are WEARING is requirement-free junk by the table, and
  // walking it to the bank is fine while stripping it mid-fight is not.
  const bot = new FakeBot({
    chest: item('leatherArmor', 1, 'worn'),
    backpack: item('backpack', 1, 'pack', [
      item('backpack', 1, 'spare', [item('crowbar', 1, 'inside')]),
      null, null, null,
    ]),
  });
  assert.equal(farm.worstJunk(bot, cfg()), null,
    'neither the worn armour nor the crowbar inside a bag is ours to drop');
});

// ---- loot priority ---------------------------------------------------------

test('a --keep type outranks nearer, better loot', () => {
  const c = cfg({ keepItems: ['rubyNecklace'] });
  assert.equal(farm.lootPriority('rubyNecklace', c), 2);
  assert.equal(farm.lootPriority('plateArmor', c), 1);
  assert.equal(farm.lootPriority('shabbyShirt', c), 0);
});

test('with no --keep set every non-junk drop ranks the same', () => {
  const c = cfg();
  assert.equal(farm.lootPriority('plateArmor', c), 1);
  assert.equal(farm.lootPriority('gold', c), 1);
  assert.equal(farm.lootPriority('shabbyShirt', c), 0, 'junk still ranks last');
});

// The behaviour the issue actually asked for: on a field strewn with drops, the
// one we came for is the one we take, even though something worthless is closer.
// `travel: false` throughout this section. Travelling to the prey's spawn runs
// AHEAD of looting in the loop -- deliberately, since a field with no prey on it
// is not worth sweeping -- so a hunt type that lives underground makes the bot
// walk to a ladder and never reach the loot branch at all. These tests are about
// which drop gets chosen, so the bot is pinned to the floor it is standing on.
test('the bot walks past near junk to reach the item the run is for', () => {
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10])], [], [], [
    drop([11, 10], 'shabbyShirt', 1, 'near'),
    drop([14, 10], 'rubyNecklace', 1, 'far'),
  ]);
  run(bot, snap, { keepItems: ['rubyNecklace'], travel: false });
  // It has to walk, so it cannot have looted yet -- what is asserted is that it
  // moved TOWARD the necklace (east, +x) rather than stopping at the shirt.
  const mv = bot.ofType('move').at(-1);
  assert.ok(mv && mv.dx > 0, `expected to head for the necklace, got ${JSON.stringify(mv)}`);
});

test('without --keep the nearest drop still wins', () => {
  // The priority band is a tiebreak ON TOP of distance, not a replacement for
  // it: with nothing named, this must behave exactly as it always did.
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10])], [], [], [
    drop([10, 10], 'plateArmor', 1, 'near'),
    drop([14, 10], 'rubyNecklace', 1, 'far'),
  ]);
  run(bot, snap, { travel: false });
  const mv = bot.ofType('moveItem');
  assert.equal(mv.length, 1, 'the one at our feet');
  assert.equal(mv[0].instanceId, 'i-near');
});

test('junk at our feet is still taken when the pack is empty', () => {
  // Band 0 is "drop this first when full", NOT "leave it on the floor". With
  // room to spare a 30oz crowbar is free money.
  const bot = new FakeBot(backpack([]));
  const snap = snapshot([me([10, 10])], [], [], [drop([10, 10], 'crowbar', 1, 'g')]);
  run(bot, snap, { travel: false });
  assert.equal(bot.ofType('moveItem').length, 1, 'picked it up');
});

// ---- make room instead of banking -----------------------------------------

// The heart of issue #9. Before this, a full pack meant one thing: walk to the
// depot. A cross-town round trip is most of a minute of not farming, and the
// bot would spend it to bank a bag of rags.
test('a pack full of junk is emptied onto the floor, not walked to the bank', () => {
  const bot = new FakeBot(backpack(
    Array.from({ length: 8 }, (_, i) => item('crowbar', 1, `c${i}`))));
  run(bot, snapshot([me([74, 41])], []), { huntTypes: ['rat'] });

  assert.ok(!bot.run.banking, 'there was junk to shed -- no trip needed');
  const mv = bot.ofType('moveItem');
  assert.equal(mv.length, 1, 'one drop per tick, like every other inventory move');
  assert.equal(mv[0].to.kind, 'ground', 'thrown on the floor');
  assert.ok(logs.some((l) => /dropping crowbar/.test(l)), `log said: ${logs.join(' | ')}`);
});

// The other half, and the one that keeps this from being a regression: once the
// bag holds nothing we would throw away, the trip is still the right answer.
test('a pack full of real haul still goes to the depot', () => {
  const bot = new FakeBot(backpack(
    Array.from({ length: 8 }, (_, i) => item('plateArmor', 1, `p${i}`))));
  run(bot, snapshot([me([74, 41])], []), { huntTypes: ['rat'] });
  assert.ok(bot.run.banking, 'nothing here is junk -- bank it');
  assert.equal(bot.ofType('moveItem').length, 0, 'and nothing was thrown away');
});

test('a --keep type is banked, never dropped, even when the pack is full', () => {
  // Eight shortswords, which are gated gear anyway -- but the point is that
  // naming them makes the protection explicit and survives a table change.
  const bot = new FakeBot(backpack(
    Array.from({ length: 8 }, (_, i) => item('shortsword', 1, `s${i}`))));
  run(bot, snapshot([me([74, 41])], []),
    { huntTypes: ['rat'], keepItems: ['shortsword'] });
  assert.ok(bot.run.banking, 'a full pack of what we came for is worth the trip');
  assert.equal(bot.ofType('moveItem').length, 0, 'and none of it hit the floor');
});

test('--no-make-room restores the old straight-to-the-depot behaviour', () => {
  const bot = new FakeBot(backpack(
    Array.from({ length: 8 }, (_, i) => item('crowbar', 1, `c${i}`))));
  run(bot, snapshot([me([74, 41])], []), { huntTypes: ['rat'], makeRoom: false });
  assert.ok(bot.run.banking, 'the escape hatch still banks');
  assert.equal(bot.ofType('moveItem').length, 0);
});

test('a pack with room to spare drops nothing', () => {
  // Discarding early would throw away sellable gear to protect headroom we are
  // not using. The junk is worth more in the bag than on the floor right up
  // until it costs us a slot we need.
  const bot = new FakeBot(backpack([item('crowbar', 1, 'c')]));
  run(bot, snapshot([me([74, 41])], []), { huntTypes: ['rat'] });
  assert.equal(bot.ofType('moveItem').length, 0, '7 free slots -- keep it');
  assert.ok(!bot.run.banking);
});

// Weight is the limit that actually bites on a haul of armour: the pack shows
// free slots while the server refuses every pickup. Making room has to answer
// that limit too, not just the slot count.
test('an overloaded pack sheds junk even with slots to spare', () => {
  const bot = new FakeBot(
    backpack([item('crowbar', 1, 'c'), item('plateArmor', 1, 'p')]),
    {
      statusEffects: [{ kind: 'wellFed', remainingMs: 60000 }],
      carriedWeightOz: 249, capacityOz: 250,
    });
  run(bot, snapshot([me([74, 41])], []), { huntTypes: ['rat'] });
  const mv = bot.ofType('moveItem');
  assert.equal(mv.length, 1, 'six free slots, but one ounce of headroom');
  assert.equal(mv[0].instanceId, 'c', 'the crowbar goes, the plate stays');
});

// A bot already walking to the bank has no use for slots and should arrive with
// everything it has -- shedding junk mid-walk would mean losing haul it had
// already decided was worth banking.
test('a latched bank trip is not interrupted to throw things away', () => {
  const bot = new FakeBot(backpack(
    Array.from({ length: 8 }, (_, i) => item('crowbar', 1, `c${i}`))));
  bot.run.banking = true;
  run(bot, snapshot([me([60, 41])], []), { huntTypes: ['rat'] });
  assert.equal(bot.ofType('moveItem').length, 0, 'walk on, sort it at the box');
});

// ---- a full depot is not a spin -------------------------------------------
//
// Found on a LIVE run, not in the unit suite, and it predates this change: with
// the depot genuinely full, bankStep ends the trip -- but ending it does not
// empty the pack, so shouldBank is still true on the very next tick. The bot
// re-latched, walked the half tile back to the box, opened it, found it full and
// left again, about ten times a second, farming nothing. The log from that run
// is 40 identical four-line cycles inside two seconds.

test('a full depot suppresses the trigger instead of re-latching every tick', () => {
  const bot = new FakeBot(backpack(
    Array.from({ length: 8 }, (_, i) => item('plateArmor', 1, `p${i}`))));
  // The verdict bankStep reaches when depotSlot finds nowhere to put anything.
  bot.run.bankFull = performance.now() / 1000;

  run(bot, snapshot([me([74, 41])], []), { huntTypes: ['rat'] });
  assert.ok(!bot.run.banking,
    'the box was full a moment ago -- walking back to it achieves nothing');
});

test('the full-depot verdict expires so an emptied box is tried again', () => {
  const bot = new FakeBot(backpack(
    Array.from({ length: 8 }, (_, i) => item('plateArmor', 1, `p${i}`))));
  // Older than DEPOT_FULL_RETRY_S: the player has had time to empty the box, and
  // a suppression with no way back means a bot that never banks again.
  bot.run.bankFull = performance.now() / 1000 - (depot.DEPOT_FULL_RETRY_S + 1);

  run(bot, snapshot([me([74, 41])], []), { huntTypes: ['rat'] });
  assert.ok(bot.run.banking, 'long enough ago to be worth another look');
});

// The two halves meeting: a full depot is exactly when shedding junk stops being
// an optimisation and becomes the only way to keep farming at all.
test('with the depot full the bot sheds junk and carries on', () => {
  const bot = new FakeBot(backpack([
    ...Array.from({ length: 7 }, (_, i) => item('plateArmor', 1, `p${i}`)),
    item('crowbar', 1, 'junk'),
  ]));
  bot.run.bankFull = performance.now() / 1000;

  run(bot, snapshot([me([74, 41])], []), { huntTypes: ['rat'] });
  const mv = bot.ofType('moveItem');
  assert.equal(mv.length, 1, 'no bank to go to -- make room here');
  assert.equal(mv[0].instanceId, 'junk');
  assert.equal(mv[0].to.kind, 'ground');
});
