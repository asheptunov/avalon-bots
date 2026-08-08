#!/usr/bin/env node
// Headless CLI: the same core logic the userscript runs, over our own socket.
//
// This exists so bot behaviour can be tested against the live server without a
// browser. The userscript can only be driven by a human clicking Start in a
// logged-in tab, which makes it useless as a test harness -- and that gap is
// what previously justified maintaining a parallel Python implementation.
// Everything below is wiring; the behaviour lives in core/ and is byte-identical
// to what ships in the browser.
//
// Usage:
//   node src/cli/main.js farm --account fable --hunt rat
//   node src/cli/main.js where --account fable
//   node src/cli/main.js maps --out ../avalon_maps.json

import { openSession } from '../transport/node.js';
import { AvalonBot } from '../core/bot.js';
import {
  makeFarm, FarmConfig, meOf, handleDialogue, handleLootRefusal,
} from '../core/farm.js';
import { handleDepot } from '../core/depot.js';
import {
  makeSwarm, makeSwarmLeader, PartyConfig, INTENTS, FORMATIONS,
} from '../core/swarm.js';
import { makeHeal, makeFollow, makeMove, parseTile } from '../core/intents.js';
import * as nav from '../core/nav.js';
import { extractFromLive, liveBundlePath } from '../core/maps.js';
import { TILE } from '../core/protocol.js';

// ---- arg parsing ----------------------------------------------------------

/** Minimal `--flag value` / `--bool` parser; positionals collected in `_`. */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const num = (v, d) => (v === undefined ? d : Number(v));

function usage() {
  console.log(`avalon - headless bot CLI (same core as the userscript)

Commands:
  farm      kill / loot / cook / eat / heal, indefinitely
  where     print everyone visible, then exit
  respawn   respawn if dead, then exit
  heal      drink a potion, else visit a healer NPC, then exit
  follow    trail a player until Ctrl-C   (follow <name> [--keep <tiles>])
  move      walk to 'x,y', a location, or a player, then exit
  send      send one raw JSON message, then exit
  maps      re-extract collision maps from the live client
  lead      run as the bot leader of a party
  escort    follow a leader (bot or human) as one escort
  swarm     run the WHOLE hive from this one process

Common flags:
  --account <name>     which account from ~/.avalon/creds.json
  --character <name>   which character on that account
  --creds <path>       override the credentials file

farm flags:
  --hunt <types>       comma-separated, or '*' for anything   (default rat)
  --retreat-hp <pct>   fall back below this                   (default 35)
  --resume-hp <pct>    resume fighting above this             (default 85)
  --heal-to <pct>      heal to this at the healer             (default 95)
  --healer <name>      NPC to heal at ('' = just back off)    (default aldric)
  --roam <tiles>       how far to wander for the next spawn   (default 12)
  --depth <z>          0 = surface, negative = underground    (default 0)
  --entry <x,y>        which hole to descend by
  --until-hp <pct>     stop once HP drops to this
  --no-loot --no-eat --no-cook --no-stack --no-bank
  --bank-free <n>      head to the depot with this many slots left (default 1)
  --no-courtesy        stop yielding monsters/loot near other players
  --allies <names>     comma-separated players to treat as ours, not strangers
  --duration <sec>     stop after N seconds (for test runs)
  --quiet              only log state changes

swarm flags:
  --leader <account>   account to run as the BOT leader
  --follow <name>      human-leader mode: YOUR character name, escorts only
  --escort <list>      A[:intent[:formation]],... e.g. haiku:defend:magnetize,opus
  --intent <mode>      default escort intent: ${INTENTS.join(' | ')}
  --formation <f>      default formation: ${FORMATIONS.join(' | ')}
  --members <names>    party names for cohesion (lead/escort; swarm infers them)
  --rally <tiles>      "tight pack" radius                    (default 4)
  --threat <tiles>     aggro monsters this close matter       (default 8)
  --threshold <0..1>   readiness needed to engage             (default 0.6)
  --combat-exit <0..1> keep fighting until below this         (default thr-0.15)
  --readiness-smooth   readiness EMA weight, 1.0 = raw        (default 0.4)
  --cohesion-slack <n> how loose a "tight" pack may be        (default 2.5)
  --hunt-enter <0..1>  cohesion to START advancing on prey    (default 0.5)
  --hunt-exit <0..1>   cohesion below which it aborts         (default 0.3)
  --focus-radius <t>   focus-fire radius around the leader    (default 6)
  --dry-run            print the resolved hive and exit

Examples:
  node src/cli/main.js swarm --leader sam --escort haiku:defend:magnetize,opus
  node src/cli/main.js swarm --follow "Sam Altman" --escort haiku,sonnet,opus`);
}

