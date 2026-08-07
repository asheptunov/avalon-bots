// Collision-map extraction from the game client. Port of extract_maps.py +
// extract_z0.js, unified so Node and the browser share one implementation.
//
// The server never sends terrain. The client carries it: z=-1..-6 are ASCII
// grids baked into the bundle, and z=0 (surface) is PROCEDURAL -- generated at
// runtime from seeded noise plus object footprints. So there are two extraction
// paths, and both must agree bit-for-bit with what the client walks on, because
// A* over a map that disagrees walks the bot into a tree the map thinks is open.
//
// Why not re-implement worldgen? Because a re-port diverges the moment the game
// tweaks a noise constant, and it diverges SILENTLY. Instead we execute the
// client's own generator -- in Node by slicing it out of the fetched bundle, in
// the browser by simply asking the page, which already ran it.
//
// Everything here matches by STRUCTURE, never by minified name: the minifier
// renames every symbol on each build (`ko[xn(e)]=Fh(e)` became `Ys[gn(e)]=Zf(e)`
// between two deploys), and name-matching meant extraction broke silently on the
// next redeploy.

export const INDEX_URL = 'https://avalon.juanandresleon.com/';
const BUNDLE_RE = /src="(\/assets\/index-[^"]+\.js)"/;

// Surface holes are hardcoded in the client (the `pa` list, all mode:"walk" ->
// z=-1) rather than living in a `teleports` array like the underground floors.
// Each descends to z=-1 at the same tile (the client sets toTile=fromTile).
export const SURFACE_HOLES = [
  [58, 22], [20, 78], [101, 8], [103, 101], [82, 99], [62, 99],
];

// ---- generic bundle parsing ------------------------------------------------

/** Index of the char just past the bracket group opened at `openAt`. */
function matchBracket(s, openAt, opener = '[', closer = ']') {
  let depth = 0;
  for (let j = openAt; j < s.length; j++) {
    if (s[j] === opener) depth++;
    else if (s[j] === closer && --depth === 0) return j + 1;
  }
  throw new Error('unbalanced bracket');
}

/**
 * Split a rows array literal of plain double-quoted ASCII strings. Done by hand
 * rather than by regex: these lines are 120+ chars and a naive quoted-string
 * pattern backtracks pathologically over them.
 */
function parseRows(arrLiteral) {
  const inner = arrLiteral.slice(arrLiteral.indexOf('[') + 1, arrLiteral.lastIndexOf(']'));
  const rows = [];
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === '"') {
      const j = inner.indexOf('"', i + 1);
      rows.push(inner.slice(i + 1, j));
      i = j + 1;
    } else i++;
  }
  return rows;
}

function parseTeleports(lit) {
  const re = /\{tileX:(-?\d+),tileY:(-?\d+),toTileX:(-?\d+),toTileY:(-?\d+),toZ:(-?\d+),oneWay:!(\d),mode:"(walk|interact)"\}/g;
  const out = [];
  for (const m of lit.matchAll(re)) {
    out.push({
      fromTile: [+m[1], +m[2]],
      toTile: [+m[3], +m[4]],
      toZ: +m[5],
      oneWay: m[6] === '0',        // !0 === true, !1 === false
      mode: m[7],                  // walk = hole, interact = ladder
    });
  }
  return out;
}

