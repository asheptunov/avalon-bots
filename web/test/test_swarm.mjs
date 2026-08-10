// Port-fidelity tests for the swarm: the JS must behave like avalon.py's
// make_swarm / make_swarm_leader and the readiness model behind them.
//
// Run: node --test web/test/test_swarm.mjs
//
// These target what a careless port silently drops -- the places where the Python
// source carries a comment explaining a bug it already paid for:
//   * readiness factors (missing members score 0; a critical member pins the score)
//   * EMA smoothing and the hysteretic combat gate (chatter at the boundary)
//   * the leader's hunt_enter/hunt_exit hysteresis (the one-step-out/in drift)
//   * magnetize's FAR (A* to the leader) vs NEAR (force balance) split
//   * cross-floor follow: only chase when the leader vanished ON a teleport
//   * `follow` keying off the LEADER's fight, not any member's

import assert from 'node:assert/strict';
import { test } from 'node:test';

// Import via file:// URLs -- on Windows a bare absolute path ('C:\...') is not a
// valid ESM specifier.
const SRC = new URL('../src/', import.meta.url);
const load = (m) => import(new URL(m, SRC).href);

const { TILE, MELEE_RANGE_PX } = await load('core/protocol.js');
const { AvalonBot } = await load('core/bot.js');
const nav = await load('core/nav.js');
const swarm = await load('core/swarm.js');

// ---- fixtures --------------------------------------------------------------

function makeBot(id = 'me') {
  const sent = [];
  const bot = new AvalonBot((p) => { sent.push(p); return true; });
  bot.me = id;
  bot.z = 0;
  bot.sent = sent;
  return bot;
}

const jsonSent = (bot) => bot.sent
  .filter((s) => typeof s === 'string').map((s) => JSON.parse(s));
const binSent = (bot) => bot.sent
  .filter((s) => s instanceof ArrayBuffer).map((s) => new Uint8Array(s));
const attacked = (bot) => binSent(bot).some((b) => b[0] === 2);
/** The (dx,dy) of the last move opcode sent, or null. */
function lastMove(bot) {
  const moves = binSent(bot).filter((b) => b[0] === 1);
  if (!moves.length) return null;
  const b = moves[moves.length - 1];
  const sign = (v) => (v > 127 ? v - 256 : v);
  return [sign(b[1]), sign(b[2])];
}

const P = (o) => ({ id: 'p', name: 'P', x: 0, y: 0, hp: 100, maxHp: 100, ...o });
const M = (o) => ({
  id: 'm', monsterType: 'rat', x: 0, y: 0, hp: 10, maxHp: 10, enraged: false, ...o,
});
const snapOf = (players = [], monsters = []) => ({ players, monsters, npcs: [] });

const cfgOf = (o = {}) => new swarm.PartyConfig({
  memberNames: ['lead', 'esc'], rallyPx: TILE * 4, threatPx: TILE * 8, ...o,
});

// A tiny open map so navStep produces real A* steps rather than the no-map
// greedy fallback (the two differ, and magnetize's FAR/NEAR split is about A*).
const OPEN_MAP = {
  bundle: 'test',
  0: {
    widthTiles: 40, heightTiles: 40,
    rows: Array.from({ length: 40 }, () => '.'.repeat(40)),
    teleports: [
      { fromTile: [5, 5], toTile: [5, 5], toZ: -1, oneWay: false, mode: 'walk' },
      { fromTile: [30, 30], toTile: [30, 30], toZ: 1, oneWay: false, mode: 'interact' },
    ],
  },
  '-1': {
    widthTiles: 40, heightTiles: 40,
    rows: Array.from({ length: 40 }, () => '.'.repeat(40)),
    teleports: [
      { fromTile: [5, 5], toTile: [5, 5], toZ: 0, oneWay: false, mode: 'interact' },
    ],
  },
};

// ---- target selection ------------------------------------------------------

test('pickFocusMonster takes the LOWEST-hp monster in radius -- this is what makes '
  + 'independent bots converge on one target', () => {
  const leader = P({ x: 0, y: 0 });
  const snap = snapOf([], [
    M({ id: 'fat', hp: 9, x: TILE, y: 0 }),
    M({ id: 'weak', hp: 2, x: TILE * 3, y: 0 }),
    M({ id: 'weakest-but-far', hp: 1, x: TILE * 50, y: 0 }),
    M({ id: 'dead', hp: 0, x: TILE, y: 0 }),
  ]);
  assert.equal(swarm.pickFocusMonster(snap, leader, TILE * 10).id, 'weak');
  assert.equal(swarm.pickFocusMonster(snap, null, TILE * 10), null,
    'no leader -> no anchor to focus around');
});

test('pickFocusMonster honours huntTypes so the pack does not dogpile a dummy', () => {
  const leader = P();
  const snap = snapOf([], [
    M({ id: 'dummy', monsterType: 'trainingDummy', hp: 1, x: TILE }),
    M({ id: 'rat', monsterType: 'rat', hp: 5, x: TILE }),
  ]);
  assert.equal(swarm.pickFocusMonster(snap, leader, TILE * 10, ['rat']).id, 'rat');
  assert.equal(swarm.pickFocusMonster(snap, leader, TILE * 10).id, 'dummy',
    'null huntTypes means anything');
});

test('leaderEngagedWith needs enraged AND melee-scale range to the LEADER', () => {
  const leader = P({ x: 0, y: 0 });
  const near = M({ x: MELEE_RANGE_PX, y: 0, enraged: true });
  assert.equal(swarm.leaderEngagedWith(near, leader), true);
  assert.equal(swarm.leaderEngagedWith({ ...near, enraged: false }, leader), false,
    'an idle mob at the leader\'s feet is not the leader\'s fight');
  assert.equal(swarm.leaderEngagedWith({ ...near, hp: 0 }, leader), false);
  assert.equal(
    swarm.leaderEngagedWith({ ...near, x: TILE * 6 }, leader), false,
    'an escort\'s own fight a few tiles off must NOT read as the leader\'s');
  assert.equal(swarm.leaderEngagedWith(near, null), false);
});

