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
// pixi import, and ends after the `ko[xn(e)]=Fh(e)` zone-grid init loop.
const importEnd = js.indexOf(";", js.indexOf('from"./pixi')) + 1;
// Walk the bootstrap IIFE parens to find its end.
let i = js.indexOf("(function(){", importEnd), depth = 0, sliceStart = -1;
for (let j = i; j < js.length; j++) {
  if (js[j] === "(") depth++;
  else if (js[j] === ")") { if (--depth === 0) { sliceStart = js.indexOf(";", j) + 1; break; } }
}
const koInit = js.indexOf("const Gh=8,xn=e=>e+Gh,ko=[]");
const sliceEnd = js.indexOf("Fh(e);", koInit) + "Fh(e);".length;
if (sliceStart < 0 || koInit < 0 || sliceEnd < 0) {
  console.error("could not locate worldgen slice boundaries; bundle layout changed");
  process.exit(3);
}
const slice = js.slice(sliceStart, sliceEnd);

// --- stub the (unused) pixi import names so references don't ReferenceError --
const importDecl = js.slice(0, importEnd);
const pixiNames = [...importDecl.matchAll(/ as ([A-Za-z$_][A-Za-z0-9$_]*)/g)].map(m => m[1]);
const stubs = pixiNames.map(n => `var ${n}=function(){};`).join("");

// --- run the slice, then dump Fh(0) -----------------------------------------
// `Fh` and `au` are `function`/`const` declarations in the slice scope, so we
// evaluate everything in one function body and read them out at the end.
const program = `
"use strict";
${stubs}
${slice}
;globalThis.__grid = Fh(0);
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