/** Underground zones (z=-1..-6): ASCII grids + teleports, baked into the bundle. */
export function extractUnderground(js) {
  // The zone table's variable name has changed across builds (was `const ui=`),
  // so anchor on the array's shape instead.
  const m = /\[\{z:-?\d+,widthTiles:/.exec(js);
  if (!m) throw new Error('zone table not found in bundle (layout changed?)');
  const lit = js.slice(m.index, matchBracket(js, m.index));

  const zones = {};
  const zoneRe = /\{z:(-?\d+),widthTiles:(\d+),heightTiles:(\d+),rows:/g;
  for (const zm of lit.matchAll(zoneRe)) {
    const z = +zm[1], w = +zm[2], h = +zm[3];
    const rowsOpen = lit.indexOf('[', zm.index + zm[0].length);
    const rowsEnd = matchBracket(lit, rowsOpen);
    const rows = parseRows(lit.slice(rowsOpen, rowsEnd));
    if (rows.length !== h) {
      console.warn(`  warn: z=${z} parsed ${rows.length} rows, header says ${h}`);
    }
    // Teleports for this zone follow the rows array, before the next `{z:`.
    const nxt = lit.indexOf('{z:', zm.index + zm[0].length);
    const seg = lit.slice(rowsEnd, nxt >= 0 ? nxt : lit.length);
    let tp = [];
    const tm = /teleports:\[/.exec(seg);
    if (tm) {
      const o = seg.indexOf('[', tm.index);
      tp = parseTeleports(seg.slice(o, matchBracket(seg, o)));
    }
    zones[z] = { widthTiles: w, heightTiles: h, rows, teleports: tp };
  }
  return zones;
}

/**
 * Surface (z=0) by running the client's OWN worldgen slice.
 *
 * The whole worldgen region is DOM-free and touches none of the pixi imports, so
 * it executes as-is once we (1) cut the leading pixi import and DOM bootstrap
 * IIFE, (2) stub the unused pixi names, and (3) call the zone-grid assembler.
 */
export function extractSurface(js) {
  const importEnd = js.indexOf(';', js.indexOf('from"./pixi')) + 1;

  // Walk the bootstrap IIFE's parens to find where it ends.
  let sliceStart = -1, depth = 0;
  const i = js.indexOf('(function(){', importEnd);
  for (let j = i; j < js.length; j++) {
    if (js[j] === '(') depth++;
    else if (js[j] === ')' && --depth === 0) { sliceStart = js.indexOf(';', j) + 1; break; }
  }

  // `const <OFF>=8,<IDX>=e=>e+<OFF>,<ZONES>=[];for(const e of[...])<ZONES>[<IDX>(e)]=<ASSEMBLE>(e);`
  const initRe = /const ([A-Za-z$_][\w$]*)=8,([A-Za-z$_][\w$]*)=e=>e\+\1,([A-Za-z$_][\w$]*)=\[\];for\(const e of\[[^\]]*\]\)\3\[\2\(e\)\]=([A-Za-z$_][\w$]*)\(e\);/;
  const m = initRe.exec(js);
  if (sliceStart < 0 || !m) {
    throw new Error('could not locate the worldgen zone-init loop; bundle layout changed');
  }
  const assemble = m[4];
  const slice = js.slice(sliceStart, m.index + m[0].length);

  const importDecl = js.slice(0, importEnd);
  const pixiNames = [...importDecl.matchAll(/ as ([A-Za-z$_][A-Za-z0-9$_]*)/g)].map((x) => x[1]);
  const stubs = pixiNames.map((n) => `var ${n}=function(){};`).join('');

  // eslint-disable-next-line no-new-func
  const run = new Function(`"use strict";${stubs}\n${slice}\nreturn ${assemble}(0);`);
  const grid = run();

  const { widthTiles: w, heightTiles: h, walkable } = grid;
  const rows = [];
  for (let y = 0; y < h; y++) {
    let r = '';
    for (let x = 0; x < w; x++) r += walkable[y * w + x] === 1 ? '.' : '#';
    rows.push(r);
  }
  return { z: 0, widthTiles: w, heightTiles: h, rows };
}

/** Assemble the full {z -> zone} map set (plus a `bundle` version stamp). */
export function extractAll(js, bundleStamp = null) {
  const zones = extractUnderground(js);
  let surface = null;
  try {
    surface = extractSurface(js);
  } catch (e) {
    console.warn(`  warn: z=0 extract failed (${e.message}); skipping surface`);
  }
  if (surface) {
    zones[0] = {
      widthTiles: surface.widthTiles,
      heightTiles: surface.heightTiles,
      rows: surface.rows,
      teleports: SURFACE_HOLES.map(([tx, ty]) => ({
        fromTile: [tx, ty], toTile: [tx, ty], toZ: -1, oneWay: false, mode: 'walk',
      })),
    };
  }
  // The bundle filename hash changes on every deploy, so it doubles as the
  // version stamp that lets a consumer notice its maps are stale.
  if (bundleStamp) zones.bundle = bundleStamp;
  return zones;
}

// ---- fetching (Node / anywhere with fetch) ---------------------------------

/** The bundle path index.html currently points at, e.g. '/assets/index-B5Z.js'. */
export async function liveBundlePath(fetchImpl = fetch) {
  const r = await fetchImpl(INDEX_URL);
  const html = await r.text();
  const m = BUNDLE_RE.exec(html);
  if (!m) throw new Error('could not find main JS bundle in index.html');
  return m[1];
}

/** Fetch the live client and extract every map from it. */
export async function extractFromLive(fetchImpl = fetch) {
  const path = await liveBundlePath(fetchImpl);
  const r = await fetchImpl(INDEX_URL.replace(/\/$/, '') + path);
  const js = await r.text();
  return extractAll(js, path);
}
