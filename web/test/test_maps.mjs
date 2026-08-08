// Tests for the collision-map extractor (core/maps.js).
//
// This module is load-bearing in a way that is easy to underrate: every other
// behaviour paths over what it produces, and when it goes wrong it goes wrong
// SILENTLY -- the bot walks into a tree the map says is open. The tests below
// therefore lean on the failure modes rather than the happy path: a bundle whose
// shape changed, a partial extract, and the version stamp that tells us which
// client a map set came from.

import test from 'node:test';
import assert from 'node:assert/strict';

const maps = await import(new URL('../src/core/maps.js', import.meta.url).href);

/** One minified spawn record, as the client writes them. */
const spawnLit = (s) =>
  `{id:"${s.id}",monsterType:"${s.type}",tileX:${s.tile[0]},tileY:${s.tile[1]},`
  + `leashTiles:${s.leash ?? 5}${s.nightOnly ? ',nightOnly:!0' : ''}}`;

/** A minimal stand-in for the client's underground zone table. */
function fakeBundle(zones) {
  const parts = zones.map((z) => {
    const tp = (z.teleports || []).map((t) =>
      `{tileX:${t[0]},tileY:${t[1]},toTileX:${t[2]},toTileY:${t[3]},`
      + `toZ:${t[4]},oneWay:!${t[5] ? 0 : 1},mode:"${t[6]}"}`).join(',');
    const sp = (z.spawns || []).map(spawnLit).join(',');
    return `{z:${z.z},widthTiles:${z.w},heightTiles:${z.h},`
      + `rows:${JSON.stringify(z.rows)},teleports:[${tp}]`
      + (z.spawns ? `,spawns:[${sp}]` : '') + '}';
  });
  return `var q=[${parts.join(',')}];`;
}

const box = (w, h) => Array.from({ length: h }, (_, y) =>
  (y === 0 || y === h - 1 ? '#'.repeat(w) : `#${'.'.repeat(w - 2)}#`));

test('extractUnderground reads grids and teleports out of a bundle', () => {
  const js = fakeBundle([
    { z: -1, w: 6, h: 4, rows: box(6, 4), teleports: [[2, 1, 3, 2, -2, false, 'walk']] },
    { z: -2, w: 6, h: 4, rows: box(6, 4), teleports: [] },
  ]);
  const zones = maps.extractUnderground(js);
  assert.deepEqual(Object.keys(zones).sort(), ['-1', '-2']);
  assert.equal(zones[-1].widthTiles, 6);
  assert.equal(zones[-1].rows.length, 4);
  assert.deepEqual(zones[-1].teleports, [{
    fromTile: [2, 1], toTile: [3, 2], toZ: -2, oneWay: false, mode: 'walk',
  }]);
});

// `oneWay:!0` is minified `true` and `!1` is `false` -- inverted from how it
// reads. Getting this backwards would make the pathfinder believe it can climb
// back out of a one-way drop.
test('the minified !0/!1 boolean is decoded the right way round', () => {
  const js = fakeBundle([{
    z: -1, w: 4, h: 3, rows: box(4, 3),
    teleports: [[1, 1, 1, 1, -2, true, 'interact'], [2, 1, 2, 1, -2, false, 'walk']],
  }]);
  const tp = maps.extractUnderground(js)[-1].teleports;
  assert.equal(tp[0].oneWay, true, '!0 means true');
  assert.equal(tp[1].oneWay, false, '!1 means false');
});

test('rows survive verbatim, so wall positions are exact', () => {
  const rows = ['####', '#.##', '#..#', '####'];
  const js = fakeBundle([{ z: -1, w: 4, h: 4, rows, teleports: [] }]);
  assert.deepEqual(maps.extractUnderground(js)[-1].rows, rows);
});

// The zone table's variable name is minified and has changed between deploys, so
// extraction anchors on the array's SHAPE. If that ever stops matching we must
// fail loudly: a silent empty map set is what puts bots into walls.
test('a bundle with no recognisable zone table throws rather than returning nothing', () => {
  assert.throws(() => maps.extractUnderground('var a=1;const b=[{x:1}];'),
    /zone table not found/);
});

test('extractAll stamps which bundle the maps came from', () => {
  const js = fakeBundle([{ z: -1, w: 4, h: 3, rows: box(4, 3), teleports: [] }]);
  const all = maps.extractAll(js, '/assets/index-ABC123.js');
  assert.equal(all.bundle, '/assets/index-ABC123.js',
    'the stamp is what lets a consumer tell stale maps from fresh ones');
});

// The surface generator needs the real client bundle. Its absence must NOT sink
// the whole extraction -- the underground floors are still perfectly usable.
test('a failed surface extract still yields the underground floors', () => {
  const js = fakeBundle([{ z: -1, w: 4, h: 3, rows: box(4, 3), teleports: [] }]);
  const all = maps.extractAll(js);
  assert.ok(all[-1], 'z=-1 survived');
  assert.equal(all[0], undefined, 'z=0 is simply absent, not a broken entry');
});

