// Depot banking: walk to the bank when the pack fills, stow the haul, come back.
//
// Without this a full bot is a stopped bot -- it keeps killing, but every drop
// after the last free slot is left on the floor to despawn (farm.js has always
// logged "BACKPACK FULL ... leaving loot on the ground", which is the symptom
// this module removes). The depot turns a full pack from the end of the run into
// a round trip.
//
// Everything here is derived from the live client, NOT guessed:
//
//  * The boxes are the client's `ia` table -- id + tile + facing, baked into the
//    bundle. They are static furniture, so unlike a corpse they never appear in
//    `groundItems` and there is nothing to scan for: you go to a known tile.
//  * Their tiles are BLOCKED (the client adds them to the collision set), so you
//    stand on the walkable tile the box faces and interact from there.
//  * `openDepot {boxId}` is the only way in; the server answers `depotUpdate
//    {depot}` with a container that has an `instanceId` and `contents`, exactly
//    like a backpack. Which is why depositing needs no new verb: it is the same
//    `moveItem` into `{kind:'container', containerInstanceId}` that looting and
//    stacking already use.
//  * The depot building is a SANCTUARY (the client's safe-zone set is
//    `["temple","depot"]`), so the trip is also the safest place to be -- nothing
//    can attack us while we sort the bag.
//
// The one rule that is ours rather than the game's: we stow the haul but keep
// the consumables. A bot that banks its food and potions walks back out unable
// to regenerate, and that is a slower death than a full backpack.
//
// NESTED BAGS. A depot box holds a fixed number of slots, and once they are all
// occupied the trip ends with the haul still in the pack. But a backpack stored
// IN the box is itself a container, so its slots are storage too -- and a bag
// inside that bag is more storage again. Nesting does not create capacity out of
// nothing (each bag still costs a slot in its parent, and the game charges its
// weight), but it does mean a full-looking box is rarely actually full: six
// boxes of bags-in-bags is enough storage that we stop worrying about the cap.
// `depotSlot` is what makes the box's own nested bags usable -- it picks the
// destination container instead of assuming the box's top level, so the deposit
// goes wherever there is genuinely room.

import { TILE } from './protocol.js';
import { distPx, navStep, farmLog } from './farm.js';
import * as nav from './nav.js';

// Deliberately NOT named `now`/`since`: farm.js declares its own module-private
// helpers by those names, and the userscript bundler flattens every module into
// one scope, where two `const now` are a syntax error that breaks the whole
// script. Same clock, distinct names.
const depotNow = () => performance.now() / 1000;
const depotSince = (bot, key) => depotNow() - (bot.run[key] ?? -Infinity);

/**
 * The depot boxes, from the client bundle's `ia` table (z=0, the town bank).
 *
 * `facing` is the side you stand on: a 'south'-facing box is used from the tile
 * BELOW it, an 'east'-facing one from the tile to its right. That mirrors the
 * client's own hit test, which accepts a click on the box tile or on the tile it
 * faces.
 */
export const DEPOT_BOXES = [
  { id: 'depot-n1', tile: [72, 39], facing: 'south' },
  { id: 'depot-n2', tile: [74, 39], facing: 'south' },
  { id: 'depot-n3', tile: [76, 39], facing: 'south' },
  { id: 'depot-n4', tile: [78, 39], facing: 'south' },
  { id: 'depot-w1', tile: [68, 43], facing: 'east' },
  { id: 'depot-w2', tile: [68, 45], facing: 'east' },
];

export const DEPOT_Z = 0;

// How close we WANT to be before sending openDepot. The server's own reach is
// 1.5 tiles (`Z*1.5`, the figure farm.js uses for ladders); we aim for 1.25 so
// we are not sitting exactly on the boundary, where a pixel of drift or a
// rounding difference turns every request into "You are too far away".
//
// This is a preference, not a gate. When the pathfinder says it has finished
// (A* works in whole tiles and reports done from the ADJACENT tile) we ask from
// wherever we are, because the alternative is standing still forever -- see the
// [0,0] branch in bankStep.
const DEPOT_INTERACT_PX = TILE * 1.25;

