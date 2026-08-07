// Ride the game's own WebSocket instead of opening a second one.
//
// This is the whole reason the userscript exists. The server allows ONE
// connection per character (avalon_bot.py's JoinRejected): a Python bot and an
// open browser tab are mutually exclusive, and the incumbent wins. So we never
// connect, never join, and never touch credentials -- we attach to the socket
// the page already has. The character on screen is the character we drive,
// because it is literally the same connection.
//
// Two requirements fall out of that:
//   1. We must install BEFORE the game bundle constructs its socket, hence
//      @run-at document-start and patching the constructor rather than an
//      instance.
//   2. We must not disturb the page's own traffic. We observe inbound frames
//      and add outbound ones; we never swallow, rewrite, or reorder anything.

const GAME_WS_RE = /avalon\.juanandresleon\.com/i;

/**
 * Patch window.WebSocket so we capture the game's socket as it's created.
 *
 * Handlers get raw ArrayBuffers. We attach with addEventListener (not by
 * assigning onmessage) so the game's own handler keeps working -- assigning
 * would clobber whatever the bundle set and blank the screen.
 */
export function installHook({ onOpen, onBinary, onJson, onClose } = {}) {
  const Native = window.WebSocket;
  if (Native.__avalonHooked) return Native.__avalonHooked;

  const state = {
    socket: null,          // the live game socket, once we've seen one
    ready: false,
  };

  function attach(ws) {
    state.socket = ws;
    state.ready = ws.readyState === Native.OPEN;

    // The game sets binaryType itself, but snapshots must reach us as
    // ArrayBuffers, not Blobs -- a Blob would force an async read and we'd
    // decode a tick late. The client already uses arraybuffer, so this is a
    // no-op in practice and a safety net if that ever changes.
    try { ws.binaryType = 'arraybuffer'; } catch { /* readonly pre-open */ }

    // Every callback runs inside `guard`. We are executing on the game's own
    // event listener, so an exception escaping from here lands in the page and
    // can break the client. Bot bugs must stay the bot's problem: this makes
    // "we never disturb the page" structural rather than a convention each
    // consumer has to remember.
    const guard = (fn, arg) => {
      try { fn?.(arg); } catch (e) {
        console.error('[avalon] handler error (page unaffected):', e);
      }
    };

    ws.addEventListener('open', () => {
      state.ready = true;
      guard(onOpen, ws);
    });
    ws.addEventListener('close', () => {
      state.ready = false;
      guard(onClose, ws);
    });
    ws.addEventListener('message', (ev) => {
      const d = ev.data;
      if (typeof d === 'string') {
        let msg;
        try { msg = JSON.parse(d); } catch { return; }
        guard(onJson, msg);
      } else if (d instanceof ArrayBuffer) {
        guard(onBinary, d);
      } else if (d && typeof d.arrayBuffer === 'function') {
        // Blob fallback: correct but a tick late. Only fires if the client
        // switches binaryType out from under us.
        d.arrayBuffer().then((b) => guard(onBinary, b)).catch(() => {});
      }
    });
  }

  function Hooked(url, protocols) {
    const ws = protocols === undefined
      ? new Native(url) : new Native(url, protocols);
    try {
      if (GAME_WS_RE.test(String(url))) attach(ws);
    } catch { /* never let hooking break the page's socket */ }
    return ws;
  }

  // Preserve the real prototype and statics: the bundle does `instanceof
  // WebSocket` and reads WebSocket.OPEN, and breaking either breaks the game.
  Hooked.prototype = Native.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Hooked[k] = Native[k];
  Object.defineProperty(Hooked, 'name', { value: 'WebSocket' });
  Hooked.__avalonHooked = state;
  Hooked.__avalonNative = Native;

  window.WebSocket = Hooked;
  return state;
}

/** Send raw bytes or a JSON message on the captured socket. */
export function makeSender(state) {
  return function send(payload) {
    const ws = state.socket;
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(typeof payload === 'string' ? payload : payload);
      return true;
    } catch {
      return false;
    }
  };
}
