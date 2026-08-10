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
import { shouldBank, bankStep, endBanking, DEPOT_Z } from './depot.js';

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

/**
 * The nearest live monster we are willing to hunt.
 *
 * `claimed` (from claimedMonsters) demotes rather than hides: an unclaimed
 * monster always wins, but a claimed one is still returned when it is all there
 * is, so the caller can decide. The farm loop chooses to walk away; the caller
 * needs to be able to tell the difference, hence the demotion instead of a
 * filter.
 */
export function nearestHuntable(snap, anchor, huntTypes, claimed = null,
                                reachable = null) {
  let best = null; let bestD = Infinity;
  let fallback = null; let fallbackD = Infinity;
  for (const m of snap.monsters) {
    if (m.hp <= 0) continue;
    if (huntTypes && !huntTypes.includes(m.monsterType)) continue;
    const d = distPx(m.x, m.y, anchor.x, anchor.y);
    // Demoted, not hidden -- same rule as `claimed`, and for the same reason:
    // when a walled-off monster is all there is, the caller still needs to see
    // it (self-defense and the log both care), so this only decides ORDER.
    if ((claimed && claimed.has(m.id)) || (reachable && !reachable(m))) {
      if (d < fallbackD) { fallbackD = d; fallback = m; }
      continue;
    }
    if (d < bestD) { bestD = d; best = m; }
  }
  return best || fallback;
}

// How far a monster can be before we bother checking whether it is REACHABLE.
//
// Prey selection is nearest-by-pixel, and pixels go through walls. The orc caves
// are not one open room: z=-2 has a 154-tile pocket whose walls put nearby orcs
// in a different connected region entirely, and z=-1 has the same shape at
// 63,95. Locking onto one of those means A* returns no path, the chase falls
// through to pathStep's nudge, and safeStep vetoes every direction because the
// wall is exactly the thing in the way -- so the bot stands still, indefinitely,
// swinging at nothing. Measured: 0 movement in 300 consecutive ticks.
//
// Anything already at melee range is skipped: it is either genuinely on us or a
// corner standoff, which meleeStandoff/sidestep already handle, and an A* run
// per tick per neighbour is not worth paying to re-learn that.
export const REACH_CHECK_PX = MELEE_RANGE_PX;

/**
 * A predicate answering "can we actually walk to this monster?", cached for the
 * tick.
 *
 * A* per candidate is the honest test and the only one that knows about the
 * disconnected pockets, but it is also the expensive one, so the result is
 * memoised per monster id -- prey selection and the fight branch ask about the
 * same monsters within a tick.
 */
export function reachChecker(bot, me) {
  const z = bot.z ?? 0;
  const blocked = bot.run.occupied || new Set();
  const from = [nav.tileOf(me.x), nav.tileOf(me.y)];
  const memo = new Map();
  return (m) => {
    if (distPx(m.x, m.y, me.x, me.y) < REACH_CHECK_PX) return true;
    // A monster landing blows on us is reachable, whatever the grid says, and
    // the combat event is harder evidence than A* over a map extracted from the
    // client bundle. Skipping this check is what stops the fix from inventing a
    // new freeze: filtering out the thing actively eating us would leave the bot
    // roaming away from a fight it is already in.
    if (bot.isAttacking(m.id)) return true;
    const hit = memo.get(m.id);
    if (hit !== undefined) return hit;
    const goal = [nav.tileOf(m.x), nav.tileOf(m.y)];
    // Same tile is trivially reachable -- findPath returns [] for it, which we
    // must not read as "walled off".
    const ok = (goal[0] === from[0] && goal[1] === from[1])
      || nav.findPath(z, from, goal, blocked).length > 0;
    memo.set(m.id, ok);
    return ok;
  };
}

// How far a monster that has hit us can be and still count as OUR fight.
//
// Wider than melee on purpose: it is a leash, not a reach test. The combat event
// already proved the monster is on us; this only stops it staying "ours" after
// we have genuinely left -- a monster that lost us and went home should not keep
// pulling the bot back for the rest of the memory window. Chases cover ground
// between snapshots, so a melee-tight bound here would flicker mid-fight.
export const ATTACKER_PX = TILE * 6;