test('threatsToParty is lowest-hp-first and ignores huntTypes -- defence is '
  + 'self-defence, not hunting', () => {
  const members = new Map([['esc', P({ id: 'e', x: 0, y: 0 })]]);
  const snap = snapOf([], [
    M({ id: 'orc', monsterType: 'orc', hp: 40, x: TILE, enraged: true }),
    M({ id: 'rat', monsterType: 'rat', hp: 3, x: TILE, enraged: true }),
    M({ id: 'idle', monsterType: 'rat', hp: 1, x: TILE, enraged: false }),
    M({ id: 'far', monsterType: 'orc', hp: 1, x: TILE * 50, enraged: true }),
  ]);
  const got = swarm.threatsToParty(snap, members, TILE * 8).map((m) => m.id);
  assert.deepEqual(got, ['rat', 'orc'],
    'an orc that aggroed us is fended off even on a rat hunt; idle mobs are left alone');
});

test('swarmTarget: follow fires only on the LEADER\'s fight, defend on any '
  + 'member\'s, attack unprompted', () => {
  const cfg = cfgOf();
  const leader = P({ id: 'L', name: 'lead', x: 0, y: 0 });
  const escort = P({ id: 'E', name: 'esc', x: TILE * 20, y: 0 });
  const members = new Map([['lead', leader], ['esc', escort]]);
  // A monster fighting the ESCORT, far from the leader.
  const onEscort = M({ id: 'onEsc', hp: 4, x: TILE * 20, y: 0, enraged: true });
  const snap = snapOf([leader, escort], [onEscort]);

  assert.equal(
    swarm.swarmTarget('follow', snap, leader, leader, members, TILE * 30, cfg), null,
    'follow must not be dragged in by an escort\'s own fight -- the leader keeps control');
  assert.equal(
    swarm.swarmTarget('defend', snap, leader, leader, members, TILE * 30, cfg).id,
    'onEsc', 'defend peels to a member under attack');
  assert.equal(
    swarm.swarmTarget('attack', snap, leader, leader, members, TILE * 30, cfg).id,
    'onEsc', 'attack hunts unprompted');

  // Now put the fight on the leader.
  const onLead = M({ id: 'onLead', hp: 7, x: MELEE_RANGE_PX / 2, y: 0, enraged: true });
  const snap2 = snapOf([leader, escort], [onEscort, onLead]);
  assert.equal(
    swarm.swarmTarget('follow', snap2, leader, leader, members, TILE * 30, cfg).id,
    'onLead', 'follow joins exactly what the leader is fighting');
});

test('swarmTarget with an unknown intent behaves like attack', () => {
  const cfg = cfgOf();
  const leader = P({ x: 0, y: 0 });
  const snap = snapOf([], [M({ id: 'r', hp: 3, x: TILE })]);
  assert.equal(
    swarm.swarmTarget('nonsense', snap, leader, leader, new Map(), TILE * 10, cfg).id,
    'r');
});

// ---- readiness factors -----------------------------------------------------

test('partyMembers keys by the NAME we asked for, and misses stay absent', () => {
  const cfg = cfgOf({ memberNames: ['sam', 'dario'] });
  const snap = snapOf([
    P({ id: 'a', name: 'Sam Altman' }),
    P({ id: 'b', name: 'Nobody' }),
  ]);
  const got = swarm.partyMembers(snap, cfg, 'sam');
  assert.deepEqual([...got.keys()].sort(), ['sam']);
  assert.equal(got.get('sam').id, 'a');
  assert.equal(got.has('dario'), false, 'an offline member simply does not appear');
});

test('factorCohesion: 1.0 assembled, and MISSING members drag it down', () => {
  const cfg = cfgOf({ memberNames: ['lead', 'esc'] });
  const leader = P({ id: 'L', name: 'lead', x: 0, y: 0 });
  const close = P({ id: 'E', name: 'esc', x: 0, y: 0 });
  const snap = snapOf([leader, close]);

  const both = new Map([['lead', leader], ['esc', close]]);
  assert.equal(swarm.factorCohesion(both, leader, snap, cfg), 1.0);

  const alone = new Map([['lead', leader]]);
  assert.equal(swarm.factorCohesion(alone, leader, snap, cfg), 0.5,
    'a missing member contributes 0 out of 2 expected');

  assert.equal(swarm.factorCohesion(both, null, snap, cfg), 0.0,
    'no leader -> nothing to be cohesive around');
});

// REGRESSION GUARD for a bug inherited from avalon.py and fixed in this port.
//
// The Python denominator was `set(memberNames) | {leader.name.toLowerCase()}`,
// which mixes match QUERIES ('lead') with the leader's DISPLAY name ('lead
// bot'). When they differ -- which forgiving name matching exists to allow --
// the union gained a phantom entry, the leader was counted twice, and a party
// standing on a single tile scored 2/3 instead of 1.0. Cohesion could never
// reach the combat gate, so the hive regrouped forever with nothing logged.
//
// The denominator is now "members + leader", which counts bodies rather than
// names and so cannot be perturbed by how a member was spelled.
test('cohesion is 1.0 for a stacked party even when the leader query and its '
  + 'display name differ (leader must not be double-counted)', () => {
  const cfg = cfgOf({ memberNames: ['lead', 'esc'] });
  const leader = P({ id: 'L', name: 'Lead Bot', x: 0, y: 0 });
  const escort = P({ id: 'E', name: 'Esc', x: 0, y: 0 });
  const snap = snapOf([leader, escort]);
  const members = swarm.partyMembers(snap, cfg, 'lead');
  assert.deepEqual([...members.keys()].sort(), ['esc', 'lead'],
    'both members resolve');
  assert.equal(swarm.factorCohesion(members, leader, snap, cfg), 1.0,
    'perfectly stacked -> 1.0 regardless of how the leader was named');

  // And it still agrees when the query happens to equal the display name.
  const exact = P({ id: 'L', name: 'lead', x: 0, y: 0 });
  assert.equal(
    swarm.factorCohesion(new Map([['lead', exact], ['esc', escort]]), exact,
      snapOf([exact, escort]), cfg),
    1.0, 'matching names give the same answer');
});

