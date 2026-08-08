// Grid navigation: A* over the extracted collision maps.
//
// The maps come from core/maps.js -- one ASCII grid per z-level where '#' is
// blocked. That grid is bit-exact with what the server enforces, so A* over it
// yields real paths around walls.
//
// The maps are GENERATED from the client bundle, so a game redeploy invalidates
// any stale copy. Neither runtime relies on one: the CLI re-extracts on startup,
// and the userscript extracts from the bundle the page is actually running.
// `mapBundle()` exposes which client the loaded set came from.
//
// A* alone is not sufficient, because it plans in whole TILES while movement
// happens in PIXELS. `pathStep` closes that gap with centre steering and
// `safeStep`; without them a valid tile-by-tile plan can still emit a step that
// clips a wall corner and nets zero movement.

import { TILE } from './protocol.js';

let MAPS = null;
let MAP_BUNDLE = null;

/** Install the embedded maps: {z -> {widthTiles, heightTiles, rows, teleports}}. */
export function loadMaps(raw) {
  MAPS = new Map();
  MAP_BUNDLE = raw?.bundle || null;
  for (const [zk, zn] of Object.entries(raw || {})) {
    if (zk === 'bundle') continue;
    MAPS.set(parseInt(zk, 10), {
      w: zn.widthTiles, h: zn.heightTiles, rows: zn.rows,
      teleports: zn.teleports || [],
      spawns: zn.spawns || [],
    });
  }
  return MAPS;
}

export function mapBundle() { return MAP_BUNDLE; }

export function haveMap(z) { return !!MAPS && MAPS.has(Number(z)); }

export function teleports(z) {
  const m = MAPS?.get(Number(z));
  return m ? m.teleports : [];
}

export function spawns(z) {
  const m = MAPS?.get(Number(z));
  return m ? m.spawns : [];
}

/** Every z-level we have a map for, surface first then deeper. */
export function knownDepths() {
  return MAPS ? [...MAPS.keys()].sort((a, b) => b - a) : [];
}

/**
 * How far a farm spot's monsters roam. A spawn's `leashTiles` is the radius the
 * monster wanders in, so two spawns within this of each other feed one spot.
 */
const CLUSTER_TILES = 12;

// A spot must be reachable, and a spawn sitting inside a wall (or one whose tile
// the worldgen later built over) is not somewhere we can stand and fight.
const SPAWN_SNAP_RADIUS = 4;

/**
 * Where to go to hunt `types`: the spawn clusters for those monsters, richest
 * first, as `{z, tile, count, spawns}`.
 *
 * Clustered rather than returned raw because a single spawn point is a poor
 * target -- one monster on a 5-tile leash is a few seconds of farming and then
 * a respawn wait. Concentrations are what make a spot worth walking to, and the
 * bundle's own layout obliges: cave bats come in caves of a dozen, not singly.
 *
 * `nightOnly` spawns (the wraiths) are excluded by default: they are simply not
 * there in daylight, so a cluster of them is an empty room to walk to. Pass
 * `night: true` to include them.
 *
 * Ranked by count DISCOUNTED for depth, not by raw count. Depth is danger and
 * distance in this game, and the two are not close to commensurate: the richest
 * cave-bat cluster in the bundle is on z=-4, through hell and past two bosses,
 * while z=-1 has a dozen rooms nearly as good one ladder from town. Ranking on
 * count alone marches a starting character into the hell floors to gain one
 * extra spawn, so each floor down costs a fixed fraction of the spot's value.
 */