/**
 * The monster currently fighting US, whatever its type -- or null.
 *
 * This is the multi-enemy-area fix. `huntTypes` governs what we SEEK OUT, not
 * what we fend off: hunting orcs in the bottom-left hole meant standing in a
 * room of cave bats being chewed on without ever swinging back, because the bats
 * failed the type filter and were invisible to prey selection. The bot took the
 * damage, retreated at retreatFrac, healed, walked back, and got chewed on
 * again -- an infinite loop that farms nothing.
 *
 * WHO is attacking us comes from combat events (bot.attackedBy), NOT from the
 * snapshot. The first version of this read the snapshot's `enraged` flag, on the
 * assumption -- inherited from swarm.js -- that the server sets it on a monster
 * in a fight. It does not. Measured live: an orc hit Dario ~100 times, 199 HP
 * down to 20, and `enraged` was false in every single snapshot. That version
 * passed every test and did nothing whatsoever in production, because the tests
 * fed it hand-written `enraged: true` monsters the real server never sends.
 *
 * Proximity is still required, but only as a sanity bound: it stops a monster we
 * have run away from staying "our attacker" for the memory window while we are
 * across the room. The event is what makes it ours; the distance only says it
 * still is.
 *
 * Deliberately NOT filtered by `claimed`. Courtesy is about not taking what is
 * someone else's; a monster hitting us is not a kill we are stealing, it is a
 * fight we are already in, and yielding it just means standing still while it
 * kills us.
 *
 * Lowest-HP-first among attackers: when two things are on us, the one nearest
 * death is the one that stops hitting us soonest.
 */
export function nearestAttacker(bot, snap, me, attackerPx = ATTACKER_PX) {
  let best = null;
  for (const m of snap.monsters) {
    if (m.hp <= 0) continue;
    if (!bot.isAttacking(m.id)) continue;
    if (distPx(m.x, m.y, me.x, me.y) > attackerPx) continue;
    if (!best || m.hp < best.hp) best = m;
  }
  return best;
}

// ---- courtesy: stay out of other players' way ------------------------------
//
// The bots share a live server with humans, and a bot that wanders into someone
// else's grind spot looks exactly like a griefer: it tags their mobs, it hoovers
// their drops, and it does so tirelessly. None of that is worth a single extra
// kill per hour, so the rule is prophylactic -- prefer empty ground, and when a
// contested target is the only option, take it only because there is no other.
//
// The radii are deliberately generous. Being wrong in the polite direction costs
// a few seconds of walking; being wrong the other way costs someone their spot.

// A monster this close to another player is treated as theirs.
const CLAIM_PX = TILE * 6;
// Loot this close to another player is theirs, full stop -- see lootIsContested.
const LOOT_CLAIM_PX = TILE * 5;
// Players within this of a roam goal make it a bad place to head for.
const CROWD_PX = TILE * 10;

/**
 * Players who are not us and not on our side.
 *
 * `cfg.allyNames` is how the swarm keeps its own escorts off this list: two of
 * our characters farming the same field are cooperating, not competing, and
 * treating a party member as a stranger would make the pack refuse to fight
 * anything at all.
 */
export function otherPlayers(bot, snap, cfg = null) {
  const allies = cfg?.allyNames || [];
  const out = [];
  for (const p of snap.players) {
    if (p.id === bot.me) continue;
    if (allies.some((a) => nameMatches(a, p.name))) continue;
    out.push(p);
  }
  return out;
}

/**
 * The ids of monsters that belong to somebody else: another player is within
 * CLAIM_PX of them, and is closer to them than we are.
 *
 * The "and is closer" half matters. Without it, a player walking past our fight
 * would un-claim nothing but would claim the rat we are already mid-swing on,
 * and we would drop the target and walk away from a half-killed monster --
 * wasting the damage and leaving them a mob they did not ask for.
 */
export function claimedMonsters(snap, me, others) {
  const claimed = new Set();
  if (!others.length) return claimed;
  for (const m of snap.monsters) {
    if (m.hp <= 0) continue;
    const mine = distPx(m.x, m.y, me.x, me.y);
    for (const p of others) {
      const theirs = distPx(m.x, m.y, p.x, p.y);
      if (theirs <= CLAIM_PX && theirs < mine) { claimed.add(m.id); break; }
    }
  }
  return claimed;
}

/**
 * True if this ground entry is close enough to another player to be their kill's
 * drop.
 *
 * Unlike monsters this has no "unless there is nothing else" escape hatch, and
 * no proximity comparison: loot stealing is the more offensive of the two, it is
 * irreversible, and the loot is not going anywhere. Leaving it is always fine.
 */