// ---- shared runner --------------------------------------------------------

/**
 * Connect, then drive `intent` on every snapshot.
 *
 * The server's ~100 ms snapshot cadence IS the clock: we tick on each decoded
 * snapshot rather than on a timer, so the bot runs at exactly the rate the world
 * updates and never busy-waits. Same choice the browser build makes.
 */
async function run(args, makeIntent, { onWelcome, oneShot = false } = {}) {
  // The bot is constructed BEFORE we connect, so no frame can arrive while
  // `bot` is still null. It only holds a send function, and the transport's is
  // not available yet -- so we hand it an indirection that resolves to whatever
  // `conn.send` ends up being. Assigning the bot after `await openSession()`
  // happens to work today (the socket opens on a later turn), but it is safe by
  // accident: any transport that dispatched synchronously would drop the join
  // frames on the floor.
  let send = () => false;
  const bot = new AvalonBot((payload) => send(payload));
  let intent = null;
  let done = false;

  const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

  const finish = (code = 0) => {
    if (done) return;
    done = true;
    try { bot.move(0, 0); } catch { /* socket may already be gone */ }
    setTimeout(() => process.exit(code), 100);
  };

  const conn = await openSession({
    account: args.account,
    character: args.character,
    creds: args.creds,
    handlers: {
      onJson(msg) {
        bot.onJson(msg);
        if (msg?.type === 'welcome') {
          log(`joined as ${msg.name}`);
          if (onWelcome) onWelcome(bot, log, finish);
          if (!oneShot) intent = makeIntent(bot, log);
        } else if (msg?.type === 'joinRejected') {
          // The character is already connected somewhere -- a browser tab, or
          // another CLI run. One socket per character, incumbent wins.
          log(`!! join rejected: ${msg.reason || ''}`);
          finish(1);
        }
      },
      onBinary(buf) {
        const snap = bot.onBinary(buf);
        if (!snap || !intent || done) return;
        try {
          intent(bot, snap);
        } catch (e) {
          log(`!! error: ${e.message}`);
          console.error(e);
          finish(1);
        }
        if (bot.done) { log('done'); finish(0); }
      },
      onClose() { log('socket closed'); finish(done ? 0 : 1); },
    },
  });

  send = conn.send;
  bot.onJsonMessage((b, msg) => handleDialogue(b, msg, log));
  bot.onJsonMessage((b, msg) => handleDepot(b, msg, log));
  bot.onJsonMessage((b, msg) => handleLootRefusal(b, msg, log));
  log(`connecting as ${conn.account.username} / ${conn.character.name}`);

  if (args.duration) {
    const secs = Number(args.duration);
    log(`will stop after ${secs}s`);
    setTimeout(() => { log('duration reached'); finish(0); }, secs * 1000);
  }

  process.on('SIGINT', () => { log('interrupted'); finish(0); });
  return { bot, conn };
}

