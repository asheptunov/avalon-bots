// Runs the Avalon client's OWN worldgen slice headless to dump the z=0 surface
// collision grid -- faithful parity with the browser, not a re-port.
//
// The z=0 map is procedural (`Vl=Np(seed...)` + object footprints -> the `au`
// blocked-tile set -> a Uint8Array `walkable`). Rather than reimplement seeded
// terrain noise in Python (which would diverge), we lift the exact generation
// code out of the bundle and execute it. The whole worldgen region is DOM-free
// and uses none of the pixi imports, so it runs as-is once we:
//   1. strip the leading `import{...}from"./pixi..."` + the DOM bootstrap IIFE,
//   2. provide harmless stubs for the (unused) pixi import names,
//   3. call Fh(0) -- the client's zone-grid assembler -- and print JSON.
//
// Usage: node extract_z0.js <bundle.js>   (prints JSON to stdout)
const fs = require("fs");

const bundlePath = process.argv[2];
if (!bundlePath) { console.error("usage: node extract_z0.js <bundle.js>"); process.exit(2); }
const js = fs.readFileSync(bundlePath, "utf8");

// --- locate the DOM-free worldgen slice -------------------------------------
// Slice starts after the bootstrap IIFE `(function(){...})();` that follows the
// pixi import, and ends after the zone-grid init loop.
//
// The minifier renames every symbol on each rebuild (the loop was
// `ko[xn(e)]=Fh(e)` in one build and `Ys[gn(e)]=Zf(e)` in the next), so we match
// the loop by its STRUCTURE and read the current names out of it. Matching on
// literal names meant a silent break the next time the game shipped: extraction
// failed, the committed map went stale, and bots walked into trees the map said
// were empty.
const importEnd = js.indexOf(";", js.indexOf('from"./pixi')) + 1;
// Walk the bootstrap IIFE parens to find its end.
let i = js.indexOf("(function(){", importEnd), depth = 0, sliceStart = -1;
for (let j = i; j < js.length; j++) {
  if (js[j] === "(") depth++;
  else if (js[j] === ")") { if (--depth === 0) { sliceStart = js.indexOf(";", j) + 1; break; } }
}

// `const <OFF>=8,<IDX>=e=>e+<OFF>,<ZONES>=[];for(const e of[0,...])<ZONES>[<IDX>(e)]=<ASSEMBLE>(e);`
const initRe = /const ([A-Za-z$_][\w$]*)=8,([A-Za-z$_][\w$]*)=e=>e\+\1,([A-Za-z$_][\w$]*)=\[\];for\(const e of\[[^\]]*\]\)\3\[\2\(e\)\]=([A-Za-z$_][\w$]*)\(e\);/;
const m = initRe.exec(js);
if (sliceStart < 0 || !m) {
  console.error("could not locate the worldgen zone-init loop; bundle layout changed");
  process.exit(3);
}
const assemble = m[4];              // the zone-grid assembler, e.g. `Zf`
const sliceEnd = m.index + m[0].length;
const slice = js.slice(sliceStart, sliceEnd);

// --- stub the (unused) pixi import names so references don't ReferenceError --
const importDecl = js.slice(0, importEnd);
const pixiNames = [...importDecl.matchAll(/ as ([A-Za-z$_][A-Za-z0-9$_]*)/g)].map(m => m[1]);
const stubs = pixiNames.map(n => `var ${n}=function(){};`).join("");

// --- run the slice, then dump <assemble>(0) ---------------------------------
// The assembler is a `function`/`const` declaration in the slice scope, so we
// evaluate everything in one function body and read it out at the end.
const program = `
"use strict";
${stubs}
${slice}
;globalThis.__grid = ${assemble}(0);
`;

let grid;
try {
  const run = new Function(program + "\nreturn globalThis.__grid;");
  grid = run();
} catch (e) {
  console.error("worldgen slice failed to execute:", e && e.message);
  process.exit(4);
}

// grid = {widthTiles,heightTiles,walkable:Uint8Array,...}. Emit as ASCII rows
// ('#'=blocked, '.'=walkable) to match the underground map JSON format.
const { widthTiles: w, heightTiles: h, walkable } = grid;
const rows = [];
for (let y = 0; y < h; y++) {
  let r = "";
  for (let x = 0; x < w; x++) r += walkable[y * w + x] === 1 ? "." : "#";
  rows.push(r);
}
process.stdout.write(JSON.stringify({ z: 0, widthTiles: w, heightTiles: h, rows }));
