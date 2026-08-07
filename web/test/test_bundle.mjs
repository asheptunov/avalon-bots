// Bundle smoke test: the built userscript must actually run in a browser-ish
// environment and drive the real socket.
//
// The module tests cover the ported logic; this covers the BUILD -- flattening
// modules by stripping import/export is the step most likely to silently break
// (a shadowed name, a missing nav namespace, a load-order bug), and none of that
// shows up when importing src/ directly.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const BUNDLE = new URL('../avalon-farm.user.js', import.meta.url);
const code = readFileSync(BUNDLE, 'utf8');

/** A minimal DOM + WebSocket good enough to boot the userscript. */
function makeEnv({ liveBundle = null } = {}) {
  const listeners = new Map();
  const sent = [];
  let socket = null;

  class FakeWS {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url) {
      this.url = url;
      this.readyState = 1;           // pretend the handshake already happened
      this.binaryType = 'blob';
      this._l = new Map();
      socket = this;
    }
    addEventListener(t, fn) {
      if (!this._l.has(t)) this._l.set(t, []);
      this._l.get(t).push(fn);
    }
    send(p) { sent.push(p); }
    emit(t, ev) { for (const fn of this._l.get(t) || []) fn(ev); }
  }

  // The panel is built by id, so hand back a STABLE node per id -- otherwise
  // every getElementById returns a fresh stub, `go.onclick` is written to a
  // throwaway, and no test can press Start (which is exactly how a
  // crash-on-Start bug slipped past an all-green suite).
  const byId = new Map();
  const el = (id) => {
    const node = {
      id, style: {}, children: [], classList: {
        add() {}, remove() {}, toggle() {}, contains: () => false,
      },
      dataset: {}, _html: '', value: '', checked: true,
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
    };
    return node;
  };

  const document = {
    createElement: (tag) => el(tag),
    addEventListener(t, fn) { listeners.set(t, fn); },
    // The map-staleness check looks up the game's own module script tag.
    querySelector: (sel) => (liveBundle && sel.includes('/assets/index-')
      ? { getAttribute: () => liveBundle } : null),
    body: el('body'),
    documentElement: el('html'),
  };

  const sandbox = {
    window: {}, document, console: { log() {}, error() {} },
    performance: { now: () => Date.now() },
    TextEncoder, TextDecoder, DataView, Uint8Array, ArrayBuffer, Math, JSON,
    Set, Map, Object, Array, Number, String, Boolean, Error, Infinity,
    setTimeout, clearTimeout,
  };
  sandbox.window.WebSocket = FakeWS;
  sandbox.WebSocket = FakeWS;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return { sandbox, sent, getSocket: () => socket, FakeWS, byId };
}

// Frame builders (duplicated from test_port so this file stands alone).
class W {
  constructor() { this.b = []; }
  u8(v) { this.b.push(v & 0xff); return this; }
  i8(v) { this.b.push(v < 0 ? v + 256 : v); return this; }
  u16(v) { this.b.push(v & 0xff, (v >> 8) & 0xff); return this; }
  u32(v) { for (let i = 0; i < 4; i++) this.b.push((v >>> (8 * i)) & 0xff); return this; }
  f32(v) { const a = new Uint8Array(4); new DataView(a.buffer).setFloat32(0, v, true); this.b.push(...a); return this; }
  str(s) { const e = new TextEncoder().encode(s); this.u16(e.length); this.b.push(...e); return this; }
  buf() { return new Uint8Array(this.b).buffer; }
}

function snapshot({ players = [], monsters = [], groundRev = 1 }) {
  const w = new W();
  w.u8(1).i8(0);
  w.u16(players.length);
  for (const p of players) {
    w.str(p.id).str(p.name).f32(p.x).f32(p.y)
      .u16(p.hp).u16(p.maxHp).u16(1).u8(0).u16(0).u8(0);
  }
  w.u16(monsters.length);
  for (const m of monsters) {
    w.str(m.id).u8(0).f32(m.x).f32(m.y).u16(m.hp).u16(m.maxHp).u8(0);
  }
  w.u8(0);
  w.u32(groundRev).u16(0);
  return w.buf();
}