/** Load maps, refreshing from the live client when they'd otherwise be stale. */
async function ensureMaps(quiet = false) {
  // The surface map is GENERATED from the client bundle, so a redeploy silently
  // invalidates it -- bots then path into trees the map thinks are open. The
  // browser is immune because it always loads the current bundle; re-extracting
  // here gives the CLI the same property.
  try {
    const maps = await extractFromLive();
    nav.loadMaps(maps);
    if (!quiet) console.log(`maps: extracted from ${maps.bundle}`);
    return maps;
  } catch (e) {
    console.error(`maps: extraction FAILED (${e.message}); `
      + 'continuing without collision data -- expect pinning on obstacles');
    return null;
  }
}

// ---- commands -------------------------------------------------------------

async function cmdFarm(args) {
  await ensureMaps(args.quiet);
  // Validate rather than coercing: `--entry bogus` used to become [NaN], which
  // matches no teleport, so the bot silently ignored the hole you picked and
  // used the nearest one instead.
  let entry = null;
  if (args.entry && args.entry !== true) {
    entry = parseTile(String(args.entry));
    if (!entry) {
      console.error(`bad --entry ${args.entry}; want 'x,y' (e.g. 58,22)`);
      process.exit(2);
    }
  }
  const hunt = args.hunt === undefined ? 'rat' : String(args.hunt);
  const cfg = new FarmConfig({
    huntTypes: (hunt === '*' || hunt === 'true') ? null : hunt.split(','),
    retreatFrac: num(args['retreat-hp'], 35) / 100,
    resumeFrac: num(args['resume-hp'], 85) / 100,
    healToFrac: num(args['heal-to'], 95) / 100,
    healerName: args.healer === undefined ? 'aldric' : (args.healer || null),
    roamPx: num(args.roam, 12) * TILE,
    untilHpFrac: args['until-hp'] ? num(args['until-hp']) / 100 : null,
    depth: num(args.depth, 0),
    entryTile: entry,
    loot: !args['no-loot'],
    eat: !args['no-eat'],
    cook: !args['no-cook'],
    stack: !args['no-stack'],
    bank: !args['no-bank'],
    bankFreeSlots: num(args['bank-free'], 1),
    courtesy: !args['no-courtesy'],
    allyNames: args.allies ? String(args.allies).split(',') : [],
  });
  await run(args, (bot, log) => makeFarm(cfg, log));
}

async function cmdWhere(args) {
  await ensureMaps(true);
  await run(args, null, {
    oneShot: true,
    onWelcome(bot, log, finish) {
      // Wait one snapshot so the world is populated before printing.
      const t = setInterval(() => {
        const snap = bot.state;
        if (!snap?.players?.length) return;
        clearInterval(t);
        const me = meOf(bot, snap);
        // nav.tileOf, NOT Math.floor: the server rounds px->tile, so flooring
        // reports a different tile than the pathfinder plans from. A debugging
        // command that disagrees with A* about where you're standing is worse
        // than no command at all.
        const tile = (e) => `${nav.tileOf(e.x)},${nav.tileOf(e.y)}`;
        console.log(`z=${snap.z}`);
        if (me) console.log(`  me       ${me.name} @ ${tile(me)} hp ${me.hp}/${me.maxHp}`);
        for (const p of snap.players) {
          if (p.id === bot.me) continue;
          console.log(`  player   ${p.name} @ ${tile(p)} hp ${p.hp}/${p.maxHp}`);
        }
        // Nearest first: on a busy field the interesting monster is the close
        // one, and an unsorted wall of 40 rats buries it.
        const byDist = me
          ? [...snap.monsters].sort((a, b) =>
            Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y))
          : snap.monsters;
        for (const m of byDist) {
          const d = me ? ` (${(Math.hypot(m.x - me.x, m.y - me.y) / TILE).toFixed(1)}t)` : '';
          console.log(`  monster  ${m.monsterType}${m.enraged ? ' (enraged)' : ''}`
            + ` @ ${tile(m)} hp ${m.hp}/${m.maxHp}${d}`);
        }
        for (const n of snap.npcs) console.log(`  npc      ${n.name} @ ${tile(n)}`);
        for (const g of bot.groundItems || []) {
          const label = g.item?.name || g.item?.itemId || 'item';
          const qty = g.item?.quantity > 1 ? ` x${g.item.quantity}` : '';
          console.log(`  ground   ${label}${qty} @ ${tile(g)}`);
        }

        // What we're carrying. This is usually the answer to "why isn't it
        // eating / looting?" -- no food held, or a full pack.
        const [free, cap] = bot.packSpace();
        const held = new Map();
        for (const it of bot.iterItems()) {
          if (it.contents) continue;                  // the container itself
          held.set(it.itemId, (held.get(it.itemId) || 0) + (it.quantity || 1));
        }
        const inv = [...held.entries()].map(([id, n]) => `${id} x${n}`).join(', ');
        console.log(`  pack     ${cap - free}/${cap} slots used`);
        // Weight is the OTHER carry limit, and the one that silently refuses
        // pickups while the slot count still looks fine.
        const [carried, capOz] = bot.weight();
        if (capOz) {
          console.log(`  weight   ${Math.round(carried)}/${Math.round(capOz)} oz`
            + `${bot.overloaded() ? '  !! OVERLOADED' : ''}`);
        }
        console.log(`  carrying ${inv || '(nothing)'}`);
        finish(0);
      }, 100);
    },
  });
}

