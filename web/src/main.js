// Entry point: hook the socket, drive the farm loop off the snapshot stream.
//
// Timing note. The Python client ran its own asyncio loop and called the intent
// on every snapshot. Here the server's 100 ms tick IS our clock -- we run the
// intent on each decoded snapshot, so the bot ticks at exactly the rate the
// server updates and never busy-waits.

import { installHook, makeSender } from './hook.js';
import { AvalonBot } from './bot.js';
import { makeFarm, FarmConfig, meOf } from './farm.js';
import * as nav from './nav.js';
import { createPanel } from './ui.js';

// EMBEDDED_MAPS is injected by build.js from avalon_maps.json.
/* global EMBEDDED_MAPS */

function boot() {
  nav.loadMaps(EMBEDDED_MAPS);

  let bot = null;
  let intent = null;
  let panel = null;

  const log = (msg, cls) => {
    panel?.log(msg, cls);
    console.log('[avalon]', msg);
  };

  /**
   * Compare the maps' build-time stamp against the client the page is actually
   * running. The collision maps are GENERATED from the game bundle, so a
   * redeploy moves trees and water and silently invalidates them -- the bot then
   * paths into walls the map thinks are open. Python re-extracts on startup; a
   * userscript can't, but it CAN notice, which turns a baffling failure into a
   * named one with a fix attached.
   */
  function reportMapFreshness() {
    const built = nav.mapBundle();
    if (!built) return;
    const el = document.querySelector('script[type=module][src*="/assets/index-"]');
    const live = el && el.getAttribute('src');
    if (live && live !== built) {
      log(`!! MAPS ARE STALE -- built from ${built}, game is running ${live}. `
          + 'Re-run: python extract_maps.py && python web/build.py');
    } else {
      log(`maps from bundle ${built}`);
    }
  }

  const state = installHook({
    onOpen() { log('socket open'); },
    onClose() {
      log('socket closed -- bot stopped');
      stop();
      panel?.enable(false);
    },
    onJson(msg) {
      bot?.onJson(msg);
      if (msg?.type === 'welcome') {
        log(`joined as ${msg.name}`);
        panel?.enable(true);
        reportMapFreshness();
      }
      if (msg?.type === 'joinRejected') log(`!! join rejected: ${msg.reason || ''}`);
    },
    onBinary(buf) {
      const snap = bot?.onBinary(buf);
      if (!snap) return;
      // Status readout, whether or not the loop is running.
      const me = bot.me ? meOf(bot, snap) : null;
      if (me) {
        const [free, cap] = bot.packSpace();
        panel?.setStatus({
          state: intent ? (bot.run.farmState || 'running') : 'idle',
          hp: me.hp, maxHp: me.maxHp, free, cap,
        });
      }
      if (!intent) return;
      try {
        intent(bot, snap);
      } catch (e) {
        log(`!! error: ${e.message} -- stopping`);
        console.error(e);
        stop();
      }
      if (bot.done) { log('done'); stop(); }
    },
  });

  bot = new AvalonBot(makeSender(state));

  function start(opts) {
    if (!bot.joined) { log('!! not joined yet -- wait for the world to load'); return; }
    if (opts.resumeFrac <= opts.retreatFrac) {
      // Hysteresis is the whole point: equal thresholds oscillate between
      // fleeing and swinging at the boundary.
      log('!! resume % must exceed retreat % -- adjust and retry');
      return;
    }
    // Clear per-run state so a restart doesn't inherit the last run's bans,
    // chase timers or cached path. One assignment, and it structurally cannot
    // reach the transport or the join state the way a `delete every _key` sweep
    // could (that sweep deleted `bot._send` and broke the bot on first Start).
    bot.run = {};
    bot.fleeing = false;
    bot.done = false;
    intent = makeFarm(new FarmConfig(opts), log);
    panel.setRunning(true);
    log(`started -- hunting ${opts.huntTypes ? opts.huntTypes.join(',') : 'anything'}`);
  }

  function stop() {
    if (intent) { intent = null; bot.move(0, 0); }
    panel?.setRunning(false);
    panel?.setStatus({ state: 'idle' });
  }

  const mount = () => {
    panel = createPanel({ onStart: start, onStop: stop });
    panel.enable(bot.joined);
    log('ready -- press Start once your character is in the world');
  };
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
}

boot();
