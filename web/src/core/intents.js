// The small one-off intents: heal, follow, move. Port of avalon.py's make_heal /
// make_follow / make_move.
//
// These are the debugging verbs -- the ones you reach for when something else is
// misbehaving and you need to put a character somewhere, top it up, or watch it
// track a target. They're deliberately simple, and each sets `bot.done` when it
// has finished so the CLI can exit.

import { TILE } from './protocol.js';
import {
  distPx, meOf, setNavObstacles, navStep, findNpc,
  usefulPotion, drinkPotion, HEAL_POTIONS,
} from './farm.js';
import { findPlayer } from './swarm.js';

const now = () => performance.now() / 1000;
const since = (bot, key) => now() - (bot.run[key] ?? -Infinity);

// Named map positions, e.g. {bank: [60, 40]}. Empty by default -- kept as the
// hook the Python had so `move bank` works once anyone fills it in.
export const LOCATIONS = {};

/** '58,22' -> [58, 22]; anything else -> null. */
export function parseTile(spec) {
  if (!spec || !spec.includes(',')) return null;
  const [xs, ys] = spec.split(',', 2);
  const x = Number(xs); const y = Number(ys);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

/**
 * A target spec -> [xPx, yPx]. Accepts an 'x,y' tile, a name from LOCATIONS, or
 * a player name resolved against the current snapshot. Returns null if a player
 * name matched nobody visible.
 */
export function resolveTarget(spec, snap) {
  const tile = parseTile(spec);
  if (tile) return [(tile[0] + 0.5) * TILE, (tile[1] + 0.5) * TILE];
  const loc = LOCATIONS[String(spec).toLowerCase()];
  if (loc) return [(loc[0] + 0.5) * TILE, (loc[1] + 0.5) * TILE];
  const p = findPlayer(snap, spec);
  return p ? [p.x, p.y] : null;
}

/**
 * Walk to a target and stop.
 *
 * `arrivePx` must be at least a full TILE, and that is not a comfort margin --
 * it is what keeps arrival and pathfinding from disagreeing. A* works in whole
 * tiles, so once we are on the tile ADJACENT to the goal it reports the step as
 * taken and returns [0,0]. With a tighter radius (0.75 tiles was the bug) the
 * bot stands one tile out, forever "not arrived" while the pathfinder insists
 * there is nothing left to do -- it never moves and never finishes.
 */
export function makeMove(spec, log, arrivePx = TILE) {
  return function tick(bot, snap) {
    const me = meOf(bot, snap);
    if (!me) return;
    setNavObstacles(bot, snap, me);

    const goal = resolveTarget(spec, snap);
    if (!goal) {
      const visible = snap.players.filter((p) => p.id !== bot.me).map((p) => p.name);
      log?.(`can't resolve ${spec} -- visible players: ${visible.join(', ') || '(none)'}`);
      bot.done = true;
      return;
    }
    const d = distPx(me.x, me.y, goal[0], goal[1]);
    if (d <= arrivePx) {
      bot.move(0, 0);
      log?.(`arrived (${Math.round(me.x / TILE)},${Math.round(me.y / TILE)})`);
      bot.done = true;
      return;
    }
    const [dx, dy] = navStep(bot, me, goal[0], goal[1]);
    bot.move(dx, dy);
  };
}

/**
 * Trail a player, staying ~keepPx behind.
 *
 * Two things make this sticky where the naive version stalls:
 *
 *  * Hysteresis -- start chasing above keepPx, but only STOP once comfortably
 *    inside it (keepPx*0.6). Without the gap the bot sits at the boundary
 *    flip-flopping between move and stop, and ends up parked while the target
 *    drifts away a pixel at a time.
 *  * Last-known-position memory -- when the target walks off screen the snapshot
 *    stops listing them. Stopping dead there is the "didn't continue after I
 *    moved again" bug; instead we keep walking to where we last saw them for a
 *    few seconds, which usually carries us far enough to re-acquire.
 */
export function makeFollow(targetName, keepPx, log) {
  const stopPx = keepPx * 0.6;
  const LOST_GRACE_S = 4.0;

  return function tick(bot, snap) {
    const me = meOf(bot, snap);
    if (!me) return;
    setNavObstacles(bot, snap, me);

    const t = findPlayer(snap, targetName, bot.me);
    let tx; let ty;

    if (t) {
      if (!bot.run.followSeen) {
        bot.run.followSeen = true;
        log?.(`following ${t.name} (keep ${(keepPx / TILE).toFixed(0)} tiles behind)`);
      }
      bot.run.followLast = [t.x, t.y, now()];
      tx = t.x; ty = t.y;
    } else {
      const last = bot.run.followLast;
      if (!last || now() - last[2] > LOST_GRACE_S) {
        // Never seen them, or lost too long ago. Say who IS visible the first
        // time, so a name typo -- the usual cause of "it just stands there" --
        // is obvious rather than silent.
        if (!bot.run.followWarned) {
          bot.run.followWarned = true;
          const visible = snap.players.filter((p) => p.id !== bot.me).map((p) => p.name);
          log?.(`target ${targetName} not in view. Visible: ${visible.join(', ') || '(none)'}`);
        }
        bot.move(0, 0);
        return;
      }
      [tx, ty] = last;
    }

    const d = distPx(me.x, me.y, tx, ty);
    let chasing = bot.run.followChasing || false;
    if (d > keepPx) chasing = true;
    else if (d <= stopPx) chasing = false;
    bot.run.followChasing = chasing;

    if (!chasing) { bot.move(0, 0); return; }
    const [dx, dy] = navStep(bot, me, tx, ty);
    bot.move(dx, dy);
  };
}

/**
 * Heal to full: prefer a potion, else walk to a healer NPC and use their
 * dialogue. `forceHealer` skips potions entirely, which is how you exercise the
 * dialogue path deliberately.
 *
 * The heal option's id is dynamic, so this only OPENS the dialogue -- farm.js's
 * handleDialogue picks the option when the reply arrives. Wiring that handler is
 * the caller's job; without it this stands at the healer forever.
 */
export function makeHeal({ forceHealer = false, log } = {}) {
  return function tick(bot, snap) {
    const me = meOf(bot, snap);
    if (!me) return;
    setNavObstacles(bot, snap, me);

    if (me.hp >= me.maxHp) {
      log?.(`already full (${me.hp}/${me.maxHp})`);
      bot.done = true;
      return;
    }

    if (!forceHealer && tryPotion(bot, me, log)) return;

    const healer = findNpc(snap);
    if (!healer) {
      log?.(`hp ${me.hp}/${me.maxHp} -- no healer nearby. `
        + 'Move to Brother Aldric, then run heal again.');
      bot.done = true;
      return;
    }

    if (distPx(me.x, me.y, healer.x, healer.y) > TILE * 1.5) {
      const [dx, dy] = navStep(bot, me, healer.x, healer.y);
      bot.move(dx, dy);
      return;
    }

    bot.move(0, 0);
    if (since(bot, 'healTalk') >= 3.0) {
      bot.run.healTalk = now();
      bot.run.healNpc = healer.id;      // handleDialogue answers on this
      log?.(`hp ${me.hp}/${me.maxHp} -- talking to ${healer.name}`);
      bot.talkTo(healer.id);
    }
  };
}

/**
 * Drink a potion if one would help. Returns true if the potion path is still
 * working -- we drank, or we're holding a useful one and waiting out the
 * cooldown -- meaning "don't fall through to the healer yet".
 *
 * Deliberately built on farm.js's `usefulPotion`/`drinkPotion` rather than its
 * own copy. The `missing >= amt/2` rule and the cooldown must be IDENTICAL in
 * `heal` and `farm`; a second implementation drifted immediately last time (a
 * 1.5 s cooldown against farm's 0.8 s, on a separate state slot, so the two
 * didn't even share a timer).
 */
function tryPotion(bot, me, log) {
  if (drinkPotion(bot, me, (m) => log?.(`hp ${me.hp}/${me.maxHp} -- ${m}`))) return true;
  if (usefulPotion(bot, me)) return true;      // holding one, cooldown pending
  if (bot.run.healLastDrink != null) {
    // We drank at least once and nothing left would help: stop rather than
    // spamming useItem, and let regen finish the last sliver.
    const held = HEAL_POTIONS.reduce((n, [pid]) => n + bot.countItem(pid), 0);
    log?.(`hp ${me.hp}/${me.maxHp} -- `
      + (held ? 'close enough (regen will finish)' : 'out of health potions'));
    bot.done = true;
    return true;
  }
  return false;
}