async function cmdRespawn(args) {
  await run(args, null, {
    oneShot: true,
    onWelcome(bot, log, finish) {
      bot.send({ type: 'respawn' });
      log('sent respawn');
      setTimeout(() => finish(0), 800);
    },
  });
}

async function cmdSend(args) {
  const raw = args._[1];
  if (!raw) { console.error('usage: send \'{"type":"..."}\''); process.exit(2); }
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { console.error(`bad JSON: ${e.message}`); process.exit(2); }
  await run(args, null, {
    oneShot: true,
    onWelcome(bot, log, finish) {
      bot.send(msg);
      log(`sent ${JSON.stringify(msg)}`);
      // Print whatever comes back for a moment -- this command exists to probe
      // server messages we don't understand yet.
      setTimeout(() => finish(0), Number(args.wait || 2) * 1000);
    },
  });
}

async function cmdHeal(args) {
  await ensureMaps(true);
  await run(args, (bot, log) => makeHeal({ forceHealer: !!args.healer, log }));
}

async function cmdFollow(args) {
  await ensureMaps(args.quiet);
  const target = args._[1];
  if (!target) { console.error('usage: follow <player-name> [--keep <tiles>]'); process.exit(2); }
  await run(args, (bot, log) => makeFollow(target, num(args.keep, 2) * TILE, log));
}

async function cmdMove(args) {
  await ensureMaps(args.quiet);
  const spec = args._[1];
  if (!spec) { console.error("usage: move <x,y | location | player-name>"); process.exit(2); }
  await run(args, (bot, log) => makeMove(spec, log));
}

// ---- swarm ----------------------------------------------------------------

/**
 * Shared readiness tunables, from the flags every swarm command accepts.
 *
 * Note the two defaults that are set HERE rather than on PartyConfig, because
 * both exist to stop the combat gate chattering and both are off in the class
 * defaults:
 *
 *  * `readinessSmooth` 0.4 -- the EMA weight. PartyConfig defaults to 1.0 (raw,
 *    no smoothing) and the CLI has always overridden it; without this a one-tick
 *    straggle or transient threat slams the gate open/shut.
 *  * `combatExit` = threshold - 0.15 -- the hysteresis band. Without it, exit and
 *    enter are the same number and the party flip-flops at the boundary.
 */