// Re-send openDepot this often while waiting for depotUpdate. The reply is a
// JSON frame that can be dropped or arrive late; without a retry a single lost
// message parks the bot at the box forever.
const OPEN_RETRY_S = 2.0;
// One moveItem per this many seconds. Same cadence as looting: the server
// applies these one at a time and a burst just races its own inventory updates.
const DEPOSIT_INTERVAL_S = 0.4;
// If a deposit round trip takes longer than this, give up and go back to
// farming rather than standing at the bank forever.
const DEPOT_TIMEOUT_S = 90.0;
// Keep stowing until carried weight is under this fraction of capacity, so the
// walk back out has headroom for an actual haul rather than one apple.
const BANK_UNTIL_WEIGHT_FRAC = 0.8;
// How many times to offer one item before deciding the depot will not take it.
// More than one because a single moveItem can be lost or race an inventory
// update; small, because the failure mode this bounds is an infinite loop.
const DEPOSIT_ATTEMPTS = 3;

/** The walkable tile you stand on to use `box`. */
export function standTile(box) {
  const [x, y] = box.tile;
  return box.facing === 'south' ? [x, y + 1] : [x + 1, y];
}

/**
 * The box to bank at: the one whose standing tile is nearest, in tiles.
 *
 * Distance is measured to the STANDING tile rather than to the box, because
 * that is where we actually have to walk -- the west boxes are approached from
 * the east, so ranking by box position picks a box whose door faces away.
 */
export function nearestBox(me) {
  const mt = [nav.tileOf(me.x), nav.tileOf(me.y)];
  let best = null; let bestD = Infinity;
  for (const box of DEPOT_BOXES) {
    const [sx, sy] = standTile(box);
    const d = Math.hypot(sx - mt[0], sy - mt[1]);
    if (d < bestD) { bestD = d; best = box; }
  }
  return best;
}

// ---- what to keep ---------------------------------------------------------

// Consumables we never bank: these are what keep the bot alive on the walk back.
// Food is not a nicety -- the server only regenerates HP while `wellFed` is up,
// so a bot that stows its last apple has banked its own regeneration.
const KEEP_ITEMS = new Set([
  'cookedMeat', 'rawMeat', 'fish', 'cheese', 'apple', 'avocado', 'iceCream',
  'healthPotion', 'largeHealthPotion', 'manaPotion', 'largeManaPotion',
  'torch',
]);

// How many slots' worth of each kept consumable to hold back. Anything beyond
// this is surplus and gets banked -- otherwise a long run fills the pack with
// food and the trip frees almost nothing.
const KEEP_QUANTITY = {
  cookedMeat: 10, rawMeat: 10, fish: 5, cheese: 5, apple: 10,
  avocado: 5, iceCream: 5, healthPotion: 5, largeHealthPotion: 5,
  manaPotion: 5, largeManaPotion: 5, torch: 1,
};

/**
 * The next item to stow, or null when the pack holds only what we keep.
 *
 * Walks the backpack's own slots rather than `iterItems()` so equipped gear is
 * never a candidate: `iterItems` recurses through equipment, and banking the
 * sword we are fighting with would be a memorable bug.
 *
 * A bag carried in the pack is haul only when it is EMPTY. That split is the
 * point of the nesting work: an empty spare is exactly what the depot wants --
 * stowing it is what turns one full box into a box with another bag's worth of
 * slots inside it -- while a bag with anything in it is storage the player
 * arranged deliberately, and emptying our own kit into the bank by accident is
 * the bug the old blanket skip was protecting against.
 */
export function nextDeposit(bot, keepQty = KEEP_QUANTITY) {
  const pack = bot.backpack();
  if (!pack) return null;
  const contents = pack.contents || [];
  // Items this trip has already given up on (see the attempt counter in
  // bankStep). Without honouring it here the "give up" would not stick: this
  // function is deterministic and would hand back the same item next tick.
  const skip = bot.run?.bankSkip;

  // Count what we hold of each kept item, so the surplus above the reserve can
  // still go in. Counted over the pack only, matching what we iterate below.
  const held = new Map();
  for (const it of contents) {
    if (!it || it.contents != null) continue;
    held.set(it.itemId, (held.get(it.itemId) || 0) + (it.quantity || 1));
  }

  for (const it of contents) {
    if (!it) continue;                             // empty slot
    if (skip?.has(it.instanceId)) continue;        // already refused this trip
    if (it.contents != null) {
      // A container. Empty ones are spare storage the depot can use; anything
      // with contents stays where the player put it. Note this deposits the bag
      // whole -- we never move its contents out first, so nothing inside can be
      // separated from it by accident.
      if (isContainer(it) && it.contents.every((s) => s == null)) return { item: it };
      continue;
    }
    if (!KEEP_ITEMS.has(it.itemId)) return { item: it };
    // A kept consumable: bank only the amount above the reserve, and only when
    // this single stack is what pushes us over -- partial deposits use the
    // `quantity` field moveItem already supports.
    const reserve = keepQty[it.itemId] ?? 0;
    const surplus = (held.get(it.itemId) || 0) - reserve;
    if (surplus <= 0) continue;
    const qty = Math.min(surplus, it.quantity || 1);
    if (qty > 0) return { item: it, quantity: qty };
  }
  return null;
}

