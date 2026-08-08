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

// ---- hunting grounds ------------------------------------------------------
//
// Choosing where to farm from the client's own spawn table. The failure mode
// this guards is not a crash: it is a plausible-looking spot that is deep in
// hell, unreachable, or simply empty in daylight -- and the symptom is a bot that
// walks a long way and then dies or roams.

/** Load a multi-floor world of ASCII rows plus spawns/teleports per floor. */
const worldOf = (floors) => nav.loadMaps(Object.fromEntries(
  Object.entries(floors).map(([z, f]) => [z, {
    widthTiles: f.rows[0].length,
    heightTiles: f.rows.length,
    rows: f.rows,
    teleports: f.teleports || [],
    spawns: (f.spawns || []).map((s, i) => ({
      id: s.id ?? `s${z}-${i}`,
      monsterType: s.type,
      tile: s.tile,
      leashTiles: s.leash ?? 5,
      ...(s.nightOnly ? { nightOnly: true } : {}),
    })),
  }])));

const open = (w, h) => Array.from({ length: h }, () => '.'.repeat(w));

test('huntingGrounds only returns spots for the monster asked for', () => {
  worldOf({
    0: { rows: open(20, 20), spawns: [{ type: 'rat', tile: [3, 3] }] },
    '-1': { rows: open(20, 20), spawns: [{ type: 'caveBat', tile: [5, 5] }] },
  });
  const bats = nav.huntingGrounds(['caveBat']);
  assert.equal(bats.length, 1);
  assert.equal(bats[0].z, -1, 'cave bats are downstairs, and that is where it sends us');
  assert.equal(nav.huntingGrounds(['rat'])[0].z, 0);
});

// The core of "identify the caves with good concentration": nearby spawns are one
// spot, so a room of a dozen bats outranks a lone bat somewhere else.
test('nearby spawns cluster into one spot, and the richest ranks first', () => {
  worldOf({
    0: {
      rows: open(60, 60),
      spawns: [
        // A tight room of four.
        { type: 'rat', tile: [10, 10] }, { type: 'rat', tile: [12, 10] },
        { type: 'rat', tile: [11, 12] }, { type: 'rat', tile: [13, 11] },
        // A lone rat far away -- must not merge into the room above.
        { type: 'rat', tile: [50, 50] },
      ],
    },
  });
  const spots = nav.huntingGrounds(['rat']);
  assert.equal(spots.length, 2, 'four adjacent spawns are ONE spot, plus the loner');
  assert.equal(spots[0].count, 4, 'the concentration ranks first');
  assert.equal(spots[1].count, 1);
  // The spot is aimed at the middle of the cluster, not at one arbitrary member.
  assert.ok(spots[0].tile[0] >= 10 && spots[0].tile[0] <= 13, 'centred in x');
  assert.ok(spots[0].tile[1] >= 10 && spots[0].tile[1] <= 12, 'centred in y');
});

// THE policy test. The bundle's richest caveBat cluster really is on z=-4, past
// two bosses, and the issue's character cannot survive the trip. Depth has to
// outweigh a spawn or two, or the bot marches a level-1 character into hell.
test('a slightly richer spot several floors down loses to a shallow one', () => {
  worldOf({
    0: { rows: open(30, 30), spawns: [] },
    '-1': {
      rows: open(30, 30),
      spawns: [{ type: 'caveBat', tile: [5, 5] }, { type: 'caveBat', tile: [6, 6] },
        { type: 'caveBat', tile: [7, 5] }],
    },
    '-4': {
      rows: open(30, 30),
      spawns: [{ type: 'caveBat', tile: [5, 5] }, { type: 'caveBat', tile: [6, 6] },
        { type: 'caveBat', tile: [7, 5] }, { type: 'caveBat', tile: [5, 7] },
        { type: 'caveBat', tile: [7, 7] }],
    },
  });
  const best = nav.huntingGrounds(['caveBat'])[0];
  assert.equal(best.z, -1,
    'five bats through hell is not worth more than three one ladder down');
});

// Wraiths are nightOnly, so by day their room is empty. Sending the bot there is
// a long walk to nothing.
test('night-only spawns are excluded unless asked for', () => {
  worldOf({
    0: {
      rows: open(20, 20),
      spawns: [{ type: 'wraith', tile: [5, 5], nightOnly: true }],
    },
  });
  assert.equal(nav.huntingGrounds(['wraith']).length, 0, 'empty by day');
  assert.equal(nav.huntingGrounds(['wraith'], { night: true }).length, 1);
});

test('a monster with no spawns anywhere yields no spots rather than throwing', () => {
  worldOf({ 0: { rows: open(20, 20), spawns: [{ type: 'rat', tile: [3, 3] }] } });
  assert.deepEqual(nav.huntingGrounds(['ghost']), [],
    'ghost is a known monster type with no spawn points in the bundle');
});

