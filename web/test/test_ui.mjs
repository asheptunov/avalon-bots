// Control-panel tests: the widgets must map to the config the farm loop reads.
//
// The panel is the only way a browser user configures a run -- the CLI flags are
// unreachable there -- so a checkbox wired to the wrong field silently disables
// (or force-enables) a behaviour with nothing else to catch it. test_bundle.mjs
// proves the built script BOOTS and can be started; this file proves the panel
// reads its own inputs correctly.
//
// Run: node --test web/test/test_ui.mjs   (from the repo root)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

import { createPanel } from '../src/ui.js';

const BUNDLE = new URL('../avalon-farm.user.js', import.meta.url);

/**
 * A fake DOM just big enough for createPanel(): stable nodes per id, so a test
 * can flip a checkbox and have the panel read the same node back.
 */
function fakeDom() {
  const byId = new Map();

  const el = (id) => ({
    id,
    style: {},
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    value: '',
    checked: true,
    _html: '',
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    set textContent(v) { this._text = v; },
    get textContent() { return this._text; },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    append(...c) { this.children.push(...c); },
    addEventListener() {},
    attachShadow() { const s = el('#shadow'); this.shadow = s; return s; },
    querySelector(sel) { return el(sel); },
    getElementById(k) {
      if (!byId.has(k)) byId.set(k, el(k));
      return byId.get(k);
    },
    get childElementCount() { return this.children.length; },
    get firstChild() { return this.children[0]; },
    get scrollHeight() { return 0; },
  });

  const document = {
    createElement: (tag) => el(tag),
    body: el('body'),
    documentElement: el('html'),
    addEventListener() {},
  };
  return { document, byId, el };
}

/**
 * Mount the panel, apply `inputs` to its widgets, press Start, and hand back the
 * config the panel produced.
 */
function configFrom(inputs = {}) {
  const { document, byId, el } = fakeDom();
  const prev = globalThis.document;
  globalThis.document = document;
  try {
    let got = null;
    const panel = createPanel({ onStart: (cfg) => { got = cfg; }, onStop() {} });
    // Inputs are only materialised when the panel first looks them up, so reach
    // them through the same id map it reads from.
    for (const [id, v] of Object.entries(inputs)) {
      if (!byId.has(id)) byId.set(id, el(id));
      const node = byId.get(id);
      if (typeof v === 'boolean') node.checked = v;
      else node.value = v;
    }
    // Defaults for the numeric fields, which have no meaningful fake value.
    for (const [id, v] of [['retreat', '35'], ['resume', '85'], ['hunt', 'rat']]) {
      if (!byId.has(id)) byId.set(id, el(id));
      if (!(id in inputs)) byId.get(id).value = v;
    }
    byId.get('go').onclick();
    assert.ok(got, 'pressing Start must hand a config to onStart');
    return { cfg: got, panel };
  } finally {
    globalThis.document = prev;
  }
}

test('eat, cook and stack are three independent switches', () => {
  // Regression: the panel had ONE "eat / cook / stack" checkbox feeding all
  // three config fields, so you could not (say) keep eating while turning off
  // cooking -- even though the core and the CLI have supported the split all
  // along (--no-eat / --no-cook / --no-stack).
  const cases = [
    { eat: true, cook: false, stack: false },
    { eat: false, cook: true, stack: false },
    { eat: false, cook: false, stack: true },
    { eat: false, cook: false, stack: false },
    { eat: true, cook: true, stack: true },
  ];
  for (const want of cases) {
    const { cfg } = configFrom(want);
    assert.equal(cfg.eat, want.eat, `eat for ${JSON.stringify(want)}`);
    assert.equal(cfg.cook, want.cook, `cook for ${JSON.stringify(want)}`);
    assert.equal(cfg.stack, want.stack, `stack for ${JSON.stringify(want)}`);
  }
});

test('the panel renders a separate tick box for each of eat, cook and stack', () => {
  const src = readFileSync(new URL('../src/ui.js', import.meta.url), 'utf8');
  for (const id of ['eat', 'cook', 'stack']) {
    assert.match(src, new RegExp(`<input id="${id}" type="checkbox"`),
      `${id} needs its own checkbox`);
  }
  assert.doesNotMatch(src, /eat \/ cook \/ stack/,
    'the merged label must be gone, or the three boxes are mislabelled');
});

test('the other toggles still map straight through', () => {
  const { cfg } = configFrom({ loot: false, bank: false, courtesy: false });
  assert.equal(cfg.loot, false);
  assert.equal(cfg.bank, false);
  assert.equal(cfg.courtesy, false);
  const on = configFrom({ loot: true, bank: true, courtesy: true }).cfg;
  assert.equal(on.loot, true);
  assert.equal(on.bank, true);
  assert.equal(on.courtesy, true);
});

test('the panel offers the avoid-other-players switch, on by default', () => {
  // Browser users have no CLI flags, so if the panel never renders this the
  // behaviour is unreachable and unturnoffable from the only UI they have.
  const src = readFileSync(new URL('../src/ui.js', import.meta.url), 'utf8');
  assert.match(src, /<input id="courtesy" type="checkbox" checked>/,
    'courtesy needs its own checkbox, ticked by default');
});

test('the built userscript carries the split checkboxes, not the merged one', () => {
  // The userscript is committed, so a rebuild that never happened would ship the
  // old single-checkbox panel to every installed user.
  const code = readFileSync(BUNDLE, 'utf8');
  for (const id of ['eat', 'cook', 'stack', 'courtesy']) {
    assert.match(code, new RegExp(`<input id="${id}" type="checkbox"`),
      `bundle is stale: no ${id} checkbox -- run \`node build.mjs\``);
  }
  assert.doesNotMatch(code, /eat \/ cook \/ stack/,
    'bundle is stale: still shows the merged eat/cook/stack label');
});