// ---- where in the depot it goes -------------------------------------------

// Containers we refuse to fill even when they turn up in the depot. A corpse in
// the bank is a curiosity rather than storage, and stuffing the haul into one is
// the kind of thing that is very funny until the corpse despawns with the haul
// inside it.
const CLOSED_CONTAINERS = new Set(['corpse', 'playerBody']);

/**
 * True if `it` is a container we may store things inside.
 *
 * The test is `contents != null`, the same one `backpack()` and `nextDeposit`
 * use -- the server marks every container that way, and a bag with all its slots
 * full still has the array. Deliberately NOT a check against a list of backpack
 * itemIds: a corpse is a container too, and so is anything the game adds later.
 * What we must not do is descend into something whose contents are somebody
 * else's problem, which is why `CLOSED_CONTAINERS` exists.
 */
function isContainer(it) {
  return !!it && it.contents != null && !CLOSED_CONTAINERS.has(it.itemId);
}

// How deep to recurse when looking for a free slot. Dario's depot is a depth-2
// chain, so 2 would already cover the observed case; the limit exists to bound
// the walk over a structure the SERVER owns, not to express a game rule -- if a
// depotUpdate ever came back with a container cycle, an unbounded search would
// hang the tick. Generous enough that real nesting is never the thing that stops
// us.
const MAX_NEST_DEPTH = 8;

/**
 * The container inside the depot with a free slot, nearest to the top.
 *
 * Breadth-first, and that ordering is the whole policy: filling the box's own
 * slots before descending keeps the shallowest arrangement that holds the haul,
 * which is the one a human can still read when they open the box. A depth-first
 * search would bury the first dagger of the run at the bottom of the deepest
 * chain and leave the top level empty.
 *
 * Returns the depot itself when it has room -- so the common case (a box that is
 * not full) behaves exactly as it did before nesting existed.
 */
export function depotSlot(depot, maxDepth = MAX_NEST_DEPTH) {
  if (!depot || depot.contents == null) return null;
  // [container, depth]. Seeded with the box itself: its own slots come first.
  let level = [depot];
  // `seen` guards against a container graph that is not a tree. The server has
  // never sent one, but this walk is over data we do not control and a cycle
  // would spin the tick rather than fail loudly.
  const seen = new Set([depot.instanceId]);
  for (let depth = 0; depth <= maxDepth && level.length; depth++) {
    const next = [];
    for (const c of level) {
      const contents = c.contents || [];
      // A free slot at this level wins -- BFS means no shallower one exists.
      if (contents.some((s) => s == null)) return c;
      for (const it of contents) {
        if (!isContainer(it) || seen.has(it.instanceId)) continue;
        seen.add(it.instanceId);
        next.push(it);
      }
    }
    level = next;
  }
  return null;
}

/**
 * A name for a nested bag that a human can act on.
 *
 * "keeping track of which backpack is which" is the actual difficulty with a
 * nested depot: every bag reports the same `itemId`, so a log line saying
 * "into the backpack" names three different containers over one trip. The
 * instanceId is what distinguishes them and what the server addresses, so it
 * goes in the line -- shortened, because the full one is a UUID and the log is
 * read in a narrow panel.
 */
function it2Name(it) {
  const id = String(it.instanceId ?? '?');
  return `${it.itemId ?? 'container'}(${id.length > 8 ? `${id.slice(0, 8)}…` : id})`;
}

/**
 * How many free slots the depot holds in total, counting nested bags.
 *
 * Only used for the log line -- "depot open (12/40 slots used)" is a lie once
 * the box holds bags, and the number a human wants when deciding whether to buy
 * another backpack is the one that counts the nesting.
 */