// The centre of a ring of spawns is very often the rock they are arranged around.
// An unreachable goal makes A* fail on every tick, so the spot must be snapped
// onto ground we can actually stand on.
test('a spot whose centre is a wall snaps to walkable ground', () => {
  worldOf({
    0: {
      rows: ['.......', '.......', '..###..', '..###..', '..###..', '.......', '.......'],
      // Four spawns arranged around the 3x3 rock, centring on (3,3) -- a wall.
      spawns: [{ type: 'rat', tile: [1, 3] }, { type: 'rat', tile: [5, 3] },
        { type: 'rat', tile: [3, 1] }, { type: 'rat', tile: [3, 5] }],
    },
  });
  const spot = nav.huntingGrounds(['rat'])[0];
  assert.ok(nav.walkable(0, spot.tile[0], spot.tile[1]),
    `spot ${spot.tile} must be standable, not inside the rock`);
});

// Which hole to take is not just "the nearest": the floors are 120x112 and their
// holes are far apart, so descending by the closest one can land us across the
// map from the prey.
test('bestTeleportToward weighs the walk down there, not just the walk to it', () => {
  nav.loadMaps({
    0: {
      widthTiles: 100,
      heightTiles: 100,
      rows: open(100, 100),
      teleports: [
        // Very close to us, but lands far from the goal.
        { fromTile: [2, 2], toTile: [2, 2], toZ: -1, oneWay: false, mode: 'walk' },
        // A bit further to reach, but lands right next to the goal.
        { fromTile: [20, 20], toTile: [88, 88], toZ: -1, oneWay: false, mode: 'walk' },
      ],
      spawns: [],
    },
  });
  const tp = nav.bestTeleportToward(0, -1, [0, 0], [90, 90]);
  assert.deepEqual(tp.fromTile, [20, 20],
    'the hole that lands next to the prey wins, despite being further away');
  // And the nearest-hole query is unchanged, since intermediate floors still use it.
  assert.deepEqual(nav.nearestTeleport(0, -1, [0, 0]).fromTile, [2, 2]);
});

test('bestTeleportToward returns null when no teleport reaches that floor', () => {
  nav.loadMaps({
    0: { widthTiles: 10, heightTiles: 10, rows: open(10, 10), teleports: [], spawns: [] },
  });
  assert.equal(nav.bestTeleportToward(0, -1, [0, 0], [5, 5]), null);
});

// The floors are not connected regions, and this is the trap that follows from
// it: z=-1 really does hold a bat cave around the 58,22 entrance and a separate
// orc den reachable only via the hole at 20,78, with no path between them.
// Ranking holes by distance alone sends the bot down the NEAREST one and leaves
// A* with a goal on the wrong side of solid rock -- so it walks to the wrong cave
// and roams, which is the very symptom this feature exists to remove.
test('bestTeleportToward skips a nearer hole that cannot reach the goal', () => {
  // Two sealed corridors on z=-1, each fed by its own hole from z=0.
  nav.loadMaps({
    0: {
      widthTiles: 12,
      heightTiles: 12,
      rows: open(12, 12),
      teleports: [
        // Nearest to us, but it lands in the corridor WITHOUT the goal.
        { fromTile: [1, 1], toTile: [1, 1], toZ: -1, oneWay: false, mode: 'walk' },
        // Further away, and the only hole whose corridor contains the goal.
        { fromTile: [9, 1], toTile: [1, 9], toZ: -1, oneWay: false, mode: 'walk' },
      ],
      spawns: [],
    },
    '-1': {
      widthTiles: 12,
      heightTiles: 12,
      rows: [
        '............',   // y=0
        '............',   // y=1  <- corridor A, fed by the 1,1 hole
        '############',   // y=2  solid rock: no way between the two
        '############',
        '############',
        '############',
        '############',
        '############',
        '############',   // y=8
        '............',   // y=9  <- corridor B, fed by the 9,1 hole
        '............',
        '............',
      ],
      teleports: [],
      spawns: [],
    },
  });
  const goal = [8, 9];                 // in corridor B
  assert.deepEqual(nav.nearestTeleport(0, -1, [0, 0]).fromTile, [1, 1],
    'the 1,1 hole really is the nearest one');
  const tp = nav.bestTeleportToward(0, -1, [0, 0], goal);
  assert.deepEqual(tp.fromTile, [9, 1],
    'it must take the further hole, because the nearer one lands in sealed rock');
});

// A hole that reaches nothing must still beat refusing to move: a missing map or
// an A* budget overrun should not strand the bot on the surface forever.
test('bestTeleportToward still returns a hole when none can reach the goal', () => {
  nav.loadMaps({
    0: {
      widthTiles: 10,
      heightTiles: 10,
      rows: open(10, 10),
      teleports: [{ fromTile: [1, 1], toTile: [1, 1], toZ: -1, oneWay: false, mode: 'walk' }],
      spawns: [],
    },
    '-1': {
      widthTiles: 10,
      heightTiles: 10,
      // Everything walled off except the landing tile itself.
      rows: ['##########', '#.########', '##########', '##########', '##########',
        '##########', '##########', '##########', '##########', '##########'],
      teleports: [],
      spawns: [],
    },
  });
  const tp = nav.bestTeleportToward(0, -1, [0, 0], [8, 8]);
  assert.ok(tp, 'descending imperfectly beats not descending at all');
  assert.deepEqual(tp.fromTile, [1, 1]);
});