export function huntingGrounds(types = null, { night = false } = {}) {
  const want = types && types.length ? new Set(types) : null;
  const out = [];
  for (const z of knownDepths()) {
    const here = spawns(z).filter((s) =>
      (!want || want.has(s.monsterType)) && (night || !s.nightOnly));
    // Greedy single-pass clustering: seed on a spawn, absorb every other spawn
    // within CLUSTER_TILES, repeat. Good enough for a table of 155 points, and
    // it keeps the richest room together, which is the only property we need.
    const taken = new Set();
    for (const seed of here) {
      if (taken.has(seed.id)) continue;
      const group = [];
      for (const s of here) {
        if (taken.has(s.id)) continue;
        if (Math.hypot(s.tile[0] - seed.tile[0], s.tile[1] - seed.tile[1]) > CLUSTER_TILES) {
          continue;
        }
        taken.add(s.id);
        group.push(s);
      }
      // Aim at the group's centre of mass, then snap it onto open ground: the
      // middle of a ring of spawns can easily be the rock they are arranged
      // around, and an unreachable goal makes A* fail every tick.
      const cx = Math.round(group.reduce((a, s) => a + s.tile[0], 0) / group.length);
      const cy = Math.round(group.reduce((a, s) => a + s.tile[1], 0) / group.length);
      const tile = nearestWalkable(z, cx, cy, new Set(), SPAWN_SNAP_RADIUS)
        // Fall back to a spawn's own tile, which the monster stands on and so is
        // walkable by construction.
        || seed.tile;
      out.push({ z, tile, count: group.length, spawns: group });
    }
  }
  out.sort((a, b) => spotValue(b) - spotValue(a) || b.z - a.z);
  return out;
}

// What one floor of descent costs a spot, as a fraction of its value. At 0.55 a
// cluster must be nearly twice as rich to justify each extra floor -- which is
// what keeps a caveBat hunt on z=-1 (3 spawns, one ladder from town) instead of
// z=-4 (5 spawns, through hell).
const DEPTH_DISCOUNT = 0.55;

/** A cluster's worth: spawn count, discounted for how deep you must go. */
export function spotValue(spot) {
  return spot.count * DEPTH_DISCOUNT ** -spot.z;
}

/** Nearest teleport on `z` leading to `toZ`, optionally filtered by mode. */
export function nearestTeleport(z, toZ, fromTile, mode = null) {
  const cands = teleports(z).filter(
    (t) => t.toZ === toZ && (mode === null || t.mode === mode));
  if (!cands.length) return null;
  const [fx, fy] = fromTile;
  return cands.reduce((best, t) => {
    const d = (t.fromTile[0] - fx) ** 2 + (t.fromTile[1] - fy) ** 2;
    return best && best.d <= d ? best : { d, t };
  }, null).t;
}

/**
 * The teleport from `z` to `toZ` that best trades the walk to it against the
 * walk from where it lands to `goalTile`.
 *
 * Reachability is checked, not assumed, and that is the load-bearing part rather
 * than a refinement. The underground floors are NOT connected regions: z=-1 holds
 * a bat cave around the 58,22 entrance and a separate orc den reachable only
 * through the hole at 20,78, with no path between them. Ranking holes by
 * straight-line distance alone picks the nearest one and hands A* a goal it can
 * never reach -- the bot then walks to the wrong cave and roams there, which is
 * the same symptom as the bug this whole feature exists to fix.
 *
 * So candidates that cannot actually reach the goal are dropped, and only among
 * the rest does distance decide. The A* runs are the price; this is called once
 * when a route is chosen, not on every tick.
 */
export function bestTeleportToward(z, toZ, fromTile, goalTile) {
  const cands = teleports(z).filter((t) => t.toZ === toZ);
  if (!cands.length) return null;
  const [fx, fy] = fromTile;
  const [gx, gy] = goalTile;
  let best = null; let bestCost = Infinity;
  let fallback = null; let fallbackCost = Infinity;
  for (const t of cands) {
    const walkTo = Math.hypot(t.fromTile[0] - fx, t.fromTile[1] - fy);
    // Where it PUTS us, which is toTile -- not the tile we step on to use it.
    const [lx, ly] = t.toTile || t.fromTile;
    const cost = walkTo + Math.hypot(lx - gx, ly - gy);
    // Can we get from where this hole drops us to the prey at all?
    const connected = (lx === gx && ly === gy)
      || findPath(toZ, [lx, ly], goalTile, null).length > 0;
    if (connected) {
      if (cost < bestCost) { bestCost = cost; best = t; }
    } else if (cost < fallbackCost) { fallbackCost = cost; fallback = t; }
  }
  // Every hole failed the check -- take the nearest by distance rather than
  // refusing to descend. A missing map or an A* budget overrun must not strand
  // the bot on the surface.
  return best || fallback;
}