export function depotFree(depot, maxDepth = MAX_NEST_DEPTH) {
  if (!depot || depot.contents == null) return [0, 0];
  let free = 0; let cap = 0;
  let level = [depot];
  const seen = new Set([depot.instanceId]);
  for (let depth = 0; depth <= maxDepth && level.length; depth++) {
    const next = [];
    for (const c of level) {
      const contents = c.contents || [];
      cap += contents.length;
      for (const it of contents) {
        if (it == null) { free++; continue; }
        if (!isContainer(it) || seen.has(it.instanceId)) continue;
        seen.add(it.instanceId);
        next.push(it);
      }
    }
    level = next;
  }
  return [free, cap];
}

// ---- the trip -------------------------------------------------------------

/**
 * True once the pack is full enough to be worth a trip.
 *
 * `freeSlots` is a margin, not a full-pack test: banking only at zero free slots
 * means the last kill before the trip still had nowhere to put its drops. We
 * leave on the last slot or two so the haul arrives intact.
 */
export function shouldBank(bot, cfg) {
  if (!cfg.bank) return false;
  const [free, cap] = bot.packSpace();
  if (!cap) return false;
  // Either limit can be the binding one. Weight is the one that bites first
  // when the haul is ore or armour: the pack still shows free slots while the
  // server refuses every pickup, and a slots-only trigger would never leave.
  const heavy = bot.overloaded(cfg.bankWeightMarginOz ?? 0);
  if (!heavy && free > (cfg.bankFreeSlots ?? 1)) return false;
  // Full is not enough: there must be something we would actually stow. A tiny
  // pack (or one holding only food we keep) is "full" from its first apple, and
  // without this check that bot walks to the bank, deposits nothing, and comes
  // straight back -- forever, never farming at all.
  return nextDeposit(bot) != null;
}

/**
 * True when the trip is finished: enough room to farm again.
 *
 * Deliberately a HIGHER bar than `shouldBank` -- leaving the moment we are under
 * the trigger would send us back after one kill. Hysteresis, same shape as the
 * retreat/resume band in the farm loop.
 */
export function bankDone(bot, cfg) {
  const [free, cap] = bot.packSpace();
  if (!cap) return true;
  // Leaving while still overloaded would walk us back out to a field where
  // every pickup is refused -- the trip has to fix the binding limit, and
  // weight is not fixed by having free slots.
  //
  // Gated on there still being something to stow, though: gear we are wearing
  // and food we refuse to bank both count against the cap, so a heavily-armoured
  // bot can sit above the line with nothing left to give. Without the second
  // clause that bot never finishes the trip and never farms again.
  const [carried, capOz] = bot.weight();
  if (capOz && carried >= capOz * BANK_UNTIL_WEIGHT_FRAC && nextDeposit(bot)) return false;
  return free >= Math.max((cfg.bankFreeSlots ?? 1) + 1, Math.ceil(cap * 0.4));
}

/**
 * Note the depot container the server just handed us.
 *
 * Wired into bot.onJson because `depotUpdate` is JSON and the farm loop only
 * ever sees binary snapshots -- the same split that made the healer dialogue
 * need a handler. Without this the bot opens the box and stands there with
 * nowhere to put anything.
 */
export function handleDepot(bot, msg, log) {
  // The server refuses out-of-range depot work with a plain statusMessage, and
  // ignoring those is what turned the first live run into a deposit loop: it
  // re-sent the same moveItem twice a second for two minutes while the server
  // answered "Container not reachable" every time, and nothing in the bot was
  // listening. Treat the refusal as the state change it is -- the box is not
  // open, so go back to walking.
  if (msg?.type === 'statusMessage' && msg.kind === 'error'
      && /too far|not reachable|out of range/i.test(msg.text || '')) {
    if (!bot.run.banking) return false;          // not our error
    bot.run.depotOpen = false;
    bot.depot = null;
    bot.run.bankOpenSent = null;                 // let the retry fire at once
    log?.(`depot refused: ${msg.text} -- closing the gap`);
    return true;
  }

  if (msg?.type !== 'depotUpdate') return false;
  // Late updates after we have finished and closed the box are not ours to act
  // on: re-arming depotOpen here would make the NEXT trip think it was already
  // standing at an open depot, and skip walking to one.
  if (!bot.run.banking) return true;
  const depot = msg.depot || null;
  bot.depot = depot;
  if (depot) {
    // Counted over the nesting, not just the box's own slots: once the box holds
    // bags, its top-level count says "full" while there is plenty of room
    // inside, and that is the number a human uses to decide whether to buy
    // another backpack.
    const [free, cap] = depotFree(depot);
    const used = cap - free;
    // Log the OPENING, not every update. The server re-sends depotUpdate after
    // each successful deposit (and keeps sending them for a while afterwards),
    // so logging unconditionally printed "depot open" once per deposited item
    // and then once per pickup for the rest of the run -- noise that buried the
    // lines you actually want.
    const wasOpen = bot.run.depotOpen;
    bot.run.depotOpen = true;
    if (!wasOpen) log?.(`depot open (${used}/${cap} slots used)`);
  }
  return true;
}

