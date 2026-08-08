// The farm loop: an indefinite kill -> loot -> cook/eat -> stay-alive machine.
// Port of avalon.py's make_farm and its helpers.
//
// Every non-obvious rule here was paid for with a dead bot on the Python side.
// The comments explaining WHY are carried over verbatim in spirit, because they
// are the difference between this working for hours and dying with a full bag.

import { TILE, MELEE_RANGE_PX } from './protocol.js';
import * as nav from './nav.js';
// depot.js imports back from here (distPx / navStep / farmLog). That cycle is
// fine and deliberate: both sides export only hoisted function declarations, so
// whichever module the loader starts with, the other's bindings are live by the
// time any of this runs. Keeping the bank logic in its own file is worth it --
// it is the one behaviour with a table of world coordinates in it.
import { shouldBank, bankStep } from './depot.js';

const now = () => performance.now() / 1000;

/**
 * Read a throttle timestamp, treating "never" as infinitely long ago.
 *
 * Python's time.monotonic() returns system uptime -- a big number -- so
 * `now() - 0` always cleared the throttle on the first call. performance.now()
 * starts at ~0 instead, so the same `|| 0` default would suppress every FIRST
 * action (respawn, the first meal, the first pickup) until the page had been
 * open as long as the throttle. Explicit -Infinity keeps the intent.
 */
const since = (bot, key) => now() - (bot.run[key] ?? -Infinity);

// ---- shared geometry / helpers -------------------------------------------

export const distPx = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

export const meOf = (bot, snap) =>
  snap.players.find((p) => p.id === bot.me) || null;

const normName = (s) => (s || '').toLowerCase().replace(/_/g, ' ').trim();

/** Forgiving name match: 'sam', 'sam_altman' and 'Sam Altman' all resolve. */
export function nameMatches(query, name) {
  const q = normName(query); const n = normName(name);
  return n === q || (!!n && n.split(' ')[0] === q) || (!!q && n.includes(q));
}

export const stepToward = (me, tx, ty) =>
  [Math.sign(tx - me.x), Math.sign(ty - me.y)];

/** Tiles occupied by OTHER players -- dynamic obstacles A* must route around. */
function occupiedTiles(snap, me) {
  const s = new Set();
  for (const p of snap.players) {
    if (p.id === me.id) continue;
    s.add(nav.tileKey(nav.tileOf(p.x), nav.tileOf(p.y)));
  }
  return s;
}

/**
 * Dynamic obstacles for this tick: other players, plus any hole we must not
 * fall down.
 *
 * The holes are the important half. A 'walk' teleport fires on contact, so
 * routing a chase across one drops the bot a floor without any decision being
 * made -- it just arrives somewhere else, mid-fight, with the wrong prey list.
 * Treating them as walls means A* goes around, and the only way down is the
 * deliberate one in descendStep.
 *
 * `wantDepth` is where we are TRYING to be: when that is below us the holes are
 * the route, not a hazard, so they stay open.
 */
export function setNavObstacles(bot, snap, me, wantDepth = 0) {
  const occupied = occupiedTiles(snap, me);
  const z = bot.z ?? 0;
  if (wantDepth >= z) {
    for (const k of nav.trapdoorTiles(z)) occupied.add(k);
  }
  bot.run.occupied = occupied;
}

/** Step toward a pixel target using A* over the collision grid. */
export function navStep(bot, me, tx, ty) {
  return nav.pathStep(bot, me, bot.z ?? 0, [tx, ty], bot.run.occupied);
}

/**
 * The element nearest `anchor`, or null. Equivalent to Python's
 * `min(xs, key=...)`: each candidate's distance is computed ONCE. Writing this
 * as a reduce that compares `dist(best)` inline costs two hypots per element,
 * and these scans run over every monster on screen at 10 Hz.
 */
export function nearestTo(xs, anchor) {
  let best = null; let bestD = Infinity;
  for (const x of xs) {
    const d = distPx(x.x, x.y, anchor.x, anchor.y);
    if (d < bestD) { bestD = d; best = x; }
  }
  return best;
}

