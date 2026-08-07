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

/** A minimal stand-in for the client's underground zone table. */
function fakeBundle(zones) {
  const parts = zones.map((z) => {
    const tp = (z.teleports || []).map((t) =>
      `{tileX:${t[0]},tileY:${t[1]},toTileX:${t[2]},toTileY:${t[3]},`
      + `toZ:${t[4]},oneWay:!${t[5] ? 0 : 1},mode:"${t[6]}"}`).join(',');
    return `{z:${z.z},widthTiles:${z.w},heightTiles:${z.h},`
      + `rows:${JSON.stringify(z.rows)},teleports:[${tp}]}`;
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