/**
 * Tiles on `z` that drop you DOWN the moment you stand on them.
 *
 * These are the 'walk'-mode holes, and they are a trap for a pathfinder: an
 * 'interact' ladder is inert until you send useTeleport, but a hole fires on
 * contact. So A* routing a chase THROUGH one silently teleports the bot to
 * another floor -- which is how a surface rat-hunt ended up on z=-1, looting
 * among monsters it had no orders to fight.
 *
 * Returned as a Set of tileKeys so it can be handed straight to pathStep's
 * `blocked` set, which is also how dynamic player-collision is done.
 */
export function trapdoorTiles(z) {
  const out = new Set();
  for (const t of teleports(z)) {
    if (t.mode === 'walk' && t.toZ < z) out.add(tileKey(t.fromTile[0], t.fromTile[1]));
  }
  return out;
}

/** Nearest teleport on `z` that goes UP, or null on the surface. */
export function nearestUpwardTeleport(z, fromTile) {
  const up = teleports(z).filter((t) => t.toZ > z);
  if (!up.length) return null;
  const [fx, fy] = fromTile;
  return up.reduce((best, t) => {
    const d = (t.fromTile[0] - fx) ** 2 + (t.fromTile[1] - fy) ** 2;
    return best && best.d <= d ? best : { d, t };
  }, null).t;
}

export function walkable(z, tx, ty) {
  const m = MAPS?.get(Number(z));
  if (!m) return true;                  // unknown map -> don't block movement
  if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return false;
  return m.rows[ty][tx] !== '#';
}

// 8-connected neighbours; diagonals cost ~sqrt(2).
const SQRT2 = 1.41421356;
const NEIGHBORS = [
  [-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1],
  [-1, -1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [1, 1, SQRT2],
];

// Pack a tile into one number so `blocked` can be a Set of primitives. The
// stride must exceed any map height; grids are 120x112, so 100000 is ample.
export const tileKey = (tx, ty) => tx * 100000 + ty;
const key = tileKey;

// How long to trust a failed search before trying again (see pathStep).
const UNREACHABLE_RETRY_MS = 1000;

function free(z, tx, ty, blocked) {
  return walkable(z, tx, ty) && !blocked.has(key(tx, ty));
}

/** Snap a blocked goal to the closest free tile within `radius`. */
function nearestWalkable(z, tx, ty, blocked, radius = 6) {
  if (free(z, tx, ty, blocked)) return [tx, ty];
  let best = null;
  for (let r = 1; r <= radius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (!free(z, tx + dx, ty + dy, blocked)) continue;
        const d = dx * dx + dy * dy;
        if (!best || d < best[0]) best = [d, tx + dx, ty + dy];
      }
    }
    if (best) return [best[1], best[2]];
  }
  return null;
}

/** Min-heap keyed on f-score -- stands in for Python's heapq. */
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1; const r = l + 1;
        let s = i;
        if (l < a.length && a[l][0] < a[s][0]) s = l;
        if (r < a.length && a[r][0] < a[s][0]) s = r;
        if (s === i) break;
        [a[s], a[i]] = [a[i], a[s]];
        i = s;
      }
    }
    return top;
  }
}

/**
 * A* on the 8-connected walkability grid. Returns tiles from just-after-start
 * through goal, or [] if unreachable. Diagonals may not cut a wall corner.
 *
 * `blocked` is a Set of key(tx,ty) for dynamically-occupied tiles (other
 * players): the server enforces player collision the static map doesn't know
 * about, so without this bots stack single-file and pin on each other.
 */
