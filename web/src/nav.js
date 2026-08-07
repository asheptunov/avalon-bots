// Grid navigation: A* over the extracted collision maps. Port of avalon_nav.py.
//
// The maps come from extract_maps.py (avalon_maps.json), embedded into the
// userscript at build time -- one ASCII grid per z-level where '#' is blocked.
// That grid is bit-exact with what the server enforces, so A* over it yields
// real paths around walls.
//
// Note the map is GENERATED from the client bundle. The Python side re-extracts
// when the game ships a new client (refresh_maps_if_stale); here we can't run
// the extractor, so a game redeploy can silently stale the map. `mapBundle()`
// exposes the stamp we were built from; main.js compares it against the bundle
// the page is actually running and warns on a mismatch.

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
    // Unreachable -> greedy nudge, so we at least press toward the goal.
    return [Math.sign(goalPx[0] - me.x), Math.sign(goalPx[1] - me.y)];
  }
  // Consume tiles we've already reached.
  while (tiles.length && tiles[0][0] === sx && tiles[0][1] === sy) tiles.shift();
  if (!tiles.length) return [0, 0];
  const [nx, ny] = tiles[0];
  return [Math.sign(nx - sx), Math.sign(ny - sy)];
}