test('the built userscript evaluates without throwing', () => {
  const { sandbox } = makeEnv();
  assert.doesNotThrow(() => vm.runInContext(code, sandbox));
});

test('it hooks WebSocket without breaking instanceof or the OPEN constants', () => {
  const { sandbox, FakeWS } = makeEnv();
  vm.runInContext(code, sandbox);
  const Hooked = sandbox.window.WebSocket;
  assert.notEqual(Hooked, FakeWS, 'constructor should be replaced');
  assert.equal(Hooked.OPEN, 1, 'the bundle reads WebSocket.OPEN');
  const ws = new Hooked('wss://avalon.juanandresleon.com/');
  assert.ok(ws instanceof FakeWS, 'instanceof must still work for the game bundle');
});

test('it does not attach to unrelated sockets', () => {
  const { sandbox } = makeEnv();
  vm.runInContext(code, sandbox);
  const ws = new sandbox.window.WebSocket('wss://example.com/analytics');
  // An unhooked socket has no listeners registered by us.
  assert.equal((ws._l.get('message') || []).length, 0);
});

test('the maps are embedded and non-trivial', () => {
  const { sandbox } = makeEnv();
  vm.runInContext(code, sandbox);
  // The literal is in the source; assert it parsed into real floors.
  const m = code.match(/const EMBEDDED_MAPS = (\{.*?\});\n/s);
  assert.ok(m, 'EMBEDDED_MAPS literal present');
  const maps = JSON.parse(m[1]);
  assert.ok(maps['0'], 'surface floor present');
  assert.ok(maps['0'].rows.length > 50, 'surface grid has real rows');
  assert.ok(maps['-1'], 'at least one underground floor present');
});

test('an inbound snapshot flows through the hook into the decoder', () => {
  const { sandbox, getSocket } = makeEnv();
  vm.runInContext(code, sandbox);
  const ws = new sandbox.window.WebSocket('wss://avalon.juanandresleon.com/');
  assert.equal(ws.binaryType, 'arraybuffer',
    'must force arraybuffer or snapshots arrive a tick late as Blobs');

  ws.emit('message', { data: JSON.stringify({ type: 'welcome', id: 'me', name: 'Me' }) });
  const buf = snapshot({ players: [{ id: 'me', name: 'Me', x: 100, y: 100, hp: 50, maxHp: 100 }] });
  assert.doesNotThrow(() => ws.emit('message', { data: buf }),
    'decoding a real snapshot frame must not throw');
  assert.equal(getSocket(), ws);
});

test('the bot stays idle until started -- it never moves on its own', () => {
  const { sandbox, sent } = makeEnv();
  vm.runInContext(code, sandbox);
  const ws = new sandbox.window.WebSocket('wss://avalon.juanandresleon.com/');
  ws.emit('message', { data: JSON.stringify({ type: 'welcome', id: 'me', name: 'Me' }) });
  for (let i = 0; i < 5; i++) {
    ws.emit('message', {
      data: snapshot({
        players: [{ id: 'me', name: 'Me', x: 100, y: 100, hp: 100, maxHp: 100 }],
        monsters: [{ id: 'r1', x: 110, y: 100, hp: 5, maxHp: 5 }],
        groundRev: i + 1,
      }),
    });
  }
  assert.equal(sent.length, 0,
    'no frames may be sent before the user presses Start');
});

/** Boot the script, join, press Start, and feed `ticks` snapshots. */
function startAndTick(env, ticks = 3) {
  const { sandbox, byId } = env;
  vm.runInContext(code, sandbox);
  const ws = new sandbox.window.WebSocket('wss://avalon.juanandresleon.com/');
  ws.emit('message', { data: JSON.stringify({ type: 'welcome', id: 'me', name: 'Me' }) });

  // Give the character a backpack so the loot path is reachable.
  ws.emit('message', {
    data: JSON.stringify({
      type: 'equipmentUpdate',
      equipment: { back: { instanceId: 'bp', itemId: 'backpack', contents: [null, null] } },
    }),
  });

  const go = byId.get('go');
  assert.ok(go && typeof go.onclick === 'function', 'Start button must be wired');
  // Inputs are only materialised when readConfig() first looks them up, so seed
  // them through the same map the panel reads from.
  const input = (id, value) => {
    if (!byId.has(id)) byId.set(id, { id, value, checked: true });
    byId.get(id).value = value;
  };
  input('retreat', '35');
  input('resume', '85');
  input('hunt', 'rat');
  go.onclick();

  for (let i = 0; i < ticks; i++) {
    ws.emit('message', {
      data: snapshot({
        players: [{ id: 'me', name: 'Me', x: 100, y: 100, hp: 100, maxHp: 100 }],
        monsters: [{ id: 'r1', x: 400, y: 100, hp: 5, maxHp: 5 }],
        groundRev: i + 1,
      }),
    });
  }
  return ws;
}