export function nearestHuntable(snap, anchor, huntTypes) {
  let best = null; let bestD = Infinity;
  for (const m of snap.monsters) {
    if (m.hp <= 0) continue;
    if (huntTypes && !huntTypes.includes(m.monsterType)) continue;
    const d = distPx(m.x, m.y, anchor.x, anchor.y);
    if (d < bestD) { bestD = d; best = m; }
  }
  return best;
}

// HP-restoring potions, smallest first (bundle: healthPotion 30, large 60).
export const HEAL_POTIONS = [['healthPotion', 30], ['largeHealthPotion', 60]];
const HEALER_NAMES = new Set(['brother aldric', 'aldric']);
const POTION_COOLDOWN_S = 0.8;
const TELEPORT_INTERACT_PX = TILE * 1.5;

export function findNpc(snap, query = null) {
  for (const n of snap.npcs) {
    const name = n.name || ''; const kind = n.npcType || '';
    if (query) {
      if (nameMatches(query, name) || nameMatches(query, kind)) return n;
    } else if (HEALER_NAMES.has(name.toLowerCase())
               || HEALER_NAMES.has(kind.toLowerCase())) {
      return n;
    }
  }
  return null;
}

/**
 * The smallest held potion whose heal wouldn't mostly overheal, or null. The
 * `missing >= amt/2` rule stops us burning a 60-point potion on a 5-point graze.
 */
export function usefulPotion(bot, me) {
  const missing = me.maxHp - me.hp;
  for (const [pid, amt] of HEAL_POTIONS) {
    const it = bot.findItem(pid);
    if (it && missing >= amt * 0.5) return [it, amt];
  }
  return null;
}

export function drinkPotion(bot, me, log) {
  if (since(bot, 'healLastDrink') < POTION_COOLDOWN_S) return false;
  const t = now();
  const found = usefulPotion(bot, me);
  if (!found) return false;
  const [potion, amt] = found;
  bot.run.healLastDrink = t;
  log?.(`drinking ${potion.itemId} (+${amt}, x${bot.countItem(potion.itemId)} held)`);
  bot.useItem(potion.instanceId);
  return true;
}

/**
 * Dead bots can't fight. Respawn (throttled) and skip the tick.
 *
 * Swarm bots WILL die (especially to underground monsters), so they need to get
 * back up on their own -- a corpse can't fight or follow.
 */
export function respawnIfDead(bot, me, log) {
  if (me.hp > 0) return false;
  if (since(bot, 'respawnLast') > 2.0) {
    bot.run.respawnLast = now();
    bot.send({ type: 'respawn' });
    log?.('dead -- respawning');
  }
  return true;
}

// ---- food / loot tables ---------------------------------------------------

// Food, best-first. We eat the WORST food that still does the job so the good
// stuff is kept for when it matters. cookedMeat (480s) is worth more than double
// rawMeat (180s), which is why we cook before eating.
const FOOD_ITEMS = [
  ['cookedMeat', 480], ['fish', 1200], ['cheese', 240],
  ['apple', 120], ['avocado', 120], ['iceCream', 120], ['rawMeat', 180],
];
const FOOD_SECONDS = new Map(FOOD_ITEMS);
const COOKABLE = ['rawMeat'];

const LOOT_REACH_PX = TILE * 1.2;
const LOOT_TIMEOUT_S = 6.0;

// A killed monster leaves a `corpse` whose *contents* are the actual drops. The
// container itself weighs 0 and equips nowhere -- taking it does nothing.
const LOOT_CONTAINERS = new Set(['corpse', 'playerBody']);

// Items the server keeps as counted stacks.
const STACKABLE_IDS = new Set([
  'gold', 'rawMeat', 'cookedMeat', 'cheese', 'apple', 'fish', 'avocado',
  'healthPotion', 'largeHealthPotion', 'manaPotion', 'largeManaPotion',
  'emberOre', 'iceCream',
]);

/**
 * Every takeable thing on the floor, as [groundEntry, itemToTake].
 *
 * Two shapes exist and this is the whole reason looting looked broken: a loose
 * drop is taken directly, but a monster's drops sit INSIDE a corpse container,
 * so we yield its contents instead of the corpse itself. Items reserved for
 * someone else (ownerId) are skipped rather than burning ticks on a refusal.
 */
