// Node transport: log in and open our OWN WebSocket.
//
// The mirror image of transport/browser.js. That one rides the socket the game
// page already opened (so it can coexist with a logged-in tab); this one owns
// the connection, which is what makes headless integration testing possible --
// the capability that used to justify keeping a whole second stack in Python.
//
// Both expose the same shape -- `{ state, send }` plus the same callbacks -- so
// core/ is transport-agnostic and the userscript and the CLI run identical
// logic. Anything verified live through this path is what ships in the browser.
//
// One connection per character: the server rejects a second join for a
// character that is already connected (`joinRejected`), so running the CLI on a
// character you also have open in a browser tab will bounce one of them.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HTTP = 'https://avalon.juanandresleon.com';
export const WS_URL = 'wss://avalon.juanandresleon.com/';

// Node 22 ships a global WebSocket, but it is undici-based and fails this
// server's upgrade ("Received network error or non-101 status code") while a
// raw handshake to the same URL returns 101. The `ws` package connects fine, so
// we require it -- our single runtime dependency, and only on this side (the
// browser build never imports this file).
const require = createRequire(import.meta.url);
let WebSocketImpl;
try {
  WebSocketImpl = require('ws');
} catch {
  throw new Error(
    "the 'ws' package is required for the CLI -- run `npm install` in web/");
}

/** Where credentials live. Kept OUT of the repo so it can't be committed. */
export const CREDS_PATH = process.env.AVALON_CREDS
  || path.join(os.homedir(), '.avalon', 'creds.json');

/**
 * Load accounts as a list of {username, password}. Accepts a single object, a
 * bare array, or {accounts: [...]} so old creds files keep working.
 */
export function loadAccounts(file = CREDS_PATH) {
  // Env vars win over the file, so CI (and anyone who'd rather not keep
  // credentials on disk) has a path that needs no file at all.
  if (process.env.AVALON_USER && process.env.AVALON_PASS) {
    return [{ username: process.env.AVALON_USER, password: process.env.AVALON_PASS }];
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`could not read credentials at ${file}: ${e.message}\n`
      + 'Expected {"username":..,"password":..} or an array of them.\n'
      + 'Alternatively set AVALON_USER and AVALON_PASS.');
  }
  const list = Array.isArray(raw) ? raw : (raw.accounts || [raw]);
  const accts = list.filter((a) => a && a.username && a.password);
  if (!accts.length) throw new Error(`no usable accounts in ${file}`);
  return accts;
}

const normName = (s) => (s || '').toLowerCase().replace(/[_\s]/g, '');

/**
 * Choose an account by username (forgiving: 'sam' matches 'sam_altman').
 *
 * Returns null when `who` matches no account -- it may name a CHARACTER instead,
 * which only a login can resolve. `resolveAccount` handles that; throwing here
 * would make `--character "Sam Altman"` impossible.
 */
export function pickAccount(accounts, who) {
  if (!who) {
    if (accounts.length === 1) return accounts[0];
    const names = accounts.map((a) => a.username).join(', ');
    throw new Error(`multiple accounts (${names}); pass --account <username>`);
  }
  const key = normName(who);
  return accounts.find((a) => normName(a.username).startsWith(key)) || null;
}

/**
 * Resolve `who` to an account AND its logged-in session, falling back to
 * searching every account for one that OWNS a character by that name.
 *
 * The fallback is what makes `--character "Sam Altman"` work when the account is
 * called something else entirely. It costs one login per account tried, so the
 * username path is checked first and the session is carried out rather than
 * re-established by the caller.
 */
export async function resolveAccount(accounts, who) {
  const acct = pickAccount(accounts, who);
  if (acct) {
    const { session, chars } = await login(acct.username, acct.password);
    return { acct, session, chars };
  }
  for (const a of accounts) {
    const { session, chars } = await login(a.username, a.password);
    if (chars.some((c) => normName(c.name) === normName(who)
        || normName(c.name).startsWith(normName(who)))) {
      return { acct: a, session, chars };
    }
  }
  throw new Error(`no account or character matching ${who}; accounts: `
    + accounts.map((a) => a.username).join(', '));
}

/** POST /api/auth/login -> {sessionToken, characters[]}. */
export async function login(username, password) {
  const r = await fetch(`${HTTP}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) throw new Error(`login failed for ${username}: HTTP ${r.status}`);
  const data = await r.json();
  const session = data.sessionToken;
  let chars = data.characters || [];
  if (!chars.length) {
    const c = await fetch(`${HTTP}/api/characters`,
      { headers: { Authorization: `Bearer ${session}` } });
    chars = (await c.json()).characters || [];
  }
  return { session, chars };
}

export function pickCharacter(chars, name) {
  if (!chars.length) throw new Error('account has no characters');
  if (!name) return chars[0];
  const key = normName(name);
  const hit = chars.filter((c) => normName(c.name).startsWith(key));
  if (!hit.length) {
    throw new Error(`no character matching ${name} in `
      + chars.map((c) => c.name).join(', '));
  }
  return hit[0];
}

/**
 * Connect and join, returning the same `{state, send}` contract as the browser
 * transport so core/ cannot tell the difference.
 *
 * Resolves once the socket is open and the join payload is sent -- NOT when the
 * server accepts it. Callers watch for `welcome` (or `joinRejected`) via onJson,
 * exactly as the browser side does.
 */
export function connect({ session, characterToken, onOpen, onJson, onBinary, onClose } = {}) {
  const state = { socket: null, ready: false };

  const guard = (fn, arg) => {
    try { fn?.(arg); } catch (e) {
      console.error('[avalon] handler error:', e);
    }
  };

  const ws = new WebSocketImpl(WS_URL);
  ws.binaryType = 'arraybuffer';
  state.socket = ws;

  ws.on('open', () => {
    state.ready = true;
    ws.send(JSON.stringify({ type: 'join', sessionToken: session, characterToken }));
    guard(onOpen, ws);
  });

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      guard(onJson, msg);
      return;
    }
    // `ws` hands us a Buffer; core/ decodes ArrayBuffers. Slice to the exact
    // view -- a Buffer from a pool shares its parent's larger backing store, so
    // handing over `.buffer` wholesale would decode neighbouring frames' bytes.
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
    guard(onBinary, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  });

  ws.on('close', () => { state.ready = false; guard(onClose, ws); });
  ws.on('error', (e) => console.error('[avalon] socket error:', e.message));

  return { state, ws, send: makeSender(state) };
}

/** Send raw bytes or a JSON string on the socket. Mirrors the browser sender. */
export function makeSender(state) {
  return function send(payload) {
    const ws = state.socket;
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(payload); return true; } catch { return false; }
  };
}

/** login + pick + connect, the whole chain the CLI needs. */
export async function openSession({ account, character, creds, handlers = {} }) {
  // `--account` names an account; `--character` may name either, so fall back to
  // it and let resolveAccount find whichever account owns that character.
  const { acct, session, chars } =
    await resolveAccount(loadAccounts(creds), account || character);
  const ch = pickCharacter(chars, character);
  const token = ch.characterToken || ch.token;
  const conn = connect({ session, characterToken: token, ...handlers });
  return { ...conn, account: acct, character: ch, session };
}