test('factorCohesion falls off linearly and hits 0 past rallyPx*cohesionSlack', () => {
  const cfg = cfgOf({ memberNames: ['lead'], rallyPx: 100, cohesionSlack: 2.0 });
  const leader = P({ id: 'L', name: 'lead', x: 0, y: 0 });
  const snap = snapOf([leader]);
  const at = (x) => swarm.factorCohesion(
    new Map([['lead', { ...leader, x }]]), leader, snap, cfg);
  assert.equal(at(0), 1.0);
  assert.ok(Math.abs(at(100) - 0.5) < 1e-9, 'at rallyPx with slack 2 -> 0.5');
  assert.equal(at(200), 0.0, 'at the slack boundary -> 0');
  assert.equal(at(10000), 0.0, 'clamped at 0, never negative');
});

test('factorHealth pins to the WORST member once anyone is critical', () => {
  const cfg = cfgOf({ lowHpFrac: 0.35 });
  const snap = snapOf([]);
  const healthy = new Map([
    ['a', P({ hp: 100, maxHp: 100 })], ['b', P({ hp: 50, maxHp: 100 })]]);
  assert.equal(swarm.factorHealth(healthy, null, snap, cfg), 0.75, 'mean when all ok');

  const dying = new Map([
    ['a', P({ hp: 100, maxHp: 100 })], ['b', P({ hp: 10, maxHp: 100 })]]);
  assert.ok(Math.abs(swarm.factorHealth(dying, null, snap, cfg) - 0.1) < 1e-9,
    'a near-dead member means P(win) is poor -- not the comfortable 0.55 mean');

  assert.equal(swarm.factorHealth(new Map(), null, snap, cfg), 0.0,
    'an empty party is not ready (Python: `if not members: return 0`)');
});

test('factorThreat is 1.0 with no aggro near, and collapses to cohesion when '
  + 'orcs are close to an unassembled party', () => {
  const cfg = cfgOf({ memberNames: ['lead', 'esc'], threatPx: TILE * 8 });
  const leader = P({ id: 'L', name: 'lead', x: 0, y: 0 });
  const straggler = P({ id: 'E', name: 'esc', x: TILE * 100, y: 0 });
  const members = new Map([['lead', leader], ['esc', straggler]]);

  const calm = snapOf([], [M({ monsterType: 'rat', x: TILE })]);
  assert.equal(swarm.factorThreat(members, leader, calm, cfg), 1.0,
    'a rat is not auto-aggro -- it does not gate anything');

  const orcNear = snapOf([], [M({ monsterType: 'orc', x: TILE * 2 })]);
  assert.equal(swarm.factorThreat(members, leader, orcNear, cfg),
    swarm.factorCohesion(members, leader, orcNear, cfg),
    'aggro present -> readiness rides entirely on being assembled');

  const orcFar = snapOf([], [M({ monsterType: 'orc', x: TILE * 100 })]);
  assert.equal(swarm.factorThreat(members, leader, orcFar, cfg), 1.0);
  assert.equal(swarm.factorThreat(members, null, orcNear, cfg), 1.0,
    'no leader -> the threat factor abstains (Python returns 1.0)');
});

test('partyReadiness is the PRODUCT of the factors and hands back the party', () => {
  const cfg = cfgOf({ memberNames: ['lead', 'esc'] });
  const leader = P({ id: 'L', name: 'lead', x: 0, y: 0, hp: 100, maxHp: 100 });
  const escort = P({ id: 'E', name: 'esc', x: 0, y: 0, hp: 50, maxHp: 100 });
  const snap = snapOf([leader, escort]);
  const { score, members, leader: got } = swarm.partyReadiness(snap, cfg, 'lead');
  // cohesion 1.0 * health 0.75 * threat 1.0
  assert.ok(Math.abs(score - 0.75) < 1e-9);
  assert.equal(members.size, 2);
  assert.equal(got.id, 'L');
});

test('readinessWithoutCohesion drops ONLY cohesion -- but factorThreat still '
  + 'folds it back in when aggro is near (the attack-mode safety)', () => {
  const cfg = cfgOf({ memberNames: ['lead', 'esc'] });
  const leader = P({ id: 'L', name: 'lead', x: 0, y: 0 });
  const straggler = P({ id: 'E', name: 'esc', x: TILE * 100, y: 0 });

  const passive = snapOf([leader, straggler], [M({ monsterType: 'rat', x: TILE })]);
  assert.equal(swarm.readinessWithoutCohesion(passive, cfg, 'lead'), 1.0,
    'against passive prey, attack mode ignores clustering entirely');

  const aggro = snapOf([leader, straggler], [M({ monsterType: 'orc', x: TILE * 2 })]);
  assert.ok(swarm.readinessWithoutCohesion(aggro, cfg, 'lead') < 1.0,
    'against an orc it still refuses to charge in unassembled');
});

// ---- smoothing + the combat gate -------------------------------------------

test('smoothReadiness with alpha>=1.0 is a passthrough and stores nothing', () => {
  const bot = makeBot();
  const cfg = cfgOf({ readinessSmooth: 1.0 });
  assert.equal(swarm.smoothReadiness(bot, 0.4, cfg), 0.4);
  assert.equal(bot.run.readyEma, undefined);
});

test('smoothReadiness blends toward the raw value and treats a stored 0.0 as '
  + 'history, not as "no history"', () => {
  const bot = makeBot();
  const cfg = cfgOf({ readinessSmooth: 0.5 });
  assert.equal(swarm.smoothReadiness(bot, 1.0, cfg), 1.0, 'first sample seeds the EMA');
  assert.equal(swarm.smoothReadiness(bot, 0.0, cfg), 0.5);
  assert.equal(swarm.smoothReadiness(bot, 0.0, cfg), 0.25);
  // Now drive it to exactly 0 and confirm the next sample BLENDS with it rather
  // than restarting (a `prev ||` falsy test would wrongly return raw here).
  bot.run.readyEma = 0.0;
  assert.equal(swarm.smoothReadiness(bot, 1.0, cfg), 0.5,
    'an EMA of exactly 0.0 is a real value that must be blended');
});

test('smoothReadiness keeps independent lanes per slot', () => {
  const bot = makeBot();
  const cfg = cfgOf({ readinessSmooth: 0.5 });
  swarm.smoothReadiness(bot, 1.0, cfg);                 // readyEma = 1.0
  swarm.smoothReadiness(bot, 0.0, cfg, 'gateEma');      // gateEma  = 0.0
  assert.equal(swarm.smoothReadiness(bot, 1.0, cfg, 'gateEma'), 0.5);
  assert.equal(bot.run.readyEma, 1.0, 'the other lane must not be cross-contaminated');
});

