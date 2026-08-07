#!/usr/bin/env node
// Bundle src/ + a maps snapshot into one Tampermonkey userscript.
//
// No bundler dependency: the sources are small ES modules with a known, acyclic
// import graph, so we concatenate them in dependency order and strip the
// import/export keywords. That keeps the toolchain to `node build.mjs` and the
// output to a single file you can paste into Tampermonkey.
//
// The embedded maps are a FALLBACK. At runtime the script extracts collision
// maps from the client the page is actually running (transport/pagemaps.js), so
// the snapshot only matters if that fails. It is still worth shipping: without
// it a failed extract would leave the bot with no collision data at all.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'src');
const OUT = path.join(HERE, 'avalon-farm.user.js');
const MAPS = path.join(HERE, 'maps.json');

// Dependency order: each module may only use the ones above it.
//
// core/swarm.js and core/intents.js are deliberately NOT here. The userscript
// drives the one character whose tab it is running in, so the swarm (many
// sockets) and the one-shot CLI verbs have no way to be triggered from the
// panel -- bundling them would ship ~900 lines of unreachable code. They are
// CLI-only until the panel grows a reason to call them.
const MODULES = [
  'core/protocol.js',
  'core/maps.js',
  'transport/browser.js',
  'transport/pagemaps.js',
  'core/bot.js',
  'core/nav.js',
  'core/farm.js',
  'ui.js',
  'main.js',
];

// Modules consumed as a namespace (`nav.findPath`) need that object rebuilt
// after flattening, since the import statement that created it is stripped.
const NAMESPACED = { 'core/nav.js': 'nav' };

const VERSION = process.env.AVALON_VERSION || readVersion();
const REPO = 'https://github.com/asheptunov/avalon-bots';

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version;
  } catch { return '0.0.0'; }
}

// @updateURL/@downloadURL point at a stable "latest release" asset, so
// Tampermonkey's periodic check picks up new versions without anyone reinstalling.
const HEADER = `// ==UserScript==
// @name         Avalon Farm Bot
// @namespace    ${REPO}
// @version      ${VERSION}
// @description  Drives your on-screen Avalon character: kill / loot / cook / eat / heal.
// @author       asheptunov
// @match        https://avalon.juanandresleon.com/*
// @run-at       document-start
// @grant        none
// @updateURL    ${REPO}/releases/latest/download/avalon-farm.user.js
// @downloadURL  ${REPO}/releases/latest/download/avalon-farm.user.js
// ==/UserScript==
`;

// `export` only ever prefixes a declaration here, so dropping the keyword leaves
// valid top-level code. Imports are dropped entirely: after concatenation every
// binding is already in the same scope.
const IMPORT_RE = /^\s*import\s+[^;]*?;\s*$/gm;
const DECL = String.raw`(?:async\s+)?(?:class|function|const|let|var)`;
const EXPORT_RE = new RegExp(String.raw`^export\s+(?=${DECL}\b)`, 'gm');

function fail(msg) { console.error(msg); process.exit(1); }

function stripModuleSyntax(src, name) {
  // `export default` is deliberately NOT handled: stripping only the `export`
  // would leave a bare `default class ...`, a syntax error. Reject it loudly.
  if (/^\s*export\s*\{/m.test(src)) {
    fail(`${name}: \`export {...}\` lists aren't supported by this bundler; `
      + 'use `export` on the declaration itself.');
  }
  if (/^\s*export\s+default\b/m.test(src)) {
    fail(`${name}: \`export default\` isn't supported by this bundler; use a named export.`);
  }
  return src.replace(IMPORT_RE, '').replace(EXPORT_RE, '').trim();
}

/** Top-level export names, for rebuilding a namespace object after flattening. */
function exportedNames(src) {
  const re = new RegExp(String.raw`^export\s+${DECL}\s+([A-Za-z_$][\w$]*)`, 'gm');
  return [...src.matchAll(re)].map((m) => m[1]);
}

function main() {
  if (!fs.existsSync(MAPS)) {
    fail(`missing ${MAPS} -- run: node src/cli/main.js maps --out maps.json`);
  }
  const maps = JSON.parse(fs.readFileSync(MAPS, 'utf8'));

  const parts = [HEADER, "\n(function () {\n'use strict';\n"];
  parts.push(`const EMBEDDED_MAPS = ${JSON.stringify(maps)};\n`);

  for (const name of MODULES) {
    const file = path.join(SRC, name);
    if (!fs.existsSync(file)) fail(`missing module ${file}`);
    const raw = fs.readFileSync(file, 'utf8');
    parts.push(`\n// ===== ${name} ${'='.repeat(Math.max(3, 58 - name.length))}\n`);
    parts.push(`${stripModuleSyntax(raw, name)}\n`);

    const ns = NAMESPACED[name];
    if (ns) {
      const names = exportedNames(raw);
      if (!names.length) fail(`${name}: found no exports to build the \`${ns}\` namespace`);
      parts.push(`\nconst ${ns} = { ${names.join(', ')} };\n`);
    }
  }
  parts.push('\n})();\n');
  const out = parts.join('');

  // Backstop: a userscript is NOT a module, so any surviving import/export is a
  // syntax error -- and one that only shows up when Tampermonkey refuses to run
  // the script, long after a build that printed success. Fail here instead, so
  // every gap in the regexes above is a loud build failure, not a silent broken
  // install.
  out.split('\n').forEach((line, i) => {
    if (/^\s*(?:import|export)\b/.test(line)) {
      fail(`${OUT}:${i + 1}: module syntax survived bundling -- `
        + `stripModuleSyntax needs to handle it:\n  ${line.trim()}`);
    }
  });

  fs.writeFileSync(OUT, out, 'utf8');
  const kb = fs.statSync(OUT).size / 1024;
  console.log(`wrote ${OUT} (${kb.toFixed(0)} KB, v${VERSION}, `
    + `maps fallback=${maps.bundle})`);
}

main();