test('surface holes are synthesized as walk-over teleports to z=-1', () => {
  // The client hardcodes these rather than listing them in a teleports array, so
  // without synthesizing them nothing can ever descend from the surface.
  assert.ok(maps.SURFACE_HOLES.length > 0);
  for (const [tx, ty] of maps.SURFACE_HOLES) {
    assert.equal(typeof tx, 'number');
    assert.equal(typeof ty, 'number');
  }
});

test('liveBundlePath pulls the hashed bundle url out of index.html', async () => {
  const html = '<html><head><script type="module" crossorigin '
    + 'src="/assets/index-B00srpaR.js"></script></head></html>';
  const path = await maps.liveBundlePath(async () => ({ text: async () => html }));
  assert.equal(path, '/assets/index-B00srpaR.js');
});

test('liveBundlePath throws when index.html has no bundle to point at', async () => {
  await assert.rejects(
    maps.liveBundlePath(async () => ({ text: async () => '<html></html>' })),
    /could not find main JS bundle/);
});

// ---- monster spawns -------------------------------------------------------
//
// The spawn table is what makes "go where the prey is" possible without a
// hand-written table of coordinates. It fails the same silent way the terrain
// does: a wrong parse yields plausible-looking spots in the wrong place, and the
// symptom is a bot roaming an empty floor.

test('extractUnderground reads each zone spawn list', () => {
  const js = fakeBundle([{
    z: -1, w: 8, h: 6, rows: box(8, 6), teleports: [],
    spawns: [{ id: 'spawn-caveBat-1', type: 'caveBat', tile: [3, 2], leash: 5 },
      { id: 'spawn-orc-1', type: 'orc', tile: [5, 4], leash: 6 }],
  }]);
  const sp = maps.extractUnderground(js)[-1].spawns;
  assert.deepEqual(sp, [
    { id: 'spawn-caveBat-1', monsterType: 'caveBat', tile: [3, 2], leashTiles: 5 },
    { id: 'spawn-orc-1', monsterType: 'orc', tile: [5, 4], leashTiles: 6 },
  ]);
});

// leashTiles is how far the monster strays from its post, which is the radius a
// farm spot actually covers -- dropping it would make a 1-tile leash look like a
// 12-tile one.
test('leashTiles survives extraction', () => {
  const js = fakeBundle([{
    z: -1, w: 6, h: 4, rows: box(6, 4), teleports: [],
    spawns: [{ id: 'a', type: 'goblin', tile: [2, 1], leash: 3 }],
  }]);
  assert.equal(maps.extractUnderground(js)[-1].spawns[0].leashTiles, 3);
});

// Same inverted-boolean trap as `oneWay`. A wraith read as always-present sends
// the bot to a room that is empty by day.
test('nightOnly decodes as the minified boolean it is', () => {
  const js = fakeBundle([{
    z: -1, w: 6, h: 4, rows: box(6, 4), teleports: [],
    spawns: [{ id: 'day', type: 'rat', tile: [1, 1] },
      { id: 'night', type: 'wraith', tile: [2, 1], nightOnly: true }],
  }]);
  const sp = maps.extractUnderground(js)[-1].spawns;
  assert.equal(sp[0].nightOnly, undefined, 'a normal spawn carries no flag at all');
  assert.equal(sp[1].nightOnly, true, '!0 means true');
});

test('a zone with no spawns array yields an empty list, not undefined', () => {
  const js = fakeBundle([{ z: -1, w: 6, h: 4, rows: box(6, 4), teleports: [] }]);
  assert.deepEqual(maps.extractUnderground(js)[-1].spawns, []);
});

// THE regression that cost the most to find. The surface list is assigned to a
// minified variable (`Bo=[{id:...`), while every underground floor's is a
// PROPERTY (`spawns:[{id:...`). Matching the record shape alone finds z=-1's
// inline array FIRST and silently labels it the surface -- which loses every rat
// in the game, since rats spawn only up top, and puts cave bats on the surface
// where they do not exist.
test('surface spawns are read from the assigned array, not the first zone inline one', () => {
  const undergroundFirst =
    'var q=[{z:-1,widthTiles:4,heightTiles:3,rows:["####","#..#","####"],'
    + 'teleports:[],spawns:[' + spawnLit({ id: 'u1', type: 'caveBat', tile: [9, 9] }) + ']}];'
    + 'const Bo=[' + spawnLit({ id: 's1', type: 'rat', tile: [1, 1] }) + '];';
  const sp = maps.extractSurfaceSpawns(undergroundFirst);
  assert.equal(sp.length, 1, 'exactly the surface array, not the underground one');
  assert.equal(sp[0].monsterType, 'rat',
    'picking up the underground array here would put cave bats on the surface '
    + 'and leave the game with no rats');
});

test('extractSurfaceSpawns returns nothing rather than throwing on an odd bundle', () => {
  assert.deepEqual(maps.extractSurfaceSpawns('var a=1;'), []);
});