test('combatGo is hysteretic: enter at threshold, keep going until below exit', () => {
  const bot = makeBot();
  const cfg = cfgOf({ combatThreshold: 0.6, combatExit: 0.4 });
  assert.equal(swarm.combatGo(bot, 0.5, cfg), false, 'below threshold -> hold');
  assert.equal(swarm.combatGo(bot, 0.6, cfg), true, 'at threshold -> engage');
  assert.equal(swarm.combatGo(bot, 0.5, cfg), true,
    'in the band -> KEEP fighting (this is what stops gate chatter)');
  assert.equal(swarm.combatGo(bot, 0.4, cfg), true, 'at exit -> still fighting');
  assert.equal(swarm.combatGo(bot, 0.39, cfg), false, 'below exit -> disengage');
  assert.equal(swarm.combatGo(bot, 0.5, cfg), false,
    'back in the band from below -> stay held until the full threshold');
});

test('combatExit defaults to combatThreshold, i.e. no hysteresis unless asked', () => {
  const cfg = cfgOf({ combatThreshold: 0.6 });
  assert.equal(cfg.combatExit, 0.6);
  const bot = makeBot();
  swarm.combatGo(bot, 0.6, cfg);
  assert.equal(swarm.combatGo(bot, 0.59, cfg), false);
});

test('PartyConfig defaults followGapPx to rallyPx', () => {
  assert.equal(cfgOf({ rallyPx: 123 }).followGapPx, 123);
  assert.equal(cfgOf({ rallyPx: 123, followGapPx: 7 }).followGapPx, 7);
});

// ---- station keeping -------------------------------------------------------

test('partyCentroid averages and can exclude self; empty -> null', () => {
  const members = new Map([
    ['a', P({ id: 'a', x: 0, y: 0 })],
    ['b', P({ id: 'b', x: 100, y: 200 })],
  ]);
  assert.deepEqual(swarm.partyCentroid(members), [50, 100]);
  assert.deepEqual(swarm.partyCentroid(members, 'a'), [100, 200]);
  assert.equal(swarm.partyCentroid(new Map()), null);
  assert.equal(swarm.partyCentroid(members, 'a') && swarm.partyCentroid(
    new Map([['a', P({ id: 'a' })]]), 'a'), null,
  'excluding the only member yields null, not [NaN,NaN]');
});

test('followLeaderStep holds inside followGapPx and closes outside it', () => {
  nav.loadMaps(OPEN_MAP);
  const bot = makeBot();
  bot.run.occupied = new Set();
  const cfg = cfgOf({ rallyPx: TILE * 4 });
  const leader = P({ id: 'L', x: TILE * 10, y: TILE * 10 });
  const close = P({ id: 'me', x: TILE * 11, y: TILE * 10 });
  assert.deepEqual(
    swarm.followLeaderStep(bot, close, leader, snapOf([], []), cfg), [0, 0],
    'do not crowd the leader');

  const far = P({ id: 'me', x: TILE * 20, y: TILE * 10 });
  const step = swarm.followLeaderStep(bot, far, leader, snapOf([], []), cfg);
  assert.deepEqual(step, [-1, 0], 'close the gap toward the leader');
  assert.deepEqual(swarm.followLeaderStep(bot, far, null, snapOf([], []), cfg), [0, 0],
    'no leader -> no step');
});

test('rallyStep converges on the party centroid, EXCLUDING self', () => {
  const cfg = cfgOf({ threatPx: TILE * 8 });
  const me = P({ id: 'me', x: 0, y: 0 });
  const mate = P({ id: 'o', x: TILE * 10, y: 0 });
  const members = new Map([['me', me], ['o', mate]]);
  assert.deepEqual(swarm.rallyStep(me, members, snapOf([], []), cfg, null), [1, 0],
    'walk toward the pack; including self would halve the pull toward it');
});

test('rallyStep falls back to the leader, then to standing still', () => {
  const cfg = cfgOf();
  const me = P({ id: 'me', x: 0, y: 0 });
  const solo = new Map([['me', me]]);   // centroid excluding self is empty -> null
  const leader = P({ id: 'L', x: -TILE * 5, y: 0 });
  assert.deepEqual(swarm.rallyStep(me, solo, snapOf([], []), cfg, leader), [-1, 0]);
  assert.deepEqual(swarm.rallyStep(me, solo, snapOf([], []), cfg, null), [0, 0],
    'no centroid and no leader -> aim at ourselves -> hold');
});

test('rallyStep\'s threat repulsion is an ADDITIVE nudge, so a distant pack still '
  + 'wins -- it deflects the approach, it does not veto it', () => {
  const cfg = cfgOf({ threatPx: TILE * 8 });
  const me = P({ id: 'me', x: 0, y: 0 });
  const members = new Map([['me', me], ['o', P({ id: 'o', x: TILE * 10, y: 0 })]]);
  // Orc 2 tiles ahead: the nudge is (me - thr) = -64, against a centroid at +320.
  const near = M({ monsterType: 'orc', x: TILE * 2, y: 0 });
  assert.deepEqual(swarm.rallyStep(me, members, snapOf([], [near]), cfg, null), [1, 0],
    'still closes on the pack -- the nudge is smaller than the gap');

  // Same geometry, but the pack is close enough that the nudge dominates and the
  // straggler backs off instead of walking into the orc.
  const tight = new Map([['me', me], ['o', P({ id: 'o', x: TILE, y: 0 })]]);
  assert.deepEqual(swarm.rallyStep(me, tight, snapOf([], [near]), cfg, null), [-1, 0],
    'do not stroll through the line of fire to close a one-tile gap');

  // A rat is not auto-aggro, so it exerts no repulsion at all.
  const rat = M({ monsterType: 'rat', x: TILE, y: 0 });
  assert.deepEqual(swarm.rallyStep(me, tight, snapOf([], [rat]), cfg, null), [1, 0]);
});