/**
 * One tick of the banking trip. True while it owns the tick.
 *
 * The whole trip is a state machine over `bot.run`, driven off the same snapshot
 * clock as everything else:
 *
 *   walk to the box -> openDepot (retry until depotUpdate) -> moveItem per tick
 *   -> pack light enough -> release the tick back to the farm loop
 */
export function bankStep(bot, snap, me, cfg, log) {
  const t = depotNow();

  // Underground there is no depot and no way to reach one without unwinding the
  // descent, so banking simply does not apply -- farm on and let the pack cap.
  if ((bot.z ?? 0) !== DEPOT_Z) return false;

  if (!bot.run.bankSince) bot.run.bankSince = t;
  if (t - bot.run.bankSince > DEPOT_TIMEOUT_S) {
    if (!bot.run.bankWarnedSlow) {
      bot.run.bankWarnedSlow = true;
      log?.('!! banking timed out -- back to farming with a full pack');
    }
    return false;
  }

  const box = bot.run.bankBox || (bot.run.bankBox = nearestBox(me));
  const [stx, sty] = standTile(box);
  // `tile * TILE`, NOT `(tile + 0.5) * TILE`. The server maps pixels to tiles
  // with round(), not floor() -- nav.tileOf does the same -- so a half-tile
  // offset lands on the NEXT tile. That off-by-one is what broke the first live
  // run: the goal for standing tile 74,40 resolved to tile 75,41, A* announced
  // "arrived" there, and from 2.1 tiles out every openDepot was refused while
  // the bot stood still. takeTeleport uses the bare `tile * TILE` form for
  // exactly this reason.
  const goal = [stx * TILE, sty * TILE];
  // Two distances, and using the wrong one is why the first live run opened
  // nothing: we WALK to the standing tile, but the server measures reach from
  // the BOX. Standing one tile past the approach put us 2.2 tiles from the box
  // -- inside our own arrival radius, outside the server's -- so every openDepot
  // came back "You are too far away" and every deposit "Container not
  // reachable". Arrival is now gated on the distance the server actually checks.
  const d = distPx(me.x, me.y, goal[0], goal[1]);
  const dBox = distPx(me.x, me.y, box.tile[0] * TILE, box.tile[1] * TILE);

  // --- walk there ---------------------------------------------------------
  // Arrival is "standing on the standing tile", NOT "within X of the box", and
  // the difference matters in both directions:
  //
  //  * Too loose (the first live bug) -- stopping wherever we happened to be
  //    within reach of the STANDING TILE left us 2+ tiles from the box, and
  //    every request came back "You are too far away".
  //  * Too tight -- gating on `dBox <= 1.25` froze the bot on the west boxes:
  //    it reaches the standing tile, which is 1.27 tiles from the box, so A*
  //    reports arrived (move 0,0) while the range check still says "walk".
  //    Nothing moves and the trip times out.
  //
  // The standing tile is the client's own answer to where a player stands to
  // use this box, and it is 1.0-1.27 tiles out -- comfortably inside the
  // server's 1.5. So: walk until we are ON it, then ask.
  if (dBox > DEPOT_INTERACT_PX) {
    farmLog(bot, 'BANK',
      () => `walking to ${box.id} (${(d / TILE).toFixed(1)} tiles)`, log);
    const [dx, dy] = navStep(bot, me, goal[0], goal[1]);
    // A [0,0] from the pathfinder means "nothing left to walk" -- A* works in
    // whole tiles and reports done from the tile ADJACENT to the goal. If we
    // treated that as "keep walking" we would stand here forever re-asking a
    // pathfinder that has already finished (the freeze documented in
    // intents.js, and what an earlier version of this check did on the west
    // boxes). It is the signal to stop walking and start asking, even though
    // the range check above would rather we came closer.
    if (dx !== 0 || dy !== 0) { bot.move(dx, dy); return true; }
    if (!bot.run.bankNudged) {
      bot.run.bankNudged = true;
      log?.(`${box.id}: pathfinder is done ${(dBox / TILE).toFixed(2)} tiles `
        + 'from the box -- opening from here');
    }
  }

  bot.move(0, 0);

  // --- open it ------------------------------------------------------------
  if (!bot.run.depotOpen) {
    if (depotSince(bot, 'bankOpenSent') >= OPEN_RETRY_S) {
      bot.run.bankOpenSent = t;
      log?.(`opening ${box.id}`);
      bot.send({ type: 'openDepot', boxId: box.id });
    }
    farmLog(bot, 'BANK', () => `at ${box.id}, waiting for it to open`, log);
    return true;
  }

  // --- stow ---------------------------------------------------------------
  const depot = bot.depot;
  if (!depot) return true;                       // opened but not yet described

  const next = nextDeposit(bot);
  if (!next) {
    // Nothing left worth banking. If the pack is STILL full at this point the
    // haul is all consumables we refuse to stow, and going back for more would
    // just bounce us off the trigger -- so end the trip either way.
    log?.('nothing left to deposit');
    endBanking(bot, log);
    return false;
  }

  if (bankDone(bot, cfg)) {
    endBanking(bot, log);
    return false;
  }

  // Where it goes: the box's own slots first, then into a bag stored in the box,
  // then a bag in that bag. Resolved per deposit rather than once per trip
  // because each successful moveItem fills a slot -- caching the destination
  // would keep aiming at a container that filled up two items ago.
  const into = depotSlot(depot);
  if (!into) {
    // Every slot at every depth is occupied. Nothing to do but leave: staying
    // would re-offer the same item until the trip timed out, which is the
    // deposit-side twin of the corpse loot loop.
    const [dFree, dCap] = depotFree(depot);
    log?.(`!! the depot is full (${dCap - dFree}/${dCap} slots, nested included)`
      + ' -- store a spare backpack in it to make room');
    endBanking(bot, log);
    return false;
  }

  if (depotSince(bot, 'bankLastMove') >= DEPOSIT_INTERVAL_S) {
    bot.run.bankLastMove = t;
    const { item: it, quantity } = next;
    // Give up on an item the server keeps refusing. Asking for the same
    // instanceId over and over is the deposit-side twin of the corpse loot loop:
    // nextDeposit is deterministic, so without this an item the server will
    // never accept is re-offered until the whole trip times out.
    const tries = bot.run.bankTries || (bot.run.bankTries = new Map());
    const n = (tries.get(it.instanceId) || 0) + 1;
    tries.set(it.instanceId, n);
    if (n > DEPOSIT_ATTEMPTS) {
      bot.run.bankSkip = (bot.run.bankSkip || new Set()).add(it.instanceId);
      log?.(`giving up on ${it.itemId} -- the depot will not take it`);
      return true;
    }
    const where = into.instanceId === depot.instanceId
      ? '' : ` into the ${it2Name(into)}`;
    log?.(`depositing ${it.itemId} x${quantity ?? it.quantity ?? 1}${where}`);
    bot.moveItem(it.instanceId,
      { kind: 'container', containerInstanceId: into.instanceId }, quantity);
  }
  const [free, cap] = bot.packSpace();
  farmLog(bot, 'BANK', () => `stowing (${cap - free}/${cap} slots used)`, log);
  return true;
}

/** Close the depot and clear the trip state so the next one starts clean. */
export function endBanking(bot, log) {
  if (bot.run.depotOpen) bot.send({ type: 'closeDepot' });
  const [free, cap] = bot.packSpace();
  log?.(`banking done -- ${free}/${cap} slots free`);
  bot.run.banking = false;
  bot.run.depotOpen = false;
  bot.run.bankBox = null;
  bot.run.bankSince = null;
  bot.run.bankOpenSent = null;
  bot.run.bankWarnedSlow = false;
  bot.run.bankNudged = false;
  // Per-trip, not per-run: an item refused because the box was out of reach
  // deserves a fresh chance on the next trip, from the right tile.
  bot.run.bankTries = null;
  bot.run.bankSkip = null;
  bot.depot = null;
}