export function findPath(z, startTile, goalTile, blocked = null, maxExpand = 20000) {
  if (!haveMap(z)) return [];
  const [sx, sy] = startTile;
  let block = blocked || new Set();
  // Never block where we already stand.
  if (block.has(key(sx, sy))) {
    block = new Set(block);
    block.delete(key(sx, sy));
  }
  const goal = nearestWalkable(z, goalTile[0], goalTile[1], block);
  if (!goal) return [];
  const [gx, gy] = goal;
  if (sx === gx && sy === gy) return [];

  const h = (x, y) => {
    const dx = Math.abs(x - gx); const dy = Math.abs(y - gy);
    return (dx + dy) + (SQRT2 - 2) * Math.min(dx, dy); // octile
  };

  const open = new Heap();
  open.push([h(sx, sy), 0, sx, sy]);
  const came = new Map();
  const gscore = new Map([[key(sx, sy), 0]]);
  let expanded = 0;

  while (open.size) {
    const [, g, x, y] = open.pop();
    if (x === gx && y === gy) {
      const path = [[x, y]];
      let cx = x; let cy = y;
      for (;;) {
        const prev = came.get(key(cx, cy));
        if (!prev) break;
        [cx, cy] = prev;
        path.push([cx, cy]);
      }
      path.reverse();
      return path.slice(1);            // drop the start tile
    }
    if (++expanded > maxExpand) return [];
    // A stale heap entry (we already found a cheaper route here) -- skip it.
    if (g > (gscore.get(key(x, y)) ?? Infinity)) continue;

    for (const [dx, dy, cost] of NEIGHBORS) {
      const nx = x + dx; const ny = y + dy;
      if (!free(z, nx, ny, block)) continue;
      if (dx && dy) {                  // no corner-cutting through walls
        if (!(free(z, x + dx, y, block) && free(z, x, y + dy, block))) continue;
      }
      const ng = g + cost;
      if (ng < (gscore.get(key(nx, ny)) ?? Infinity)) {
        gscore.set(key(nx, ny), ng);
        came.set(key(nx, ny), [x, y]);
        open.push([ng + h(nx, ny), ng, nx, ny]);
      }
    }
  }
  return [];
}

/**
 * The server labels a position by round(px/TILE) (verified: px 2067 -> tile 65).
 * Flooring disagrees by a tile when straddling a boundary, so we'd plan from the
 * wrong tile and issue a move that clips an adjacent wall, netting zero.
 */
export function tileOf(px) { return Math.round(px / TILE); }

/**
 * A (dx,dy) in {-1,0,1} following an A* path to the goal, caching the path on
 * `bot` and recomputing only when the goal moves, we consume the path, we drift
 * off it, or a dynamic obstacle lands on our next step. Falls back to a greedy
 * step where there's no map, so behaviour degrades safely on unknown zones.
 */