test('magnetizeStep FAR: outside 1.25*ring it A*-paths to the LEADER, so walls '
  + 'never trap it against a force-projected goal', () => {
  nav.loadMaps(OPEN_MAP);
  const bot = makeBot();
  bot.run.occupied = new Set();
  const cfg = cfgOf({ followGapPx: TILE * 2 });
  const leader = P({ id: 'L', x: TILE * 10, y: TILE * 10 });
  const me = P({ id: 'me', x: TILE * 20, y: TILE * 10 });
  const step = swarm.magnetizeStep(bot, me, leader, new Map(), snapOf([], []), cfg);
  assert.deepEqual(step, [-1, 0]);
  assert.ok(bot.run.path, 'FAR must go through A*, not a raw force vector');
  assert.equal(bot.run.path.goalX, nav.tileOf(leader.x),
    'the A* goal is the LEADER, always a reachable target');
});

test('magnetizeStep NEAR: sitting on the ring is a no-op (deadband), and being '
  + 'too close pushes OUTWARD', () => {
  nav.loadMaps(OPEN_MAP);
  const bot = makeBot();
  bot.run.occupied = new Set();
  const ring = TILE * 3;
  const cfg = cfgOf({ followGapPx: ring });
  const leader = P({ id: 'L', x: TILE * 10, y: TILE * 10 });

  const onRing = P({ id: 'me', x: TILE * 10 + ring, y: TILE * 10 });
  assert.deepEqual(
    swarm.magnetizeStep(bot, onRing, leader, new Map(), snapOf([], []), cfg), [0, 0],
    'on station -> hold; the deadband is what stops the ring jittering');

  // Inside the ring but within the 1.25 hysteresis band -> NEAR regime, spring out.
  const tooClose = P({ id: 'me', x: TILE * 10 + TILE, y: TILE * 10 });
  const step = swarm.magnetizeStep(bot, tooClose, leader, new Map(), snapOf([], []), cfg);
  assert.deepEqual(step, [1, 0], 'the ring spring is symmetric: too close -> push out');
});

test('magnetizeStep NEAR separates escorts stacked on the same tile', () => {
  nav.loadMaps(OPEN_MAP);
  const bot = makeBot();
  bot.run.occupied = new Set();
  const ring = TILE * 3;
  const cfg = cfgOf({ followGapPx: ring });
  const leader = P({ id: 'L', x: TILE * 10, y: TILE * 10 });
  // Two escorts both parked on the ring at the same spot: separation must move us.
  const me = P({ id: 'me', x: TILE * 10 + ring, y: TILE * 10 });
  const twin = P({ id: 'twin', x: TILE * 10 + ring, y: TILE * 10 + 4 });
  const members = new Map([['L', leader], ['me', me], ['twin', twin]]);
  const step = swarm.magnetizeStep(bot, me, leader, members, snapOf([], []), cfg);
  assert.notDeepEqual(step, [0, 0],
    'even spacing emerges from the neighbour-separation term');
  assert.ok(step[1] <= 0, 'push away from the neighbour sitting just below us');
});

test('magnetizeStep with no leader degrades to a plain follow', () => {
  const bot = makeBot();
  bot.run.occupied = new Set();
  const cfg = cfgOf();
  assert.deepEqual(
    swarm.magnetizeStep(bot, P({ id: 'me' }), null, new Map(), snapOf([], []), cfg),
    [0, 0]);
});

// ---- cross-floor follow ----------------------------------------------------

test('trackLeader records floor+tile and re-arms the one-shot notes', () => {
  const bot = makeBot();
  bot.z = -1;
  bot.run.xfloorNote = 'stale';
  bot.run.homeNote = 'stale';
  swarm.trackLeader(bot, P({ x: TILE * 7 + 3, y: TILE * 9 - 2 }));
  assert.equal(bot.run.leaderLast.z, -1);
  assert.deepEqual(bot.run.leaderLast.tile, [7, 9], 'tileOf ROUNDS, matching the server');
  assert.equal(bot.run.xfloorNote, null, 'a fresh sighting re-arms the note');
  assert.equal(bot.run.homeNote, null);

  swarm.trackLeader(bot, null);
  assert.ok(bot.run.leaderLast, 'losing sight must NOT erase the last-seen tile');
});

test('followAcrossFloors chases ONLY when the leader vanished on a teleport', () => {
  nav.loadMaps(OPEN_MAP);
  const cfg = cfgOf();
  const me = P({ id: 'me', x: TILE * 5, y: TILE * 8 });

  // Never saw the leader -> nothing to chase.
  const blind = makeBot();
  blind.run.occupied = new Set();
  assert.equal(swarm.followAcrossFloors(blind, me, snapOf([], [])), false);

  // Last seen far from any teleport -> they just walked out of view. Hold.
  const walkedOff = makeBot();
  walkedOff.run.occupied = new Set();
  walkedOff.run.leaderLast = { z: 0, tile: [20, 20] };
  assert.equal(swarm.followAcrossFloors(walkedOff, me, snapOf([], [])), false,
    'do not dive down a hole just because they left the screen');

  // Last seen ON the hole at (5,5) -> take it.
  const chasing = makeBot();
  chasing.run.occupied = new Set();
  chasing.run.leaderLast = { z: 0, tile: [5, 5] };
  const logs = [];
  assert.equal(
    swarm.followAcrossFloors(chasing, me, snapOf([], []), (m) => logs.push(m)), true);
  assert.deepEqual(lastMove(chasing), [0, -1], 'walk onto the hole');
  assert.equal(logs.length, 1);
  // The note is one-shot: a second identical tick must not re-log.
  swarm.followAcrossFloors(chasing, me, snapOf([], []), (m) => logs.push(m));
  assert.equal(logs.length, 1, 'the log line is throttled to one per teleport');
});

test('followAcrossFloors triggers within the 2-tile slop but not past it', () => {
  nav.loadMaps(OPEN_MAP);
  const me = P({ id: 'me', x: TILE * 5, y: TILE * 9 });
  const at = (tile) => {
    const bot = makeBot();
    bot.run.occupied = new Set();
    bot.run.leaderLast = { z: 0, tile };
    return swarm.followAcrossFloors(bot, me, snapOf([], []));
  };
  assert.equal(at([7, 5]), true, '2 tiles off the marker still counts as "on" it');
  assert.equal(at([8, 5]), false, '3 tiles off -> they were not at the teleport');
});