test('pressing Start actually drives the character', () => {
  // Regression: resetting per-run state by deleting every `_`-prefixed key also
  // deleted the bot's `_send` transport, so the very first tick after Start threw
  // `this._send is not a function` and the bot never moved. An all-green suite
  // missed it because no test had ever pressed Start.
  const env = makeEnv();
  const { sent } = env;
  startAndTick(env, 3);
  assert.ok(sent.length > 0, 'the bot must send something once started');
  const moved = sent.some((s) => s instanceof ArrayBuffer && new Uint8Array(s)[0] === 1);
  assert.ok(moved, 'it should walk toward the rat it can see');
});

test('Start / Stop / Start again still drives the character', () => {
  // The reset runs on every Start, so a reset that breaks the bot would show up
  // on the SECOND run even if the first looked fine.
  const env = makeEnv();
  const { sent, byId } = env;
  startAndTick(env, 2);
  const go = byId.get('go');
  go.onclick();                    // stop
  const afterStop = sent.length;
  go.onclick();                    // start again
  const ws = env.getSocket();
  ws.emit('message', {
    data: snapshot({
      players: [{ id: 'me', name: 'Me', x: 100, y: 100, hp: 100, maxHp: 100 }],
      monsters: [{ id: 'r1', x: 400, y: 100, hp: 5, maxHp: 5 }],
      groundRev: 99,
    }),
  });
  assert.ok(sent.length > afterStop, 'a restarted bot must still act');
});

test('a handler error never escapes into the page', () => {
  // We run on the game's own message listener: an exception thrown from our
  // callback would land in the client and can break it.
  const env = makeEnv();
  vm.runInContext(code, env.sandbox);
  const ws = new env.sandbox.window.WebSocket('wss://avalon.juanandresleon.com/');
  ws.emit('message', { data: JSON.stringify({ type: 'welcome', id: 'me', name: 'Me' }) });
  // A truncated snapshot makes the decoder read past the end of the buffer.
  const truncated = snapshot({
    players: [{ id: 'me', name: 'Me', x: 1, y: 1, hp: 1, maxHp: 1 }],
  }).slice(0, 6);
  assert.doesNotThrow(() => ws.emit('message', { data: truncated }),
    'a decode failure must be contained, not thrown at the game');
});

test('a stale map warns loudly, a fresh one does not', () => {
  const stale = makeEnv({ liveBundle: '/assets/index-DIFFERENT.js' });
  vm.runInContext(code, stale.sandbox);
  const ws1 = new stale.sandbox.window.WebSocket('wss://avalon.juanandresleon.com/');
  const logs = [];
  stale.sandbox.console.log = (...a) => logs.push(a.join(' '));
  ws1.emit('message', { data: JSON.stringify({ type: 'welcome', id: 'me', name: 'Me' }) });
  assert.ok(logs.some((l) => l.includes('MAPS ARE STALE')),
    'a client redeploy must be named, not silently mispathed');

  // The embedded stamp matches what the page is running -> no warning.
  const built = JSON.parse(code.match(/const EMBEDDED_MAPS = (\{.*?\});\n/s)[1]).bundle;
  const fresh = makeEnv({ liveBundle: built });
  vm.runInContext(code, fresh.sandbox);
  const ws2 = new fresh.sandbox.window.WebSocket('wss://avalon.juanandresleon.com/');
  const ok = [];
  fresh.sandbox.console.log = (...a) => ok.push(a.join(' '));
  ws2.emit('message', { data: JSON.stringify({ type: 'welcome', id: 'me', name: 'Me' }) });
  assert.ok(!ok.some((l) => l.includes('STALE')), 'matching maps must not warn');
});