export function pathStep(bot, me, z, goalPx, blocked = null, repathTiles = 3) {
  const gx = tileOf(goalPx[0]); const gy = tileOf(goalPx[1]);
  const sx = tileOf(me.x); const sy = tileOf(me.y);
  const block = blocked || new Set();

  if (!haveMap(z)) {
    // No collision data -> greedy sign step (legacy behaviour).
    return [Math.sign(goalPx[0] - me.x), Math.sign(goalPx[1] - me.y)];
  }
  if (sx === gx && sy === gy) return [0, 0];

  const cache = bot.run.path;
  const sameGoal = cache && cache.goalX === gx && cache.goalY === gy;
  let need = !sameGoal || !cache.tiles || !cache.tiles.length;

  // A FAILED search is worth remembering. An unreachable goal expands the whole
  // connected region (~7.6k tiles on the surface) and yields []; without this,
  // the empty `tiles` re-triggers the search on the very next tick and we pay
  // that cost 10x a second for as long as the goal stays unreachable. Retry on a
  // timer instead -- the world does change (a player blocking a doorway moves).
  if (need && sameGoal && cache.failedAt !== undefined
      && !cache.tiles.length
      && (performance.now() - cache.failedAt) < UNREACHABLE_RETRY_MS
      && cache.startX === sx && cache.startY === sy) {
    need = false;
  }

  if (!need && cache.tiles.length) {
    const nxt = cache.tiles[0];
    // Off-path? (we got shoved, or a step didn't land) -> repath.
    if (Math.max(Math.abs(sx - nxt[0]), Math.abs(sy - nxt[1])) > repathTiles) {
      need = true;
    } else if (cache.tiles.slice(0, 2).some((t) => block.has(key(t[0], t[1])))) {
      // A player stepped onto our planned next tile -> repath around them.
      need = true;
    }
  }
  if (need) {
    const tiles = findPath(z, [sx, sy], [gx, gy], block);
    bot.run.path = { goalX: gx, goalY: gy, tiles };
    if (!tiles.length) {
      // Remember where we failed from: moving to a new tile is new information,
      // so a failure from a different start should search again immediately.
      bot.run.path.failedAt = performance.now();
      bot.run.path.startX = sx;
      bot.run.path.startY = sy;
    }
  }

  const tiles = bot.run.path.tiles;
  if (!tiles || !tiles.length) {
    // Unreachable -> nudge toward the goal so we at least press in its
    // direction (a goal behind a wall is often reachable once we've moved).
    // Routed through safeStep: an unguarded nudge is exactly the case that
    // walks into the wall separating us from the goal and stays there.
    return safeStep(z, sx, sy,
      Math.sign(goalPx[0] - me.x), Math.sign(goalPx[1] - me.y), block);
  }
  // Consume tiles we've already reached.
  while (tiles.length && tiles[0][0] === sx && tiles[0][1] === sy) tiles.shift();
  if (!tiles.length) return [0, 0];
  const [nx, ny] = tiles[0];

  // Steer toward the CENTRE of the next tile in pixel space, not a raw tile
  // sign. When the bot straddles a tile boundary next to a wall corner, a raw
  // sign-step can clip the wall and net zero movement; aiming at the tile centre
  // pulls it into the lane first, so it clears the corner. We still emit dx,dy
  // in {-1,0,1} (the only move the protocol has), just computed from the
  // sub-tile offset rather than from whole tiles.
  const tcx = nx * TILE;                 // server tiles are round(px/TILE)-based
  const tcy = ny * TILE;
  const eps = TILE * 0.2;
  const dx = (tcx - me.x > eps ? 1 : 0) - (tcx - me.x < -eps ? 1 : 0);
  const dy = (tcy - me.y > eps ? 1 : 0) - (tcy - me.y < -eps ? 1 : 0);
  return safeStep(z, sx, sy, dx, dy, block);
}

/**
 * Never command a move that walks straight into a wall, or onto a tile another
 * player occupies. On a blocked diagonal -- including one that merely clips a
 * wall corner -- fall back to whichever single axis is free.
 *
 * This is the last line of defence: A* plans over tiles, but we move in pixels,
 * so between plan and step the bot can end up commanding a diagonal that shaves
 * a corner and nets zero movement. Without this it reads as "the bot froze
 * against a tree".
 */
export function safeStep(z, sx, sy, dx, dy, blocked = new Set()) {
  if (dx === 0 && dy === 0) return [0, 0];
  const diagonalClips = dx && dy
    && !(free(z, sx + dx, sy, blocked) && free(z, sx, sy + dy, blocked));
  if (free(z, sx + dx, sy + dy, blocked) && !diagonalClips) return [dx, dy];
  if (dx && free(z, sx + dx, sy, blocked)) return [dx, 0];
  if (dy && free(z, sx, sy + dy, blocked)) return [0, dy];
  return [0, 0];
}