test('followAcrossFloors uses an INTERACT ladder correctly (approach, then send)', () => {
  nav.loadMaps(OPEN_MAP);
  const bot = makeBot();
  bot.run.occupied = new Set();
  bot.run.leaderLast = { z: 0, tile: [30, 30] };
  // Standing right on the ladder -> send useTeleport rather than walking.
  const onIt = P({ id: 'me', x: TILE * 30, y: TILE * 30 });
  assert.equal(swarm.followAcrossFloors(bot, onIt, snapOf([], [])), true);
  assert.ok(jsonSent(bot).some((m) => m.type === 'useTeleport'),
    'a ladder needs an explicit useTeleport; a hole needs none');
});

test('homeToSurface climbs only underground, and only when a way up is known', () => {
  nav.loadMaps(OPEN_MAP);
  const surface = makeBot();
  surface.z = 0;
  assert.equal(swarm.homeToSurface(surface, P({ id: 'me' })), false,
    'already home -> nothing to do');

  const under = makeBot();
  under.z = -1;
  under.run.occupied = new Set();
  const logs = [];
  assert.equal(
    swarm.homeToSurface(under, P({ id: 'me', x: TILE * 8, y: TILE * 5 }),
      (m) => logs.push(m)),
    true);
  assert.equal(logs.length, 1);

  const noMap = makeBot();
  noMap.z = -7;               // no map for this floor -> no known ladder
  assert.equal(swarm.homeToSurface(noMap, P({ id: 'me' })), false);
});

// ---- the escort machine ----------------------------------------------------

function escortTick(bot, snap, {
  leaderName = 'lead', cfg = cfgOf(), radius = TILE * 20,
  intent = 'follow', formation = 'none', isLeader = false,
} = {}) {
  const logs = [];
  swarm.makeSwarm(leaderName, cfg, radius, isLeader, intent, formation,
    (m) => logs.push(m))(bot, snap);
  return logs;
}

test('a dead escort respawns and does nothing else', () => {
  nav.loadMaps(OPEN_MAP);
  const bot = makeBot();
  const snap = snapOf([P({ id: 'me', name: 'esc', hp: 0 })]);
  escortTick(bot, snap);
  assert.ok(jsonSent(bot).some((m) => m.type === 'respawn'));
  assert.equal(lastMove(bot), null, 'a corpse issues no movement');
});

test('the respawn throttle does not suppress the FIRST respawn (the performance.now '
  + 'vs monotonic trap)', () => {
  nav.loadMaps(OPEN_MAP);
  const bot = makeBot();
  // performance.now() is small here; a `|| 0` default would make `now - 0 > 2.0`
  // false and swallow this respawn entirely.
  swarm.makeSwarm('lead', cfgOf(), TILE * 20, false)(
    bot, snapOf([P({ id: 'me', name: 'esc', hp: 0 })]));
  assert.ok(jsonSent(bot).some((m) => m.type === 'respawn'));
});

test('a follow escort joins the leader\'s fight once the gate opens', () => {
  nav.loadMaps(OPEN_MAP);
  const bot = makeBot();
  const leader = P({ id: 'L', name: 'lead', x: TILE * 10, y: TILE * 10 });
  const me = P({ id: 'me', name: 'esc', x: TILE * 10, y: TILE * 10 });
  const mob = M({ id: 'r', hp: 5, x: TILE * 10 + 8, y: TILE * 10, enraged: true });
  escortTick(bot, snapOf([leader, me], [mob]),
    { cfg: cfgOf({ combatThreshold: 0.5 }) });
  assert.ok(attacked(bot), 'readiness 1.0 -> engage the leader\'s target');
});

test('an escort stuck on a corner steps around it instead of freezing', () => {
  // The same corner standoff the farm loop has, and worse in a pack: the
  // focus-fire gate keeps everyone committed to a target nobody can reach.
  nav.loadMaps(OPEN_MAP);
  const bot = makeBot();
  const leader = P({ id: 'L', name: 'lead', x: TILE * 10, y: TILE * 10 });
  const me = P({ id: 'me', name: 'esc', x: TILE * 10, y: TILE * 10 });
  const mob = M({ id: 'r', hp: 5, x: TILE * 10 + 8, y: TILE * 10, enraged: true });
  const snap = snapOf([leader, me], [mob]);
  const opts = { cfg: cfgOf({ combatThreshold: 0.5 }) };
  escortTick(bot, snap, opts);                      // starts the melee clock
  bot.run.farmMeleeSince = (performance.now() / 1000) - 5;   // ...and nothing lands
  escortTick(bot, snap, opts);
  const move = lastMove(bot);
  assert.ok(move && (move[0] !== 0 || move[1] !== 0),
    'a party member must not stand still swinging at a rock');
  assert.ok(attacked(bot), 'and it keeps swinging -- that is the reachability signal');
});

test('a follow escort holds station instead of engaging when readiness is low', () => {
  nav.loadMaps(OPEN_MAP);
  const bot = makeBot();
  // Escort is critically hurt -> factorHealth pins the score and the gate stays shut.
  const leader = P({ id: 'L', name: 'lead', x: TILE * 10, y: TILE * 10 });
  const me = P({ id: 'me', name: 'esc', x: TILE * 10, y: TILE * 10, hp: 5, maxHp: 100 });
  const mob = M({ id: 'r', hp: 5, x: TILE * 10 + 8, y: TILE * 10, enraged: true });
  escortTick(bot, snapOf([leader, me], [mob]),
    { cfg: cfgOf({ combatThreshold: 0.5 }) });
  assert.equal(attacked(bot), false, 'a dying escort does not pile in');
});

test('an escort with no leader in view and nobody else holds still rather than '
  + 'wandering off', () => {
  nav.loadMaps(OPEN_MAP);
  const bot = makeBot();
  const me = P({ id: 'me', name: 'esc', x: TILE * 10, y: TILE * 10 });
  escortTick(bot, snapOf([me], []));
  assert.deepEqual(lastMove(bot), [0, 0]);
});