function partyCfgOf(args, memberNames) {
  const threshold = num(args.threshold, 0.6);
  return new PartyConfig({
    memberNames,
    rallyPx: num(args.rally, 4) * TILE,
    threatPx: num(args.threat, 8) * TILE,
    combatThreshold: threshold,
    combatExit: args['combat-exit'] !== undefined
      ? num(args['combat-exit'])
      : Math.max(0.0, threshold - 0.15),
    readinessSmooth: num(args['readiness-smooth'], 0.4),
    cohesionSlack: num(args['cohesion-slack'], 2.5),
    huntEnter: num(args['hunt-enter'], 0.5),
    huntExit: num(args['hunt-exit'], 0.3),
    huntTypes: args.hunt && args.hunt !== '*' ? String(args.hunt).split(',') : null,
  });
}

const memberList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

async function cmdLead(args) {
  await ensureMaps(args.quiet);
  const members = memberList(args.members);
  const cfg = partyCfgOf(args, members);
  await run(args, (bot, log) =>
    makeSwarmLeader(cfg, num(args['focus-radius'], 6) * TILE, log));
}

async function cmdEscort(args) {
  await ensureMaps(args.quiet);
  const leaderName = args._[1];
  if (!leaderName) { console.error('usage: escort <leader-name> [flags]'); process.exit(2); }
  const intent = String(args.intent || 'follow');
  const formation = String(args.formation || 'none');
  if (!INTENTS.includes(intent)) {
    console.error(`--intent must be one of ${INTENTS.join('|')}`); process.exit(2);
  }
  if (!FORMATIONS.includes(formation)) {
    console.error(`--formation must be one of ${FORMATIONS.join('|')}`); process.exit(2);
  }
  const members = memberList(args.members);
  const cfg = partyCfgOf(args, members);
  await run(args, (bot, log) => makeSwarm(
    leaderName.toLowerCase(), cfg, num(args['focus-radius'], 6) * TILE,
    false, intent, formation, log));
}

/**
 * The whole hive in ONE process.
 *
 * Python spawned a child process per character, because a blocking socket loop
 * can only drive one. Node's event loop holds them all at once, so a swarm is
 * just N connections in this process -- no subprocess plumbing, no log
 * interleaving, and Ctrl-C actually stops everything.
 */