export function lootIsContested(where, others) {
  return others.some((p) => distPx(where.x, where.y, p.x, p.y) <= LOOT_CLAIM_PX);
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
function nearestLoot(bot, snap, me, others = null) {
  let best = null; let bestD = Infinity;
  for (const c of lootCandidates(bot, snap)) {
    if (others && others.length && lootIsContested(c[0], others)) continue;
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
    // Swing back at whatever is actually hitting us, even when it is not the
    // type we came to hunt. On by default: a hunt filter that also filters
    // self-defense means standing still while a bat eats you. See
    // nearestAttacker.
    this.defend = o.defend ?? true;
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
    // Travel to where the hunted monster actually lives, instead of roaming a
    // floor it does not spawn on. Off when `depth` was given explicitly -- that
    // is the caller naming a floor, and overriding it would ignore them.
    this.travel = o.travel ?? (o.depth == null);
    // Include nightOnly spawns (wraiths) when choosing a spot. They are not
    // there in daylight, so a wraith hunt is an empty room until you ask.
    this.night = o.night ?? false;
    // Bank at the depot when the pack fills, instead of leaving drops behind.
    this.bank = o.bank ?? true;
    // Leave for the bank with this many slots still free -- see shouldBank.
    this.bankFreeSlots = o.bankFreeSlots ?? 1;
    // Empty the pack down to the essentials on a bank trip, rather than stopping
    // at a weight/slot threshold. On by default: the old thresholds left the
    // heavy gear -- which is the whole haul -- in the bag. See bankDone.
    this.bankEmpty = o.bankEmpty ?? true;
    // Stay out of other players' way: don't tag their monsters, don't touch
    // their drops, drift toward free ground. On by default -- this is a shared
    // live server and looking like a griefer is not a tradeoff worth making.
    this.courtesy = o.courtesy ?? true;
    // Player names that are OURS, so the swarm doesn't treat its own escorts as
    // strangers to be avoided.
    this.allyNames = o.allyNames ?? [];
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
  // Prune against the RAW ground, not lootCandidates: that generator already
  // hides banned items, so pruning through it drops every ban we are trying to
  // keep. The list could then never hold more than the single most recent id --
  // and two heavy items ping-ponged forever, each ban un-banning the other.
  const onFloor = new Set();
  for (const g of snap.groundItems || []) {
    const it = g.item;
    if (!it) continue;
    onFloor.add(it.instanceId);
    // Corpse drops live one level down; a ban on one must survive too.
    for (const inner of it.contents || []) if (inner) onFloor.add(inner.instanceId);
  }
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

/**
 * Walk to the next hole down until we're on the target floor. True while
 * travelling.
 *
 * `wantTile` is where we are headed on the DESTINATION floor, and it changes
 * which hole to take: the floors are big (120x112) and their holes are far
 * apart, so descending by the nearest one can land us across the map from the
 * prey. When we know the goal we pick the hole whose landing tile is closest to
 * it, trading a longer walk up here for a much shorter one down there.
 */
function descendStep(bot, me, cfg, log, wantTile = null) {
  const z = bot.z ?? 0;
  const want = cfg.depth;
  if (z <= want) return false;
  const tile = [nav.tileOf(me.x), nav.tileOf(me.y)];
  let tp = null;
  if (z === 0 && cfg.entryTile) {
    tp = nav.teleports(0).find(
      (t) => t.fromTile[0] === cfg.entryTile[0] && t.fromTile[1] === cfg.entryTile[1]) || null;
  }
  // Only steer by the goal on the last hop, where "closest to the prey" is
  // meaningful. On an intermediate floor the landing tile says nothing about
  // where the NEXT hole is, so the nearest hole remains the right choice.
  if (!tp && wantTile && z - 1 === want) {
    tp = nav.bestTeleportToward(z, z - 1, tile, wantTile);
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

// Close enough to a hunting ground to call it arrived and start farming. Roughly
// a screen: the spot is the centre of a cluster of leashed spawns, so being
// inside this means the monsters are in view, not that we are on the exact tile.
const SPOT_ARRIVE_PX = TILE * 8;
// Re-pick the spot no more often than this. Choosing one is cheap, but switching
// targets mid-walk is not: two clusters of equal value would have us oscillate
// between them and never arrive.
const SPOT_REPICK_S = 30.0;

/**
 * Where we should be farming, as `{z, tile}` -- cached on `bot.run`.
 *
 * Resolved from the client's own spawn table (see nav.huntingGrounds), so it
 * needs no hand-written coordinates and cannot disagree with the world. Null when
 * we hunt anything (every floor has something) or when the hunted type has no
 * spawns at all, in which case there is nowhere better to be and roaming where we
 * are is the honest fallback.
 */
export function huntSpot(bot, cfg) {
  if (!cfg.travel || !cfg.huntTypes || !cfg.huntTypes.length) return null;
  const cached = bot.run.farmSpot;
  // Once chosen, a spot is KEPT. Re-ranking mid-run would hand back a different
  // cluster of equal value and walk us off a perfectly good field -- and since
  // huntingGrounds is a pure function of the static spawn table, a later call
  // cannot know anything the first one didn't. The recheck exists only to pick a
  // spot up once maps finish loading, so it stops as soon as we have one.
  if (cached) return cached;
  // No spot yet. Retry on a timer rather than every tick: the userscript starts
  // with the embedded fallback maps and swaps in the live ones a moment later, so
  // a lookup that found nothing at boot deserves another go -- but re-ranking 155
  // spawns at 10 Hz to keep learning "still nothing" does not.
  if (cached === null && since(bot, 'farmSpotAt') < SPOT_REPICK_S) return null;
  const grounds = nav.huntingGrounds(cfg.huntTypes, { night: cfg.night });
  const spot = grounds.length ? { z: grounds[0].z, tile: grounds[0].tile } : null;
  bot.run.farmSpot = spot;
  bot.run.farmSpotAt = now();
  return spot;
}

/**
 * Travel to the hunting ground: change floors if it is on another one, then walk
 * to it. True while still travelling.
 *
 * This is what the issue asked for: pick caveBat on the surface and the bot used
 * to roam a floor with no cave bats on it forever, because the prey lives on
 * z=-1 and nothing ever told it to go down. Now the hunt choice implies a
 * destination.
 *
 * Healthy-only by position rather than by its own HP check: the retreat branch
 * above returns before we get here whenever `bot.fleeing` is set, so a hurt bot
 * heals first and resumes the trip on the way back up. The trip can cross a floor
 * or two, and starting it at 20% HP walks a nearly-dead bot past everything that
 * just hurt it.
 */
function travelStep(bot, snap, me, cfg, log, spot) {
  if (!spot) return false;
  const z = bot.z ?? 0;

  // Wrong floor -> reuse the existing depth machinery, aimed at the spot. The
  // caller has already pointed cfg.depth here, so descend/climb and the trapdoor
  // obstacle rule all agree on where we are going.
  if (z > spot.z) return descendStep(bot, me, cfg, log, spot.tile);
  // Below the target floor is climbStep's job, and the caller runs it ahead of us.
  if (z < spot.z) return false;

  const [tx, ty] = [spot.tile[0] * TILE, spot.tile[1] * TILE];
  if (distPx(me.x, me.y, tx, ty) <= SPOT_ARRIVE_PX) {
    if (!bot.run.farmArrived) {
      bot.run.farmArrived = true;
      log?.(`arrived at the ${cfg.huntTypes.join('/')} spot on z${spot.z} `
        + `@${spot.tile} -- farming here`);
    }
    return false;
  }
  // Out of range again -- a bank run, a chase, or a retreat took us away. Re-arm
  // the arrival notice so the walk back is announced too, rather than the log
  // going quiet for the rest of the run after the first arrival.
  bot.run.farmArrived = false;

  // A monster we are hunting is already in view: fight it rather than walking
  // past it to reach the nominal centre of the spot. Without this the bot shoves
  // through a room full of prey to stand on a specific tile.
  if (nearestHuntable(snap, me, cfg.huntTypes)) return false;

  const [dx, dy] = navStep(bot, me, tx, ty);
  if (dx === 0 && dy === 0) {
    // The pathfinder is done or the goal is unreachable. Either way, standing
    // here re-asking is the freeze documented in nav.js -- treat it as arrived
    // and let ROAM find the monsters from wherever we got to.
    if (!bot.run.farmSpotStuck) {
      bot.run.farmSpotStuck = true;
      log?.(`cannot get closer to the ${cfg.huntTypes.join('/')} spot @${spot.tile} `
        + '-- farming from here');
    }
    return false;
  }
  bot.run.farmSpotStuck = false;
  farmLog(bot, 'TRAVEL',
    () => `to the ${cfg.huntTypes.join('/')} spot on z${spot.z} @${spot.tile} `
      + `(${(distPx(me.x, me.y, tx, ty) / TILE).toFixed(0)} tiles)`, log);
  bot.move(dx, dy);
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

// How many roam goals to sample before settling for the least bad one. Small on
// purpose: this runs on the tick that picks a new goal, and 'roughly away from
// the crowd' is all the precision this needs.
const ROAM_CANDIDATES = 8;

/**
 * Any legal step at all, or [0,0] if genuinely boxed in.
 *
 * The last line of defence against a freeze. Every caller above it has a reason
 * to prefer a particular direction; this one only cares that the bot MOVES,
 * because every freeze in this file has the same shape -- a tick whose answer
 * cannot change until the bot stands somewhere else.
 */
export function anyFreeStep(bot, me) {
  const z = bot.z ?? 0;
  const sx = nav.tileOf(me.x); const sy = nav.tileOf(me.y);
  const blocked = bot.run.occupied || new Set();
  // Shuffled so a boxed-in bot does not pick the same wall every tick.
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
  for (let i = dirs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
  }
  for (const [dx, dy] of dirs) {
    const step = nav.safeStep(z, sx, sy, dx, dy, blocked);
    if (step[0] || step[1]) return step;
  }
  return [0, 0];
}

/**
 * Score a prospective roam goal: how far the nearest other player would be,
 * capped at CROWD_PX because past that they are simply not a factor and we would
 * rather not have the bot flee to the map edge to maximise a number.
 */
function roamClearance(goal, others) {
  let worst = CROWD_PX;
  for (const p of others) {
    const d = distPx(goal[0], goal[1], p.x, p.y);
    if (d < worst) worst = d;
  }
  return worst;
}

/**
 * No prey visible: drift so spawns come back into view -- preferring open ground.
 *
 * With other players about we sample a handful of directions and take the one
 * that lands furthest from them, instead of the first random angle. That is the
 * prophylactic half of the courtesy rule: the bot drifts out of a busy area on
 * its own rather than waiting to be told a specific monster is spoken for.
 */
function roamStep(bot, me, cfg, log, others = []) {
  const t = now();
  let goal = bot.run.farmRoamGoal;
  // A goal we cannot make progress toward is worse than no goal: it is cached
  // for 20s, and every tick of that is a tick standing still. That is the third
  // way the bot freezes in a cave -- a random point that lands in rock, or in a
  // pocket walled off from us. Measured from the z=-1 ledge at 63,95, 30% of
  // raw random goals commanded no movement at all.
  const stalled = goal && !navStep(bot, me, goal[0], goal[1]).some(Boolean);
  if (!goal || stalled || since(bot, 'farmRoamSince') > 20.0
      || distPx(me.x, me.y, goal[0], goal[1]) <= TILE * 1.5) {
    let best = null; let bestScore = -Infinity;
    // Always sample several now. The old code took the FIRST random angle when
    // alone, which is exactly when nothing else would shake a bad goal loose.
    for (let i = 0; i < ROAM_CANDIDATES; i++) {
      const ang = Math.random() * 2 * Math.PI;
      const r = cfg.roamPx * (0.4 + Math.random() * 0.6);
      const cand = [me.x + Math.cos(ang) * r, me.y + Math.sin(ang) * r];
      // Reject goals we cannot actually walk toward, so the cache only ever
      // holds a goal that makes progress.
      if (!navStep(bot, me, cand[0], cand[1]).some(Boolean)) continue;
      const score = others.length ? roamClearance(cand, others) : 0;
      if (score > bestScore) { bestScore = score; best = cand; }
    }
    // Every candidate was a dead end (a tight pocket). Keep whatever we had
    // rather than caching a null and re-sampling 8 goals every tick.
    if (best) {
      goal = best;
      bot.run.farmRoamGoal = goal;
      bot.run.farmRoamSince = t;
    }
  }
  farmLog(bot, 'ROAM',
    () => (others.length ? '(no free prey in sight -- drifting off the crowd)'
      : '(no prey in sight)'), log);
  const step = goal ? navStep(bot, me, goal[0], goal[1]) : [0, 0];
  // Nothing worked -- take any legal step rather than none. Movement is what
  // makes the next tick's answer different; standing still never resolves.
  bot.move(...(step.some(Boolean) ? step : anyFreeStep(bot, me)));
}

// ---- the corner standoff ---------------------------------------------------
//
// Melee is decided on straight-line pixel distance, but the server enforces its
// own reachability. Around a wall corner those disagree: a cave bat can sit well
// inside MELEE_RANGE_PX with a rock between us. Its own pathing lets it hit us;
// our swings resolve against nothing.
//
// That disagreement used to be a livelock, and the reason is that the fight
// branch STOPS to swing -- `bot.move(0, 0)`. Standing still is right when the
// target is really in reach and wrong when it isn't, and the bot had no way to
// tell the cases apart, so it stood there being eaten while the log cheerfully
// reported FIGHT. The issue's own fix (\"just move over a little\") works because
// any movement at all breaks the geometry.
//
// The evidence that we are in the bad case is the absence of our own combat
// events: we are swinging, the monster is inside melee range, and nothing has
// landed. One tick of that proves nothing -- attacks are on a cooldown of about
// a second and the loop runs at 10 Hz, so silence is the NORMAL state between
// swings. Only sustained silence is a standoff.
export const STANDOFF_S = 1.5;

// How long to keep sidestepping once we commit. A single tick of movement is
// not enough to clear a corner (one tick is a few pixels), and re-deciding every
// tick makes the bot vibrate on the spot rather than actually going anywhere.
const SIDESTEP_S = 0.6;

/**
 * True when we appear to be in melee with `m` but nothing we swing is landing.
 *
 * Requires having been in the fight for STANDOFF_S: `farmMeleeSince` is set on
 * the first tick we are in range of this target and cleared whenever the target
 * changes, so the clock measures time spent swinging at THIS monster, not time
 * since the run began.
 */
export function inStandoff(bot, m) {
  const since0 = bot.run.farmMeleeSince;
  if (since0 === undefined || m.id !== bot.run.farmMeleeTarget) return false;
  if (now() - since0 < STANDOFF_S) return false;
  return !bot.isHitting(m.id, STANDOFF_S);
}

/**
 * Note that we are in melee with `m`, and answer whether the swing is landing.
 *
 * Keeping the bookkeeping next to the test matters: the clock has to start on
 * the first in-range tick, and it has to reset when we switch targets, or a long
 * fight with one monster would make the next monster look stuck instantly.
 */
export function meleeStandoff(bot, m) {
  if (bot.run.farmMeleeTarget !== m.id) {
    bot.run.farmMeleeTarget = m.id;
    bot.run.farmMeleeSince = now();
    bot.run.farmSidestepUntil = undefined;
    return false;
  }
  return inStandoff(bot, m);
}

/** Forget the melee clock -- we are no longer toe to toe with anything. */
export function clearMelee(bot) {
  bot.run.farmMeleeTarget = undefined;
  bot.run.farmMeleeSince = undefined;
  bot.run.farmSidestepUntil = undefined;
}

/**
 * A step that circles `m` instead of pressing into it.
 *
 * Perpendicular to the line to the target, so we slide ALONG the wall rather
 * than into it -- stepping straight back just re-runs the approach and re-enters
 * the same standoff. safeStep vetoes it against the collision grid, and when
 * both perpendicular directions are walled we fall back to the reverse, which is
 * the one remaining way out of a dead end.
 *
 * The direction is chosen once per sidestep and held for SIDESTEP_S (stored on
 * `bot.run`), because alternating each tick is the jitter that goes nowhere.
 */
export function sidestep(bot, me, m) {
  const z = bot.z ?? 0;
  const sx = nav.tileOf(me.x); const sy = nav.tileOf(me.y);
  const blocked = bot.run.occupied || new Set();
  let dir = bot.run.farmSidestepDir;
  if (dir === undefined || !(now() < (bot.run.farmSidestepUntil ?? -Infinity))) {
    dir = Math.random() < 0.5 ? 1 : -1;
    bot.run.farmSidestepDir = dir;
    bot.run.farmSidestepUntil = now() + SIDESTEP_S;
  }
  const [tx, ty] = stepToward(me, m.x, m.y);
  // Rotate the approach vector 90 degrees, in the chosen handedness. The last
  // candidate is the reverse -- the only way out of a dead end, once both
  // perpendiculars are walled.
  const cands = [[-ty * dir, tx * dir], [ty * dir, -tx * dir], [-tx, -ty]];
  // Sub-pixel separation rounds the approach vector to (0,0) -- two entities on
  // one tile -- and rotating that yields nothing to try. Any free direction
  // breaks the geometry just as well, which is all the sidestep needs.
  cands.push([1, 0], [-1, 0], [0, 1], [0, -1]);
  for (const [dx, dy] of cands) {
    const step = nav.safeStep(z, sx, sy, dx, dy, blocked);
    if (step[0] || step[1]) return step;
  }
  return [0, 0];
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

    // Resolve the destination BEFORE anything reads cfg.depth, because two
    // things below depend on it and both get the wrong answer otherwise:
    // setNavObstacles treats trapdoors as walls unless we mean to go down (so a
    // stale depth of 0 makes A* route around the very hole we need), and
    // climbStep would read us as "too deep" and climb back out of the floor we
    // just travelled to.
    const spot = huntSpot(bot, cfg);
    if (spot) cfg.depth = spot.z;

    // A bank run overrides the hunt's floor: the depot is on the surface, so
    // while the trip is latched we want to be at z=0 and not one step below it.
    // Setting cfg.depth here is what makes the climb happen at all -- climbStep
    // fires on `z < cfg.depth`, so with depth pinned to the cave the bot was
    // already "on the right floor" and nothing ever walked it out. Reverts the
    // moment banking ends, and travelStep/descendStep then take it back down.
    if (bot.run.banking) cfg.depth = DEPOT_Z;

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
    // Underground counts too, and used to not: the trigger was gated on
    // `z === DEPOT_Z`, so a bot that filled its pack in a cave never latched and
    // farmed on forever dropping loot it could not carry. Since travel routes
    // bots underground as a matter of course, that was the normal case rather
    // than the exception -- the pack simply never got banked.
    //
    // What makes latching down there safe now is the cfg.depth override at the
    // top of the tick: it points climbStep at the surface, so the ladder walk out
    // is a real step the trip makes rather than a state the bot is stuck in. The
    // old comment's fear (latching sets `banking` for good because bankStep
    // declines every tick off z=0) was correct about the code as it stood.
    // `bankStranded` is set when the climb out proved impossible (below), and
    // suppresses the trigger for the rest of the run on that floor. Without it
    // the give-up re-latches on the very next tick -- shouldBank is still true,
    // the pack is still full -- and the log fills with one abandoned bank run per
    // 100 ms. Cleared by climbStep succeeding for any other reason, since a bot
    // that has changed floors deserves a fresh look.
    if (!bot.run.banking && !bot.run.bankStranded && shouldBank(bot, cfg)) {
      bot.run.banking = true;
      // Retarget the floor on the tick that latches, not just from the next one
      // onwards: the override at the top of the tick reads `banking`, which was
      // still false when it ran. Without this the climb loses its first tick and
      // -- worse -- setNavObstacles has already treated the trapdoors as open for
      // a descent we are no longer making.
      cfg.depth = DEPOT_Z;
      const [free, cap] = bot.packSpace();
      const where = (bot.z ?? 0) === DEPOT_Z ? '' : ` from z${bot.z}`;
      log?.(`pack ${cap - free}/${cap} -- heading to the depot${where}`);
    }
    // Climb out before bankStep gets a look: it declines every tick off z=0, so
    // on a cave floor this is the branch that actually advances the trip.
    //
    // A floor with no way up abandons the trip rather than latching on it. That
    // is the exact state the pre-climb code was written to avoid -- `banking` set
    // for good while bankStep declines every tick -- and climbStep returning
    // false is the one case that still reaches it. Better to farm on with a full
    // pack (the old behaviour) than to stand in a hole believing we are shopping.
    if (bot.run.banking && (bot.z ?? 0) < DEPOT_Z) {
      if (climbStep(bot, me, cfg, log)) return;
      log?.(`!! no way up from z${bot.z} -- giving up on the bank run`);
      bot.run.bankStranded = bot.z ?? 0;
      endBanking(bot, log);
    } else if (bot.run.bankStranded != null && bot.run.bankStranded !== (bot.z ?? 0)) {
      // Moved off the floor we were stranded on -- the depot may be reachable
      // from here, so allow the trigger again.
      bot.run.bankStranded = null;
    }
    if (bot.run.banking && bankStep(bot, snap, me, cfg, log)) return;

    // --- travel to where the prey actually lives, only when healthy -------
    // Ahead of prey selection because the whole point is that there is no prey
    // here: a caveBat hunt on the surface has nothing to select, and roaming for
    // it is what this replaces. travelStep yields the tick the moment a hunted
    // monster is in view, so arriving mid-room starts the fight immediately.
    //
    // Skipped while something is actually on us: travelStep only yields for a
    // HUNTED monster, so a bat that aggroed us on the way to the orc spot would
    // otherwise get a free escort across the floor, hitting us the whole way. We
    // are still healthy here (the retreat branch returned above), so turning to
    // kill it is the cheap outcome -- and it is the only way the trip finishes.
    //
    // Scanned once for the tick and reused by the fight branch below, like the
    // ground scan: this walks every monster in view at 10 Hz.
    const attacker = cfg.defend ? nearestAttacker(bot, snap, me) : null;
    if (!attacker && travelStep(bot, snap, me, cfg, log, spot)) return;

    if (cfg.depth < 0 && descendStep(bot, me, cfg, log)) return;

    // --- who else is here -------------------------------------------------
    // Resolved once for the tick: prey selection, looting and roaming all need
    // the same answer, and each of them scans every player otherwise.
    const others = cfg.courtesy ? otherPlayers(bot, snap, cfg) : [];
    const claimed = others.length ? claimedMonsters(snap, me, others) : null;

    // --- grab loot at our feet before moving on --------------------------
    // Loot used to sit behind the fight branch, so on a field that always has
    // another rat in view he never stopped to collect and left every corpse
    // behind. A monster already in melee still comes first.
    const canReach = reachChecker(bot, me);
    let m = nearestHuntable(snap, me, cfg.huntTypes, claimed, canReach);
    // Everything in view is somebody else's. Walking away to find our own spawns
    // is a real alternative -- and the issue's rule is that a viable alternative
    // always beats muscling in -- so drop the target and let ROAM take us out of
    // their area. Not applied to something already on us: `claimed` excludes
    // monsters we are closer to, so a mob in our face is ours to finish.
    if (m && claimed && claimed.has(m.id)) {
      farmLog(bot, 'YIELD',
        () => `${m.monsterType} is another player's -- moving on`, log);
      m = null;
    }

    // Everything huntable in view is behind a wall. Standing here staring at it
    // is the freeze this check exists to prevent -- and unlike YIELD there is no
    // question of stealing, it is simply not ours to reach. Drop it and let ROAM
    // move us, which is what makes the next tick's answer different.
    if (m && !canReach(m)) {
      farmLog(bot, 'UNREACHABLE',
        () => `${m.monsterType} is walled off -- roaming for one we can reach`, log);
      m = null;
    }

    // --- self-defense overrides the hunt ---------------------------------
    // Something is hitting us right now. It outranks the hunted target (which
    // may be across the room), it outranks a YIELD (a monster on us is not a
    // kill we are stealing), and below it outranks looting -- picking up a
    // corpse while a bat chews on us is how a full pack turns into a dead bot.
    // This is the whole multi-enemy-area fix: in a mixed room the type filter
    // used to make our own attackers invisible.
    //
    // Nothing is logged here -- the fight branch below reports it. Logging DEFEND
    // at this point would be overwritten by that branch's own farmLog a few lines
    // later, leaving two lines a tick for one decision and the wrong one in
    // bot.run.farmState.
    const defending = !!attacker && attacker.id !== m?.id;
    if (defending) m = attacker;

    // Being attacked counts as engaged even a little outside melee reach: the
    // attacker is inside ATTACKER_PX, which is deliberately wider, and looting
    // through those extra few pixels is still looting while something hits us.
    const engaged = !!attacker
      || (m && distPx(m.x, m.y, me.x, me.y) < MELEE_RANGE_PX);
    // One ground scan for the whole tick, reused by both loot branches below.
    const loot = cfg.loot ? nearestLoot(bot, snap, me, others) : null;
    if (loot && !engaged && loot.dist <= cfg.lootPx) {
      if (lootStep(bot, snap, me, log, loot)) {
        farmLog(bot, 'LOOT', null, log);
        return;
      }
    }

    // --- fight -----------------------------------------------------------
    if (m) {
      // DEFEND is this same branch under a different name: swinging back at
      // something that is on us, rather than picking a fight we went looking
      // for. Worth distinguishing in the log -- "why is my orc bot killing bats"
      // has an answer, and it should be visible in the run.
      const state = defending ? 'DEFEND' : 'FIGHT';
      const d = distPx(m.x, m.y, me.x, me.y);
      if (d < MELEE_RANGE_PX) {
        // Keep swinging either way -- the attack is what tells us whether we can
        // reach it, so going quiet while we reposition would make the standoff
        // permanent by removing its own evidence.
        bot.attack(m.id);
        if (meleeStandoff(bot, m)) {
          // In range, swinging, nothing landing: a wall is between us. Slide
          // around it rather than standing still being chewed on.
          bot.move(...sidestep(bot, me, m));
          farmLog(bot, state,
            () => `${m.monsterType} is behind a corner -- stepping around it`, log);
        } else {
          bot.move(0, 0);
          // FIGHT and CHASE are one state for logging: closing the last few px
          // flips between them several times a second.
          farmLog(bot, state,
            () => `${m.monsterType} ${m.hp}/${m.maxHp} hp=${me.hp}`
              + (defending ? ' (it attacked us)' : ''), log);
        }
      } else {
        clearMelee(bot);
        let step = navStep(bot, me, m.x, m.y);
        // A chase that commands no movement is a freeze. It happens when the
        // target is unroutable -- prey selection drops those, but a DEFEND
        // target is kept deliberately (it is hitting us), and A* has no path to
        // a monster shooting across a wall. Circling beats standing still: it is
        // the same answer the corner standoff gives, for the same reason, and it
        // is what changes the geometry so the next tick can differ.
        if (!step[0] && !step[1]) step = sidestep(bot, me, m);
        bot.move(...step);
        farmLog(bot, state,
          () => `chasing ${m.monsterType} ${(d / TILE).toFixed(1)} tiles`, log);
      }
      return;
    }

    // --- nothing to fight: sweep up the rest of the loot ------------------
    if (cfg.loot && lootStep(bot, snap, me, log, loot)) {
      farmLog(bot, 'LOOT', null, log);
      return;
    }

    roamStep(bot, me, cfg, log, others);
  };
}