test('an escort with no leader but a visible party rallies to it', () => {
  nav.loadMaps(OPEN_MAP);
  const bot = makeBot();
  const me = P({ id: 'me', name: 'esc', x: TILE * 10, y: TILE * 10 });
  const mate = P({ id: 'o', name: 'esc2', x: TILE * 20, y: TILE * 10 });
  const cfg = cfgOf({ memberNames: ['esc', 'esc2'] });
  escortTick(bot, snapOf([me, mate], []), { cfg });
  assert.deepEqual(lastMove(bot), [1, 0], 'converge on the pack');
});

test('the attack intent gates WITHOUT cohesion, so a lone escort still hunts a rat '
  + 'the follow intent would ignore', () => {
  nav.loadMaps(OPEN_MAP);
  const cfg = cfgOf({ memberNames: ['lead', 'esc'], combatThreshold: 0.6 });
  // Leader is 30 tiles away -> cohesion is 0, full readiness is 0.
  const leader = P({ id: 'L', name: 'lead', x: TILE * 40, y: TILE * 10 });
  const me = P({ id: 'me', name: 'esc', x: TILE * 10, y: TILE * 10 });
  const rat = M({ id: 'r', monsterType: 'rat', hp: 5, x: TILE * 10 + 8, y: TILE * 10 });
  const snap = snapOf([leader, me], [rat]);

  const hunter = makeBot();
  escortTick(hunter, snap, { cfg, intent: 'attack', radius: TILE * 60 });
  assert.ok(attacked(hunter), 'attack presses on without a tight pack');

  const follower = makeBot();
  escortTick(follower, snap, { cfg, intent: 'follow' });
  assert.equal(attacked(follower), false, 'follow never initiates');
});

test('attack still refuses to charge un-assembled aggro -- factorThreat folds '
  + 'cohesion back in, which is the whole safety of the relaxed gate', () => {
  nav.loadMaps(OPEN_MAP);
  const cfg = cfgOf({ memberNames: ['lead', 'esc'], combatThreshold: 0.6 });
  // NOTE the geometry: factorThreat measures the orc against the LEADER, not
  // against us. An orc next to a straggling escort but 30 tiles from the leader
  // registers no threat at all -- the gate is about the PARTY's exposure.
  const leader = P({ id: 'L', name: 'lead', x: TILE * 40, y: TILE * 10 });
  const me = P({ id: 'me', name: 'esc', x: TILE * 10, y: TILE * 10 });

  const nearLeader = M({ id: 'o', monsterType: 'orc', hp: 5, x: TILE * 40, y: TILE * 10 });
  const held = makeBot();
  escortTick(held, snapOf([leader, me], [nearLeader]),
    { cfg, intent: 'attack', radius: TILE * 60 });
  assert.equal(attacked(held), false,
    'aggro by the leader while the pack is scattered -> readiness collapses');

  // Assemble the party and the same orc no longer holds them back.
  const tight = P({ id: 'me', name: 'esc', x: TILE * 40, y: TILE * 10 });
  const charging = makeBot();
  escortTick(charging, snapOf([leader, tight], [nearLeader]),
    { cfg, intent: 'attack', radius: TILE * 60 });
  assert.ok(attacked(charging), 'once assembled, the same orc is fair game');
});

test('the attack gate uses its own EMA lane, leaving the reported readiness alone', () => {
  nav.loadMaps(OPEN_MAP);
  const bot = makeBot();
  const cfg = cfgOf({ memberNames: ['lead', 'esc'], readinessSmooth: 0.5 });
  const leader = P({ id: 'L', name: 'lead', x: TILE * 40, y: TILE * 10 });
  const me = P({ id: 'me', name: 'esc', x: TILE * 10, y: TILE * 10 });
  escortTick(bot, snapOf([leader, me], []), { cfg, intent: 'attack' });
  assert.ok(bot.run.readyEma != null && bot.run.gateEma != null);
  assert.notEqual(bot.run.readyEma, bot.run.gateEma,
    'cohesion-in and cohesion-out scores must not share one EMA');
});

// ---- the leader machine ----------------------------------------------------

function leadTick(bot, snap, cfg = cfgOf(), radius = TILE * 6) {
  const logs = [];
  swarm.makeSwarmLeader(cfg, radius, (m) => logs.push(m))(bot, snap);
  return logs;
}

test('the leader anchors the party on ITSELF and fights its focus pick', () => {
  nav.loadMaps(OPEN_MAP);
  const bot = makeBot('L');
  const me = P({ id: 'L', name: 'lead', x: TILE * 10, y: TILE * 10 });
  const esc = P({ id: 'E', name: 'esc', x: TILE * 10, y: TILE * 10 });
  const mob = M({ id: 'r', hp: 3, x: TILE * 10 + 8, y: TILE * 10 });
  leadTick(bot, snapOf([me, esc], [mob]), cfgOf({ combatThreshold: 0.5 }));
  assert.ok(attacked(bot));
});

