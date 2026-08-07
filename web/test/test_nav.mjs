// Navigation tests: the wall-clipping guards that A* alone does not provide.
//
// A* plans over whole TILES, but movement happens in PIXELS. Everything here
// covers the gap between those two facts -- the place where a plan that is
// perfectly valid tile-by-tile still produces a step that shaves a wall corner
// and nets zero movement. That failure presents as "the bot froze against a
// tree", which is expensive to diagnose and was the reason A* was introduced in
// the first place.

import test from 'node:test';
import assert from 'node:assert/strict';

const SRC = new URL('../src/core/', import.meta.url);
const nav = await import(new URL('nav.js', SRC).href);
const { TILE } = await import(new URL('protocol.js', SRC).href);

/** Load a map from ASCII rows ('#' blocked). */
const mapOf = (rows) => nav.loadMaps({
  0: { widthTiles: rows[0].length, heightTiles: rows.length, rows, teleports: [] },
});

const at = (tx, ty) => ({ x: tx * TILE, y: ty * TILE });

test('safeStep refuses to walk straight into a wall', () => {
  mapOf(['...', '.#.', '...']);
  assert.deepEqual(nav.safeStep(0, 1, 0, 0, 1), [0, 0],
    'south is a wall, and no single axis is a better answer');
});

// The subtle one: BOTH orthogonals are walls, so the diagonal "fits" between
// them tile-wise but clips the corner in pixel space and nets zero movement.
test('safeStep rejects a diagonal that clips a wall corner', () => {
  mapOf(['..#', '.#.', '...']);   // (2,0) and (1,1) blocked
  assert.deepEqual(nav.safeStep(0, 1, 0, 1, 1), [0, 0],
    'the NE/SE pair is blocked, so the diagonal must not be commanded');
});

test('safeStep falls back to whichever single axis is free', () => {
  mapOf(['...', '..#', '...']);   // (2,1) blocked
  // Want SE from (1,1): the diagonal target (2,2) is open but we check the
  // orthogonals -- (2,1) is a wall, so it must fall back to the free axis.
  const step = nav.safeStep(0, 1, 1, 1, 1);
  assert.deepEqual(step, [0, 1], 'drops the blocked x component, keeps y');
});

test('safeStep treats other players as walls (dynamic obstacles)', () => {
  mapOf(['...', '...', '...']);
  const occupied = new Set([nav.tileKey(1, 1)]);
  assert.deepEqual(nav.safeStep(0, 1, 0, 0, 1, occupied), [0, 0],
    'a tile someone stands on is not a legal step');
});

test('safeStep passes a clear step through untouched', () => {
  mapOf(['...', '...', '...']);
  assert.deepEqual(nav.safeStep(0, 1, 1, 1, 0), [1, 0]);
  assert.deepEqual(nav.safeStep(0, 0, 0, 1, 1), [1, 1], 'a clear diagonal is fine');
});

test('safeStep on a zero vector is a no-op', () => {
  mapOf(['...', '...', '...']);
  assert.deepEqual(nav.safeStep(0, 1, 1, 0, 0), [0, 0]);
});

// Centre steering: when the bot straddles a tile boundary, aim at the next
// tile's CENTRE rather than emitting a raw tile-to-tile sign. Without it the
// step can clip the corner it is trying to round.
test('pathStep steers toward the next tile centre, not a raw tile sign', () => {
  mapOf(['.....', '.....', '.....', '.....', '.....']);
  const bot = { run: {} };
  // Sitting slightly PAST the centre of tile (1,1) in x, heading east to (3,1).
  // Raw sign of (2-1) would be +1 in x and 0 in y; centre steering agrees here,
  // but the y component must be 0 because we're already on the tile's y centre.
  const me = { x: 1 * TILE + 4, y: 1 * TILE };
  const step = nav.pathStep(bot, me, 0, [3 * TILE, 1 * TILE]);
  assert.equal(step[1], 0, 'no spurious vertical drift when already in the lane');
  assert.equal(step[0], 1, 'still advances east');
});

test('centre steering has a deadband so tiny offsets do not jitter', () => {
  mapOf(['.....', '.....', '.....', '.....', '.....']);
  const bot = { run: {} };
  // Within TILE*0.2 of the target tile's centre in y -> that axis must read 0
  // rather than flapping between -1 and 1 on sub-pixel noise.
  const me = { x: 1 * TILE, y: 1 * TILE + TILE * 0.1 };
  const step = nav.pathStep(bot, me, 0, [3 * TILE, 1 * TILE]);
  assert.equal(step[1], 0, 'inside the deadband, so no vertical correction');
});

// An unreachable goal used to return a raw greedy nudge, which walks straight
// into the wall separating us from the goal and stays there.
test('an unreachable goal never commands a step into a wall', () => {
  // A sealed 1-tile room at (1,1); the goal sits outside it.
  mapOf(['#####', '#...#', '#.#.#', '#...#', '#####']);
  const bot = { run: {} };
  const step = nav.pathStep(bot, { x: 1 * TILE, y: 1 * TILE }, 0, [10 * TILE, 10 * TILE]);
  const [dx, dy] = step;
  if (dx || dy) {
    assert.ok(nav.walkable(0, 1 + dx, 1 + dy),
      `stepped into a wall at (${1 + dx},${1 + dy})`);
  }
});

test('a failed search is not re-run every tick', () => {
  mapOf(['###', '#.#', '###']);   // (1,1) walled in on all sides
  const bot = { run: {} };
  const me = at(1, 1);
  nav.pathStep(bot, me, 0, [10 * TILE, 10 * TILE]);
  assert.ok(bot.run.path, 'the failure is remembered');
  assert.ok(bot.run.path.failedAt != null,
    'with a timestamp, so the whole region is not re-expanded at 10 Hz');
});

test('with no map at all, movement degrades to greedy rather than stopping', () => {
  nav.loadMaps({});
  const step = nav.pathStep({ run: {} }, { x: 0, y: 0 }, 3, [10 * TILE, 0]);
  assert.deepEqual(step, [1, 0], 'an unknown zone must not freeze the bot');
});