export function* lootCandidates(bot, snap) {
  const skip = bot.run.farmLootSkip || new Set();
  for (const g of snap.groundItems || []) {
    if (g.ownerId && g.ownerId !== bot.me) continue;
    const it = g.item;
    if (LOOT_CONTAINERS.has(it.itemId) || it.contents) {
      for (const inner of it.contents || []) {
        if (inner && !skip.has(inner.instanceId)) yield [g, inner];
      }
    } else if (!skip.has(it.instanceId)) {
      yield [g, it];
    }
  }
}

/**
 * The nearest takeable [groundEntry, item], with the distance we already
 * computed, or null.
 *
 * The distance comes back with the result because this walks every ground entry
 * AND every corpse's contents -- on a busy field that's the tick's biggest scan,
 * and the callers all want both answers. Returning only the winner meant the
 * caller re-derived the distance and, worse, ran the whole scan a second time.
 */
function nearestLoot(bot, snap, me) {
  let best = null; let bestD = Infinity;
  for (const c of lootCandidates(bot, snap)) {
    const d = distPx(c[0].x, c[0].y, me.x, me.y);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best && { where: best[0], item: best[1], dist: bestD };
}

/**
 * What to eat. Normally the SHORTEST-lasting food we hold, so the good stuff is
 * saved (any food restores regen equally -- only the wellFed duration differs).
 * In an emergency the LONGEST, so we don't break off mid-retreat to eat again.
 */
export function pickFood(bot, emergency = false) {
  const held = new Map();
  for (const it of bot.iterItems()) {
    const secs = FOOD_SECONDS.get(it.itemId);
    if (secs !== undefined && !held.has(it.itemId)) held.set(it.itemId, [secs, it]);
  }
  if (!held.size) return null;
  let best = null;
  for (const [secs, it] of held.values()) {
    if (!best || (emergency ? secs > best[0] : secs < best[0])) best = [secs, it];
  }
  return best[1];
}

function stackable(itemId, group) {
  if (STACKABLE_IDS.has(itemId)) return true;
  // Learned at runtime: the server itself is holding >1 in a slot.
  return group.some(([, it]) => (it.quantity || 1) > 1);
}

/**
 * Two stacks of the same item that should be one, as [src, dstWithLocation].
 * Merging frees slots, which is the point: a backpack fills with split stacks
 * long before it fills with distinct items.
 */
function findMerge(bot) {
  const pack = bot.backpack();
  if (!pack) return null;
  const contents = pack.contents || [];
  const byId = new Map();
  contents.forEach((it, slot) => {
    if (!it || it.contents != null) return;  // empty, or a nested container
    if (!byId.has(it.itemId)) byId.set(it.itemId, []);
    byId.get(it.itemId).push([slot, it]);
  });
  for (const [itemId, group] of byId) {
    if (group.length < 2 || !stackable(itemId, group)) continue;
    // Pour the smallest stack into the largest: fewest moves to empty a slot.
    group.sort((a, b) => (a[1].quantity || 1) - (b[1].quantity || 1));
    const [srcSlot, src] = group[0];
    const [dstSlot, dst] = group[group.length - 1];
    if (srcSlot === dstSlot) continue;
    return [src, { ...dst, _container: pack.instanceId, _slot: dstSlot }];
  }
  return null;
}

// ---- config ---------------------------------------------------------------

export class FarmConfig {
  constructor(o = {}) {
    this.loot = o.loot ?? true;
    this.eat = o.eat ?? true;
    this.cook = o.cook ?? true;
    this.stack = o.stack ?? true;
    this.huntTypes = o.huntTypes ?? null;
    this.retreatFrac = o.retreatFrac ?? 0.35;
    this.resumeFrac = o.resumeFrac ?? 0.85;
    this.healToFrac = o.healToFrac ?? 0.95;
    this.healerName = o.healerName ?? null;
    this.roamPx = o.roamPx ?? TILE * 12;
    this.untilHpFrac = o.untilHpFrac ?? null;
    // Loot this close is collected before chasing the next monster.
    this.lootPx = o.lootPx ?? TILE * 8;
    this.depth = o.depth ?? 0;
    this.entryTile = o.entryTile ?? null;
    // Bank at the depot when the pack fills, instead of leaving drops behind.
    this.bank = o.bank ?? true;
    // Leave for the bank with this many slots still free -- see shouldBank.
    this.bankFreeSlots = o.bankFreeSlots ?? 1;
  }
}

// ---- steps ----------------------------------------------------------------

/** Cook raw meat, then consolidate stacks. Returns true if we sent something. */
function cookAndStack(bot, cfg, log) {
  if (since(bot, 'farmLastInv') < 0.6) return false;
  const t = now();

  if (cfg.cook) {
    for (const raw of COOKABLE) {
      const it = bot.findItem(raw);
      if (it) {
        bot.run.farmLastInv = t;
        log?.(`cooking ${raw} x${it.quantity || 1}`);
        bot.useItem(it.instanceId);
        return true;
      }
    }
  }
  if (cfg.stack) {
    const merge = findMerge(bot);
    if (merge) {
      const [src, dst] = merge;
      bot.run.farmLastInv = t;
      log?.(`stacking ${src.itemId} x${src.quantity || 1} onto x${dst.quantity || 1}`);
      bot.moveItem(src.instanceId, {
        kind: 'container',
        containerInstanceId: dst._container,
        slotIndex: dst._slot,
      });
      return true;
    }
  }
  return false;
}

/**
 * Stop trying to pick `instanceId` up, for the rest of this run.
 *
 * The ban list is pruned to items still on the floor on every insert: a
 * multi-hour run otherwise accumulates thousands of despawned ids and tests
 * every one of them on every tick.
 */
export function banLoot(bot, snap, instanceId) {
  const onFloor = new Set();
  for (const [, i] of lootCandidates(bot, snap)) onFloor.add(i.instanceId);
  const skip = new Set();
  for (const id of bot.run.farmLootSkip || []) if (onFloor.has(id)) skip.add(id);
  skip.add(instanceId);
  bot.run.farmLootSkip = skip;
  bot.run.farmChase = null;
}

/**
 * Answer a server refusal ("that is too heavy to carry") by banning the item we
 * just asked for.
 *
 * The proactive `overloaded()` check in lootStep stops most of these, but it
 * cannot stop all of them: it knows our total weight, not what the next item
 * weighs, so an item heavier than our remaining headroom still gets requested
 * once. Without this handler that single item is retried forever -- the exact
 * loop that pinned Dario to a corpse. Wired into onJson like handleDialogue,
 * because refusals arrive as JSON and the farm loop only sees snapshots.
 */
export function handleLootRefusal(bot, msg, log) {
  if (msg?.type !== 'statusMessage') return false;
  // Match on the failure, not on an exact string: the server's wording is not
  // ours to depend on, but "heavy"/"carry"/"capacity" all mean the same refusal.
  if (!/heav|carry|capacit|overload/i.test(msg.text || '')) return false;
  const pending = bot.run.farmPendingLoot;
  if (!pending) return false;
  banLoot(bot, bot.state || { groundItems: bot.groundItems }, pending.instanceId);
  bot.run.farmPendingLoot = null;
  log?.(`server refused ${pending.itemId} (${msg.text}) -- skipping it`);
  return true;
}

/**
 * Walk to the nearest drop and take it. True if busy looting this tick.
 *
 * `found` is the already-scanned nearestLoot result when the caller has one --
 * the ground scan is the tick's most expensive walk and must not run twice.
 */
function lootStep(bot, snap, me, log, found = undefined) {
  if (found === undefined) found = nearestLoot(bot, snap, me);
  if (!found) { bot.run.farmChase = null; return false; }
  const { where, item: it } = found;

  const [free, cap] = bot.packSpace();
  if (cap && free === 0) {
    if (!bot.run.farmWarnedFull) {
      bot.run.farmWarnedFull = true;
      log?.(`!! BACKPACK FULL (${cap}/${cap} slots) -- leaving loot on the ground.`);
    }
    return false;
  }
  bot.run.farmWarnedFull = false;

  // Weight, not just slots. The server refuses a pickup that would overload us
  // even with slots to spare, and the refusal costs nothing to send -- so a bot
  // that only counted slots stood on a corpse re-requesting the same item at
  // 2.5 Hz forever. Stop before asking.
  if (bot.overloaded()) {
    if (!bot.run.farmWarnedHeavy) {
      bot.run.farmWarnedHeavy = true;
      const [carried, capOz] = bot.weight();
      log?.(`!! OVERLOADED (${Math.round(carried)}/${Math.round(capOz)} oz) -- `
        + 'cannot pick anything up.');
    }
    return false;
  }
  bot.run.farmWarnedHeavy = false;

  // Track how long we've chased this one so an unreachable drop can't stall the
  // loop forever. Keyed on the ITEM: several items can share one corpse.
  const [chased, chaseStart] = bot.run.farmChase || [null, 0];
  if (chased !== it.instanceId) {
    bot.run.farmChase = [it.instanceId, now()];
  } else if (now() - chaseStart > LOOT_TIMEOUT_S) {
    banLoot(bot, snap, it.instanceId);
    log?.(`giving up on ${it.itemId} (unreachable)`);
    return false;
  }

  if (distPx(me.x, me.y, where.x, where.y) > LOOT_REACH_PX) {
    bot.move(...navStep(bot, me, where.x, where.y));
    return true;
  }
  bot.move(0, 0);
  if (since(bot, 'farmLastPickup') >= 0.4) {
    bot.run.farmLastPickup = now();
    const src = LOOT_CONTAINERS.has(where.item.itemId) ? ' (corpse)' : '';
    log?.(`looting ${it.itemId} x${it.quantity || 1}${src}`);
    // Remember what we asked for, so a refusal can be blamed on the right item.
    bot.run.farmPendingLoot = { instanceId: it.instanceId, itemId: it.itemId };
    bot.takeItem(it);
  }
  return true;
}

/**
 * Eat if we're not wellFed. Not a nicety: the server only regenerates HP while
 * wellFed is up, so an unfed bot never heals between fights and death-spirals.
 */
function eatStep(bot, me, cfg, log) {
  // Cheapest guards first: the throttle is a subtraction, hasStatus scans the
  // status list, and this runs on every tick at 10 Hz.
  if (!cfg.eat) return false;
  if (since(bot, 'farmLastEat') < 1.5) return false;
  if (bot.hasStatus('wellFed')) return false;
  const t = now();
  const hurt = me.hp < me.maxHp * cfg.resumeFrac;
  const food = pickFood(bot, hurt);
  if (!food) {
    if (!bot.run.farmWarnedFood) {
      bot.run.farmWarnedFood = true;
      log?.('!! OUT OF FOOD -- not wellFed, so HP will NOT regenerate.');
    }
    return false;
  }
  bot.run.farmWarnedFood = false;
  bot.run.farmLastEat = t;
  log?.(`eating ${food.itemId} (x${bot.countItem(food.itemId)} held) -- restoring regen`);
  bot.useItem(food.instanceId);
  return true;
}

/**
 * Move onto / interact with a teleport marker. True once triggered.
 *
 * The two modes differ in how you trigger them, which is why this is shared with
 * the swarm: a 'walk' hole transitions you the moment you stand on the tile (no
 * message at all), while an 'interact' ladder needs you within ~1.5 tiles and
 * then an explicit useTeleport.
 */
export function takeTeleport(bot, me, tp) {
  const [ftx, fty] = tp.fromTile;
  const goal = [ftx * TILE, fty * TILE];
  if (tp.mode === 'walk') {
    // A hole transitions you the moment you stand on it -- no message at all.
    bot.move(...navStep(bot, me, goal[0], goal[1]));
    return false;
  }
  if (distPx(me.x, me.y, goal[0], goal[1]) <= TELEPORT_INTERACT_PX) {
    bot.move(0, 0);
    bot.useTeleport();
    return true;
  }
  bot.move(...navStep(bot, me, goal[0], goal[1]));
  return false;
}

/** Walk to the next hole down until we're on cfg.depth. True while travelling. */
function descendStep(bot, me, cfg, log) {
  const z = bot.z ?? 0;
  if (z <= cfg.depth) return false;
  const tile = [nav.tileOf(me.x), nav.tileOf(me.y)];
  let tp = null;
  if (z === 0 && cfg.entryTile) {
    tp = nav.teleports(0).find(
      (t) => t.fromTile[0] === cfg.entryTile[0] && t.fromTile[1] === cfg.entryTile[1]) || null;
  }
  if (!tp) tp = nav.nearestTeleport(z, z - 1, tile);
  if (!tp) {
    if (!bot.run.farmNoWayDown) {
      bot.run.farmNoWayDown = true;
      log?.(`!! no way down from z${z} -- farming here instead`);
    }
    return false;
  }
  farmLog(bot, 'DESCEND', () => `z${z} -> z${z - 1} via ${tp.mode} @${tp.fromTile}`, log);
  takeTeleport(bot, me, tp);
  return true;
}

/**
 * Climb back to the floor we are supposed to be farming. True while travelling.
 *
 * Distinct from escapeStep, which is a panic button tied to low HP. This is the
 * navigation fix for being somewhere we never chose to be: it fires at full
 * health, because the problem is not danger but the fact that everything the
 * loop wants -- the prey, the depot, the healer -- is on another floor.
 *
 * Note it climbs one floor per call, re-entering on the next tick from wherever
 * the ladder put us. A fall is usually one floor, but a bot that somehow got
 * several down still walks all the way back up.
 */
function climbStep(bot, me, cfg, log) {
  const z = bot.z ?? 0;
  const tile = [nav.tileOf(me.x), nav.tileOf(me.y)];
  const up = nav.nearestUpwardTeleport(z, tile);
  if (!up) {
    if (!bot.run.farmNoWayUp) {
      bot.run.farmNoWayUp = true;
      log?.(`!! stuck on z${z} with no way up -- farming here instead`);
    }
    return false;
  }
  bot.run.farmNoWayUp = false;
  farmLog(bot, 'CLIMB',
    () => `wrong floor (z${z}, want z${cfg.depth}) -- up via ${up.mode} @${up.fromTile}`,
    log);
  takeTeleport(bot, me, up);
  return true;
}

/**
 * Flee UP one floor. On every underground floor the up-ladder sits on the same
 * tile as the hole we came down, so the exit is exactly where we landed.
 */
function escapeStep(bot, me, log) {
  const z = bot.z ?? 0;
  if (z >= 0) return false;
  const tile = [nav.tileOf(me.x), nav.tileOf(me.y)];
  const up = nav.nearestUpwardTeleport(z, tile);
  if (!up) return false;
  farmLog(bot, 'ESCAPE',
    () => `hurt on z${z} -- climbing to z${up.toZ} @${up.fromTile}`, log);
  takeTeleport(bot, me, up);
  return true;
}

/**
 * True if backing off would actually get us out of trouble.
 *
 * Running from something already swinging at you is strictly worse than killing
 * it: you eat free hits, deal none, and regen is suppressed in combat anyway.
 * This is what killed Sam on the first live run -- at 23% HP he walked away from
 * a rat that hits for 1, taking a free hit every tick for 20 tiles until he died
 * with a bag full of unused apples.
 */
export function canDisengage(me, snap, engagedPx = TILE * 3) {
  return !snap.monsters.some(
    (m) => m.hp > 0 && distPx(m.x, m.y, me.x, me.y) <= engagedPx);
}

/** Back away toward safety -- to the healer if we know one, else away from prey. */
function retreatStep(bot, me, snap, cfg) {
  if (cfg.healerName) {
    const healer = findNpc(snap, cfg.healerName);
    if (healer) {
      if (distPx(me.x, me.y, healer.x, healer.y) > TILE * 1.5) {
        return [navStep(bot, me, healer.x, healer.y), healer];
      }
      return [[0, 0], healer];
    }
  }
  const near = nearestTo(snap.monsters.filter((m) => m.hp > 0), me);
  if (!near) return [[0, 0], null];
  const [dx, dy] = stepToward(me, near.x, near.y);
  return [[-dx, -dy], null];
}

function healAt(bot, me, healer, cfg, log) {
  if (me.hp >= me.maxHp * cfg.healToFrac) return;
  if (drinkPotion(bot, me, log)) return;
  if (since(bot, 'farmLastTalk') >= 3.0) {
    bot.run.farmLastTalk = now();
    log?.(`asking ${healer.name} for a heal (${me.hp}/${me.maxHp})`);
    // Opening the dialogue is only half of it: the heal itself is a dialogue
    // OPTION, and its id is dynamic, so we note who we're talking to and let
    // handleDialogue pick the option when the reply arrives.
    bot.run.healNpc = healer.id;
    bot.talkTo(healer.id);
  }
}

/**
 * Answer a healer's dialogue by choosing the heal option.
 *
 * Wired into bot.onJson rather than the snapshot tick because dialogue arrives
 * as JSON, and the farm loop only ever sees binary snapshots. Without this the
 * bot opens the dialogue and stands there: `talkTo` alone heals nobody, so a
 * retreating bot would wait at the healer until something killed it.
 */
export function handleDialogue(bot, msg, log) {
  if (msg?.type !== 'dialogue') return false;
  if (!bot.run.healNpc || msg.npcId !== bot.run.healNpc) return false;
  const opts = msg.options || [];
  const heal = opts.find((o) => /heal|cure/i.test(`${o.label || ''}${o.id || ''}`));
  if (heal) {
    log?.(`picking dialogue option: ${heal.label}`);
    bot.talkTo(bot.run.healNpc, heal.id);
  } else {
    log?.(`no heal option; saw: ${opts.map((o) => o.label).join(', ')}`);
  }
  // Close the dialogue so the next retreat can re-open it. Leaving it open
  // means the following talkTo is swallowed and healing stops working.
  bot.send({ type: 'endDialogue' });
  bot.run.healNpc = null;
  return true;
}

/** No prey visible: drift so spawns come back into view. */
function roamStep(bot, me, cfg, log) {
  const t = now();
  let goal = bot.run.farmRoamGoal;
  if (!goal || since(bot, 'farmRoamSince') > 20.0
      || distPx(me.x, me.y, goal[0], goal[1]) <= TILE * 1.5) {
    const ang = Math.random() * 2 * Math.PI;
    const r = cfg.roamPx * (0.4 + Math.random() * 0.6);
    goal = [me.x + Math.cos(ang) * r, me.y + Math.sin(ang) * r];
    bot.run.farmRoamGoal = goal;
    bot.run.farmRoamSince = t;
  }
  farmLog(bot, 'ROAM', () => '(no prey in sight)', log);
  bot.move(...navStep(bot, me, goal[0], goal[1]));
}

/**
 * Heartbeat: farming runs for hours, so print on a timer rather than at 10 Hz.
 * Always prints when the state changes. `detail` is a callable so the ~98% of
 * throttled ticks cost no string formatting.
 */
export function farmLog(bot, state, detail, log, period = 5.0) {
  const t = now();
  const changed = state !== bot.run.farmState;
  if (!(changed || since(bot, 'farmLastLog') >= period)) return;
  bot.run.farmState = state;
  bot.run.farmLastLog = t;
  const d = detail ? detail() : '';
  log?.(`[${state}]${d ? ' ' + d : ''}`, state);
}

// ---- the machine ----------------------------------------------------------

/**
 * Farm indefinitely: kill -> loot -> cook/stack -> eat -> stay alive.
 *
 *   FIGHT    kill the nearest huntable monster
 *   LOOT     nothing hostile in reach -> sweep up the drops
 *   KEEP     no monsters, no loot -> cook, merge stacks, eat
 *   RETREAT  HP below retreatFrac -> disengage toward the healer
 *   HEAL     at the healer -> potion/dialogue back up to healToFrac
 *
 * RETREAT/FIGHT is hysteretic (retreatFrac vs resumeFrac) so a bot hovering at
 * the threshold doesn't oscillate between fleeing and swinging.
 */
export function makeFarm(cfg, log) {
  return function tick(bot, snap) {
    const me = meOf(bot, snap);
    if (!me) return;
    setNavObstacles(bot, snap, me, cfg.depth);

    if (respawnIfDead(bot, me, log)) return;

    // --- we are on the wrong floor ---------------------------------------
    // Falling down a hole used to be unrecoverable: descendStep only runs when
    // cfg.depth < 0, so a SURFACE bot that stepped on a hole while chasing a rat
    // simply carried on farming at z=-1 -- where there are no rats, so it never
    // fought, just looped looting while cave bats chewed on it. Climbing back is
    // now the first thing we do, ahead of everything except respawning.
    if ((bot.z ?? 0) < cfg.depth && climbStep(bot, me, cfg, log)) return;

    const frac = me.hp / Math.max(1, me.maxHp);

    if (cfg.untilHpFrac != null && frac <= cfg.untilHpFrac) {
      bot.move(0, 0);
      log?.(`reached ${me.hp}/${me.maxHp} (${(frac * 100) | 0}%) -- stopping`);
      bot.done = true;
      return;
    }

    // --- upkeep: eat FIRST, in every state ------------------------------
    // wellFed is the only thing that makes HP regenerate, so this has to happen
    // while fighting too. It sat in the idle branch once and never ran -- on a
    // field that always has a rat in view the fight branch returned first, so he
    // starved and bled out with a full bag of apples.
    eatStep(bot, me, cfg, log);
    // Same reasoning for cooking/stacking: pure inventory moves that don't need
    // us to stand still. Both are throttled internally.
    cookAndStack(bot, cfg, log);

    // --- retreat / resume hysteresis ------------------------------------
    if (frac <= cfg.retreatFrac) bot.fleeing = true;
    else if (frac >= cfg.resumeFrac) bot.fleeing = false;

    if (bot.fleeing) {
      // Underground the ladder is a real exit -- taking it ends the fight
      // outright -- so it beats the canDisengage rule below: climb out even with
      // a bat on us, rather than trading blows on a floor with no healer.
      if (escapeStep(bot, me, log)) return;
    }

    // On the surface, fleeing only helps if we can actually break away; with
    // something in our face, killing it is safer than feeding it free hits.
    if (bot.fleeing && canDisengage(me, snap)) {
      const [[dx, dy], healer] = retreatStep(bot, me, snap, cfg);
      const atHealer = !!healer && dx === 0 && dy === 0;
      farmLog(bot, 'RETREAT',
        () => `hp=${me.hp}/${me.maxHp} (${(frac * 100) | 0}%)${atHealer ? ' at healer' : ''}`,
        log);
      bot.move(dx, dy);
      if (atHealer) healAt(bot, me, healer, cfg, log);
      return;
    }

    // --- bank a full pack -------------------------------------------------
    // Below retreat/heal (a dead bot banks nothing) but above fighting: once the
    // pack is full, every further kill drops loot we cannot pick up, so carrying
    // on is strictly worse than the walk to the depot. Latched, because the trip
    // has to survive the rats we pass on the way -- without the latch the first
    // rat in view would pull us back into FIGHT one tile from the box.
    if (!bot.run.banking && shouldBank(bot, cfg)) {
      bot.run.banking = true;
      const [free, cap] = bot.packSpace();
      log?.(`pack ${cap - free}/${cap} -- heading to the depot`);
    }
    if (bot.run.banking && bankStep(bot, snap, me, cfg, log)) return;

    // --- travel to the target floor, only when healthy -------------------
    if (cfg.depth < 0 && descendStep(bot, me, cfg, log)) return;

    // --- grab loot at our feet before moving on --------------------------
    // Loot used to sit behind the fight branch, so on a field that always has
    // another rat in view he never stopped to collect and left every corpse
    // behind. A monster already in melee still comes first.
    const m = nearestHuntable(snap, me, cfg.huntTypes);
    const engaged = m && distPx(m.x, m.y, me.x, me.y) < MELEE_RANGE_PX;
    // One ground scan for the whole tick, reused by both loot branches below.
    const loot = cfg.loot ? nearestLoot(bot, snap, me) : null;
    if (loot && !engaged && loot.dist <= cfg.lootPx) {
      if (lootStep(bot, snap, me, log, loot)) {
        farmLog(bot, 'LOOT', null, log);
        return;
      }
    }

    // --- fight -----------------------------------------------------------
    if (m) {
      const d = distPx(m.x, m.y, me.x, me.y);
      if (d < MELEE_RANGE_PX) {
        bot.move(0, 0);
        bot.attack(m.id);
        // FIGHT and CHASE are one state for logging: closing the last few px
        // flips between them several times a second.
        farmLog(bot, 'FIGHT',
          () => `${m.monsterType} ${m.hp}/${m.maxHp} hp=${me.hp}`, log);
      } else {
        bot.move(...navStep(bot, me, m.x, m.y));
        farmLog(bot, 'FIGHT',
          () => `chasing ${m.monsterType} ${(d / TILE).toFixed(1)} tiles`, log);
      }
      return;
    }

    // --- nothing to fight: sweep up the rest of the loot ------------------
    if (cfg.loot && lootStep(bot, snap, me, log, loot)) {
      farmLog(bot, 'LOOT', null, log);
      return;
    }

    roamStep(bot, me, cfg, log);
  };
}
