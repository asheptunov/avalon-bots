// Entry point: hook the socket, drive the farm loop off the snapshot stream.
//
// Timing note. The Python client ran its own asyncio loop and called the intent
// on every snapshot. Here the server's 100 ms tick IS our clock -- we run the
// intent on each decoded snapshot, so the bot ticks at exactly the rate the
// server updates and never busy-waits.

import { installHook, makeSender } from './transport/browser.js';
import { extractFromPage } from './transport/pagemaps.js';
import { AvalonBot } from './core/bot.js';
import {
  makeFarm, FarmConfig, meOf, handleDialogue, handleLootRefusal,
} from './core/farm.js';
import { handleDepot, endBanking } from './core/depot.js';
import * as nav from './core/nav.js';
import { createPanel } from './ui.js';

// EMBEDDED_MAPS is injected by build.py from avalon_maps.json -- a fallback
// only; the maps we actually use are extracted from the running client.
/* global EMBEDDED_MAPS */

function boot() {
  // Load the embedded snapshot immediately so the bot is never map-less, then
  // replace it with maps read from the live client. See loadLiveMaps().
  nav.loadMaps(EMBEDDED_MAPS);

  let bot = null;
  let intent = null;
  let panel = null;

  const log = (msg, cls) => {
    panel?.log(msg, cls);
    console.log('[avalon]', msg);
  };

  /**
   * Replace the embedded maps with ones extracted from the client the page is
   * actually running.
   *
   * The collision maps are GENERATED from the game bundle, so a redeploy moves
   * trees and water and invalidates any baked-in copy -- silently, surfacing
   * only as a bot that walks into a wall the map thinks is open. Extracting from
   * the live bundle makes that failure mode structurally impossible: the maps
   * cannot disagree with the client, because they come from it.
   *
   * The embedded snapshot is already loaded and stays in place if this fails,
   * so a bad extract degrades to "possibly stale" rather than "no maps at all".
   */
  async function loadLiveMaps() {
    const built = nav.mapBundle();
    try {
      const { maps } = await extractFromPage();
      nav.loadMaps(maps);
      log(maps.bundle === built
        ? `maps extracted from the live client (${maps.bundle})`
        : `maps re-extracted -- client is ${maps.bundle}, build had ${built}`);
    } catch (e) {
      log(`!! could not extract maps from the live client (${e.message}); `
          + `falling back to the embedded set from ${built}. If the game has `
          + 'updated since that build, expect pinning on obstacles.');
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
        loadLiveMaps();
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
  bot.onJsonMessage((b, msg) => handleDialogue(b, msg, log));
  bot.onJsonMessage((b, msg) => handleDepot(b, msg, log));
  bot.onJsonMessage((b, msg) => handleLootRefusal(b, msg, log));

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
    // Close the depot if we stopped mid-trip. This one is browser-specific
    // courtesy: the userscript shares a screen with you, so leaving the box
    // open would park a panel over your game that you did not open.
    if (bot?.run?.depotOpen) endBanking(bot, log);
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