async function cmdSwarm(args) {
  await ensureMaps(args.quiet);

  const escorts = memberList(args.escort).map((spec) => {
    const [account, intent, formation] = spec.split(':').map((s) => s && s.trim());
    return {
      account,
      intent: intent || String(args.intent || 'follow'),
      formation: formation || String(args.formation || 'none'),
    };
  });
  if (!escorts.length) { console.error('--escort is required'); process.exit(2); }
  if (!args.leader && !args.follow) {
    console.error('pass --leader <account> (bot leader) or --follow <name> (human leader)');
    process.exit(2);
  }

  // Cohesion is measured over these names, so they must be what's in-world.
  // Log in first to resolve each account to its character name -- an account
  // name that isn't the character name would silently never match anyone.
  const { loadAccounts, resolveAccount, pickCharacter, connect } =
    await import('../transport/node.js');
  const accounts = loadAccounts(args.creds);

  const resolve = async (who) => {
    const { acct, session, chars } = await resolveAccount(accounts, who);
    // Each hive member picks its OWN account's first character; --character
    // would name one character and can't apply across several accounts.
    return { acct, session, character: pickCharacter(chars, null) };
  };

  const leaderSpec = args.leader ? await resolve(args.leader) : null;
  const escortSpecs = await Promise.all(escorts.map(async (e) => ({
    ...e, ...(await resolve(e.account)),
  })));

  const leaderName = leaderSpec
    ? leaderSpec.character.name.toLowerCase()
    : String(args.follow).toLowerCase();
  const memberNames = escortSpecs.map((e) => e.character.name.toLowerCase());
  if (leaderSpec) memberNames.push(leaderName);

  if (args['dry-run']) {
    console.log(`leader: ${leaderSpec ? leaderSpec.character.name : `${args.follow} (human)`}`);
    for (const e of escortSpecs) {
      console.log(`escort: ${e.character.name} (${e.acct.username}) `
        + `intent=${e.intent} formation=${e.formation}`);
    }
    console.log(`members for cohesion: ${memberNames.join(', ')}`);
    return;
  }

  const cfg = partyCfgOf(args, memberNames);
  const focusPx = num(args['focus-radius'], 6) * TILE;
  const bots = [];

  const spawn = (spec, makeIntent) => {
    const tag = spec.character.name;
    const log = (m) => console.log(`[${tag}] ${m}`);
    // Built before connecting, so no frame can arrive at a null bot -- see the
    // same indirection in run().
    let send = () => false;
    const bot = new AvalonBot((payload) => send(payload));
    let intent = null;
    const conn = connect({
      session: spec.session,
      characterToken: spec.character.characterToken || spec.character.token,
      onJson(msg) {
        bot.onJson(msg);
        if (msg?.type === 'welcome') { log('joined'); intent = makeIntent(bot, log); }
        else if (msg?.type === 'joinRejected') log(`!! join rejected: ${msg.reason || ''}`);
      },
      onBinary(buf) {
        const snap = bot.onBinary(buf);
        if (!snap || !intent) return;
        try { intent(bot, snap); } catch (e) { log(`!! ${e.message}`); }
      },
      onClose() { log('socket closed'); },
    });
    send = conn.send;
    bot.onJsonMessage((b, msg) => handleDialogue(b, msg, log));
    bot.onJsonMessage((b, msg) => handleDepot(b, msg, log));
    bot.onJsonMessage((b, msg) => handleLootRefusal(b, msg, log));
    bots.push({ bot, conn, tag });
  };

  if (leaderSpec) spawn(leaderSpec, (bot, log) => makeSwarmLeader(cfg, focusPx, log));
  for (const e of escortSpecs) {
    spawn(e, (bot, log) =>
      makeSwarm(leaderName, cfg, focusPx, false, e.intent, e.formation, log));
  }
  console.log(`swarm up: ${bots.length} characters, leader=${leaderName}`);

  const shutdown = () => {
    console.log('stopping swarm');
    for (const b of bots) { try { b.bot.move(0, 0); b.conn.ws.close(); } catch { /* already gone */ } }
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGINT', shutdown);
  if (args.duration) setTimeout(shutdown, Number(args.duration) * 1000);
}

async function cmdMaps(args) {
  const fs = await import('node:fs');
  const out = args.out || 'avalon_maps.json';
  const path = await liveBundlePath();
  console.log(`live bundle: ${path}`);
  const maps = await extractFromLive();
  fs.writeFileSync(out, JSON.stringify(maps));
  for (const z of Object.keys(maps).filter((k) => k !== 'bundle').sort((a, b) => a - b)) {
    const zn = maps[z];
    const blocked = zn.rows.reduce((n, r) => n + [...r].filter((c) => c === '#').length, 0);
    const tot = zn.widthTiles * zn.heightTiles;
    console.log(`z=${z}: ${zn.widthTiles}x${zn.heightTiles}  `
      + `blocked=${blocked}/${tot} (${Math.round(100 * blocked / tot)}%)  `
      + `teleports=${zn.teleports.length}`);
  }
  console.log(`wrote ${out}`);
}

// ---- entry ----------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

const COMMANDS = {
  farm: cmdFarm, where: cmdWhere, respawn: cmdRespawn, send: cmdSend, maps: cmdMaps,
  lead: cmdLead, escort: cmdEscort, swarm: cmdSwarm,
  heal: cmdHeal, follow: cmdFollow, move: cmdMove,
};

if (!cmd || args.help || cmd === 'help') { usage(); process.exit(cmd ? 0 : 2); }
const fn = COMMANDS[cmd];
if (!fn) { console.error(`unknown command: ${cmd}\n`); usage(); process.exit(2); }

fn(args).catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