test('the leader HUNT gate is hysteretic: it commits at huntEnter and only aborts '
  + 'below huntExit -- this is what killed the one-step-out/one-step-back drift', () => {
  nav.loadMaps(OPEN_MAP);
  const bot = makeBot('L');
  const cfg = cfgOf({
    memberNames: ['lead', 'esc'], rallyPx: 100, cohesionSlack: 2.0,
    huntEnter: 0.5, huntExit: 0.3, combatThreshold: 2.0,   // never melee-engage
  });
  const me = P({ id: 'L', name: 'lead', x: 0, y: 0 });
  // Prey far outside the focus radius so the leader hunts rather than fights.
  const prey = M({ id: 'r', monsterType: 'rat', hp: 5, x: TILE * 30, y: 0 });
  // Escort distance controls cohesion: score = (1 + max(0,1-d/200))/2.
  const at = (d) => snapOf([me, P({ id: 'E', name: 'esc', x: d, y: 0 })], [prey]);

  leadTick(bot, at(180), cfg);                 // cohesion = (1+0.10)/2 = 0.55
  assert.equal(bot.run.swarmHunting, true, 'above huntEnter -> commit to advancing');

  leadTick(bot, at(140), cfg);                 // cohesion = (1+0.30)/2 = 0.65
  assert.equal(bot.run.swarmHunting, true);

  leadTick(bot, at(199), cfg);                 // cohesion = (1+0.005)/2 ~= 0.50
  assert.equal(bot.run.swarmHunting, true,
    'a momentary straggle between the lines must NOT abort the advance');

  leadTick(bot, at(10000), cfg);               // cohesion = 0.5 -> wait, escort gone
  assert.equal(bot.run.swarmHunting, true, 'the leader alone still scores 0.5 > huntExit');

  // Force cohesion under huntExit: the leader itself must also be far from... it
  // cannot be, so shrink the party expectation instead by adding a third member.
  const cfg3 = cfgOf({
    memberNames: ['lead', 'esc', 'esc2'], rallyPx: 100, cohesionSlack: 2.0,
    huntEnter: 0.5, huntExit: 0.3, combatThreshold: 2.0,
  });
  const bot3 = makeBot('L');
  // All three present and tight -> cohesion 1.0 -> commit.
  leadTick(bot3, snapOf([me,
    P({ id: 'E', name: 'esc', x: 0, y: 0 }),
    P({ id: 'F', name: 'esc2', x: 0, y: 0 })], [prey]), cfg3);
  assert.equal(bot3.run.swarmHunting, true);
  // Both escorts vanish -> cohesion = 1/3 = 0.333 -> still above huntExit 0.3.
  leadTick(bot3, snapOf([me], [prey]), cfg3);
  assert.equal(bot3.run.swarmHunting, true, 'still in the band -> keep advancing');
  // Tighten the exit above 1/3 and the commit finally breaks.
  cfg3.huntExit = 0.4;
  leadTick(bot3, snapOf([me], [prey]), cfg3);
  assert.equal(bot3.run.swarmHunting, false, 'below huntExit -> abort back to regroup');
  // And re-entering now needs the FULL huntEnter, not just huntExit.
  cfg3.huntExit = 0.3;
  leadTick(bot3, snapOf([me], [prey]), cfg3);   // cohesion 0.333 < huntEnter 0.5
  assert.equal(bot3.run.swarmHunting, false, 're-entry requires clearing huntEnter');
});

test('a committed leader walks TOWARD the prey, pulling the column', () => {
  nav.loadMaps(OPEN_MAP);
  const bot = makeBot('L');
  const cfg = cfgOf({
    memberNames: ['lead'], huntEnter: 0.5, huntExit: 0.3, combatThreshold: 2.0,
  });
  const me = P({ id: 'L', name: 'lead', x: TILE * 10, y: TILE * 10 });
  const prey = M({ id: 'r', monsterType: 'rat', hp: 5, x: TILE * 20, y: TILE * 10 });
  const logs = leadTick(bot, snapOf([me], [prey]), cfg);
  assert.deepEqual(lastMove(bot), [1, 0]);
  assert.ok(logs.some((l) => l.includes('hunting rat')), 'the log names the intent');
});

test('a leader with a loose escort regroups instead of strolling off', () => {
  nav.loadMaps(OPEN_MAP);
  const bot = makeBot('L');
  const cfg = cfgOf({
    memberNames: ['lead', 'esc', 'esc2'], rallyPx: 100, cohesionSlack: 2.0,
    huntEnter: 0.9, huntExit: 0.8, combatThreshold: 2.0,
  });
  const me = P({ id: 'L', name: 'lead', x: TILE * 10, y: TILE * 10 });
  const straggler = P({ id: 'E', name: 'esc', x: TILE * 4, y: TILE * 10 });
  const prey = M({ id: 'r', monsterType: 'rat', hp: 5, x: TILE * 20, y: TILE * 10 });
  const logs = leadTick(bot, snapOf([me, straggler], [prey]), cfg);
  assert.equal(bot.run.swarmHunting, false);
  assert.deepEqual(lastMove(bot), [-1, 0], 'move back toward the straggler, not the rat');
  assert.ok(logs.some((l) => l.includes('regrouping')));
});

test('a lone leader with no prey holds position', () => {
  nav.loadMaps(OPEN_MAP);
  const bot = makeBot('L');
  const me = P({ id: 'L', name: 'lead', x: TILE * 10, y: TILE * 10 });
  const logs = leadTick(bot, snapOf([me], []), cfgOf({ memberNames: ['lead'] }));
  assert.deepEqual(lastMove(bot), [0, 0]);
  assert.ok(logs.some((l) => l.includes('no prey visible')));
});

// ---- heartbeat -------------------------------------------------------------

test('swarmHeartbeat prints on a state CHANGE and throttles otherwise', () => {
  const bot = makeBot();
  const cfg = cfgOf();
  const me = P({ hp: 50, maxHp: 100 });
  const target = M({ monsterType: 'rat' });
  const logs = [];
  const beat = (opts) => swarm.swarmHeartbeat(
    bot, 'lead', new Map(), 0.9, cfg, target, me, { log: (m) => logs.push(m), ...opts });

  beat({ fighting: true });
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes('FIGHTING rat'));
  beat({ fighting: true });
  assert.equal(logs.length, 1, 'same state inside the period -> silent');
  beat({ fighting: false });
  assert.equal(logs.length, 2, 'a flip prints immediately');
  assert.ok(logs[1].includes('waiting (not ready)'));
});

test('swarmHeartbeat treats an explicit fighting=false as a decision, not as '
  + '"derive it yourself"', () => {
  const bot = makeBot();
  const cfg = cfgOf({ combatThreshold: 0.5 });
  const logs = [];
  // score 0.9 clears the bare threshold, so a `fighting || derive` bug would
  // report FIGHTING despite the caller's explicit false.
  swarm.swarmHeartbeat(bot, 'lead', new Map(), 0.9, cfg,
    M({ monsterType: 'rat' }), P(), { fighting: false, log: (m) => logs.push(m) });
  assert.ok(logs[0].includes('waiting (not ready)'));
});

test('swarmHeartbeat with no target reports rallying', () => {
  const bot = makeBot();
  const logs = [];
  swarm.swarmHeartbeat(bot, 'lead', new Map(), 0.9, cfgOf(), null, P(),
    { fighting: true, log: (m) => logs.push(m) });
  assert.ok(logs[0].includes('no target -- rallying'),
    'a gate-open decision with nothing to hit is not "fighting"');
});
