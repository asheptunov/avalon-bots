// The swarm: multi-character coordination with NO coordination channel.
//
// Port of avalon.py's make_swarm / make_swarm_leader and the readiness model.
//
// The central trick: every bot -- leader and escorts alike -- computes the SAME
// decisions from its OWN snapshot. Nobody messages anybody. Focus-fire emerges
// because everyone independently applies "lowest HP within the leader's radius";
// the combat gate stays in sync because everyone runs the same readiness product
// over near-identical snapshots.
//
// As in farm.js, the comments explaining WHY were paid for with dead bots.

import { TILE, MELEE_RANGE_PX } from './protocol.js';
import * as nav from './nav.js';
import {
  distPx, meOf, nameMatches, stepToward, setNavObstacles, navStep,
  nearestTo, respawnIfDead, takeTeleport,
} from './farm.js';

const now = () => performance.now() / 1000;

/**
 * Read a throttle timestamp, treating "never" as infinitely long ago. Same
 * reasoning as farm.js: performance.now() starts near 0, so a `|| 0` default
 * would suppress the FIRST action of anything throttled.
 */
const since = (bot, key) => now() - (bot.run[key] ?? -Infinity);

/** First visible player matching `query` by the forgiving name rule, or null. */
export function findPlayer(snap, query, excludeId = null) {
  return snap.players.find(
    (p) => p.id !== excludeId && nameMatches(query, p.name)) || null;
}

// ---- target selection -----------------------------------------------------

/**
 * The monster the pack should focus: the lowest-HP living monster within
 * radiusPx of the leader. Everyone applying this same rule independently
 * converges on one target -- focus-fire with no coordination channel.
 *
 * huntTypes restricts what counts as a target, so the pack won't dogpile a
 * 16k-HP training dummy or aggro a boss it wandered past. null means "anything".
 */
export function pickFocusMonster(snap, leader, radiusPx, huntTypes = null) {
  if (!leader) return null;
  let best = null;
  for (const m of snap.monsters) {
    if (m.hp <= 0) continue;
    if (huntTypes && !huntTypes.includes(m.monsterType)) continue;
    if (distPx(m.x, m.y, leader.x, leader.y) > radiusPx) continue;
    if (!best || m.hp < best.hp) best = m;
  }
  return best;
}

/**
 * Nearest living monster of a huntable type to the anchor, or null. Used by the
 * leader to walk the party toward prey when nothing's in focus range.
 *
 * Distinct from farm.js's nearestHuntable only in taking huntTypes positionally;
 * kept separate so the swarm's call sites read like the Python.
 */
export function nearestHuntable(snap, anchor, huntTypes) {
  let best = null; let bestD = Infinity;
  for (const m of snap.monsters) {
    if (m.hp <= 0) continue;
    if (huntTypes && !huntTypes.includes(m.monsterType)) continue;
    const d = distPx(m.x, m.y, anchor.x, anchor.y);
    if (d < bestD) { bestD = d; best = m; }
  }
  return best;
}

// --- combat-state read (snapshot-only, no event plumbing) -------------------
// The server marks a monster `enraged` while it's actively fighting -- it aggroed
// a party member, or a passive mob (a rat) is retaliating against whoever hit it.
// We don't get "who is it hitting", but an enraged monster is (by mechanics) on
// top of its victim, so proximity to a party member tells us WHICH member it's
// on. That's enough to distinguish "someone's in a fight" (join in) from "there's
// an idle rat nearby" (leave it alone) -- with zero coordination channel.

/**
 * True if monster `m` is actively fighting a party member: it's enraged AND
 * within threatPx of some member. (Enraged = it aggroed or is retaliating; the
 * range check pins it to a member it's actually on.)
 */
export function monsterThreateningParty(m, members, threatPx) {
  if (!(m.hp > 0 && m.enraged)) return false;
  for (const p of members.values()) {
    if (distPx(m.x, m.y, p.x, p.y) <= threatPx) return true;
  }
  return false;
}

/**
 * Monsters actively fighting a party member, lowest-HP first. Deliberately NOT
 * filtered by huntTypes: defend is self-defense, so the pack swarms whatever is
 * attacking a member (an orc that aggroed us) even when we're only out HUNTING
 * rats. huntTypes governs what we seek out, not what we fend off.
 */
export function threatsToParty(snap, members, threatPx) {
  return snap.monsters
    .filter((m) => monsterThreateningParty(m, members, threatPx))
    .sort((a, b) => a.hp - b.hp);          // focus lowest-HP first
}

// How close an enraged monster must be to the leader to count as "the leader is
// fighting THIS one". Melee-scale (not the party's wide threat radius) so an
// escort's own fight a few tiles away doesn't read as the leader's -- that
// distinction is what keeps the leader in control of the follow-pack.
export const LEADER_ENGAGE_PX = MELEE_RANGE_PX * 1.5;

/**
 * True if the LEADER is committed to fighting `target` -- that monster is
 * enraged and in melee reach of the leader. This is the `follow` trigger:
 * passive escorts pile onto exactly what the leader is fighting, and stop when
 * the leader stops, so the leader keeps control (peeling the party off a threat
 * just means the leader disengages). Keying off the leader specifically -- and at
 * melee scale, not the party's wide threat radius -- is what preserves that
 * control: otherwise an escort's own fight a few tiles off drags the pack in and
 * the leader can't call them off.
 */
export function leaderEngagedWith(target, leader, engagePx = LEADER_ENGAGE_PX) {
  if (!target || !leader) return false;
  return !!(target.hp > 0 && target.enraged
    && distPx(target.x, target.y, leader.x, leader.y) <= engagePx);
}

// --------------------------------------------------------------------------
// party readiness -- the shared "should we fight?" brain
// --------------------------------------------------------------------------
//
// Every swarm bot (leader and escorts alike) computes the SAME readiness score
// from its own snapshot, so they gate combat consistently with no messaging.
// Readiness is a probability-like score in [0,1] -- think P(the squad wins this
// engagement). Combat is allowed only when readiness >= combatThreshold.
//
// It's a product of independent factors, each a function
// (members, leader, snap, cfg) -> [0,1]. To add a new consideration (retreat when
// someone's dying, back off from a boss, ...), write another factor and append it
// to READINESS_FACTORS -- nothing else changes.

// Monster types that auto-aggro (charge the party unprompted). Rats don't; orcs
// and friends do. Presence of these near an unassembled party tanks readiness so
// the pack avoids them until everyone's together.
export const AGGRO_MONSTERS = new Set([
  'orc', 'orcZealot', 'goblin', 'wraith', 'hellMage',
  'hellArchmage', 'iceWizard', 'lizardman', 'orrinVale',
]);

/** All the tunables for the readiness model in one editable place. */
export class PartyConfig {
  constructor(o = {}) {
    this.memberNames = o.memberNames ?? [];   // names that make up the party
    this.rallyPx = o.rallyPx ?? TILE * 4;     // "tight" = within this of leader
    this.threatPx = o.threatPx ?? TILE * 8;   // aggro monsters this close matter
    this.combatThreshold = o.combatThreshold ?? 0.6;
    this.lowHpFrac = o.lowHpFrac ?? 0.35;
    // Readiness EMA: each tick the reported readiness is
    //   smooth = alpha*raw + (1-alpha)*prevSmooth
    // alpha=1.0 disables it (report the raw instantaneous value). Smaller alpha =
    // stickier, so a one-tick straggle or a transient threat can't instantly slam
    // the combat gate shut/open.
    this.readinessSmooth = o.readinessSmooth ?? 1.0;
    // Combat-gate hysteresis: START fighting at combatThreshold, keep fighting
    // until smoothed readiness sags below combatExit (< threshold). The band
    // between the two stops the gate chattering at the boundary. Defaults to
    // combatThreshold (no hysteresis) unless set lower.
    this.combatExit = o.combatExit ?? this.combatThreshold;
    this.huntTypes = o.huntTypes ?? null;     // monster types to hunt (null=any)
    // Cohesion falloff: a member scores 0 only past rallyPx*cohesionSlack. Larger
    // = a loose-but-nearby clump still reads as "tight enough".
    this.cohesionSlack = o.cohesionSlack ?? 2.5;
    // Sticky-hunt hysteresis: the leader COMMITS to advancing once cohesion
    // clears huntEnter, and only aborts back to regroup below huntExit. The gap
    // between the two is what kills the one-step-out/one-step-back drift.
    this.huntEnter = o.huntEnter ?? 0.5;
    this.huntExit = o.huntExit ?? 0.3;
    // How close an escort trails the leader (defaults to rallyPx).
    this.followGapPx = o.followGapPx ?? this.rallyPx;
  }
}

/**
 * The party members currently visible in this snapshot (leader included), keyed
 * by matched name. Missing members simply won't appear -- factors treat absence
 * as 'not ready'.
 */
/**
 * The name QUERIES that make up the party: the configured members plus the
 * leader. Both partyMembers and factorCohesion derive from this one set so the
 * "who is present" numerator and the "who is expected" denominator cannot drift
 * apart -- see factorCohesion for the bug that happened when they did.
 */
export function expectedNames(cfg, leaderName) {
  const names = new Set(cfg.memberNames);
  if (leaderName) names.add(leaderName);
  return names;
}

export function partyMembers(snap, cfg, leaderName) {
  const names = expectedNames(cfg, leaderName);
  const seen = new Map();
  for (const p of snap.players) {
    for (const want of names) {
      if (!seen.has(want) && nameMatches(want, p.name)) seen.set(want, p);
    }
  }
  return seen;
}

/**
 * 1.0 when every named member is present AND within rallyPx of the leader;
 * degrades toward 0 as members go missing or straggle. This is the 'tight escort'
 * gate.
 *
 * KNOWN BUG, carried over from avalon.py deliberately (see test_swarm.mjs): the
 * denominator unions memberNames -- which hold match QUERIES like 'sam' -- with the
 * leader's DISPLAY name ('sam altman'). When those differ, the leader is counted
 * twice and cohesion can never reach 1.0, quietly holding the combat gate and the
 * leader's hunt commit shut. Only bites when nameMatches is used as intended.
 * Fixing it would diverge from the Python, so it is pinned by a test instead.
 */
export function factorCohesion(members, leader, snap, cfg, leaderName = null) {
  if (!leader) return 0.0;
  // How many bodies we EXPECT -- the same name set partyMembers resolves over,
  // so the denominator counts exactly what the numerator can fill.
  //
  // The Python original instead built `set(member_names) | {leader.name}`, which
  // mixes two different things: member_names holds match QUERIES ('sam') while
  // the leader contributes its DISPLAY name ('sam altman'). Whenever those
  // differ -- which forgiving name matching exists precisely to allow -- the
  // union gained a phantom entry the numerator could never fill, so a party
  // standing on one tile scored 0.5 instead of 1.0. Cohesion never reached the
  // combat gate and the hive regrouped forever with nothing logged. Deriving
  // both sides from one set makes that class of mismatch impossible.
  // Falling back to the leader's DISPLAY name when leaderName is absent would
  // resurrect the exact bug described above, so we don't: with no query to key
  // on, the party is the configured members plus one leader.
  const nExpected = leaderName
    ? expectedNames(cfg, leaderName).size
    : cfg.memberNames.length + (cfg.memberNames.some((n) => nameMatches(n, leader.name)) ? 0 : 1);
  // Count everyone we can actually place, scored by how close they are.
  let total = 0.0;
  for (const p of members.values()) {
    const d = distPx(p.x, p.y, leader.x, leader.y);
    total += Math.max(0.0, 1.0 - d / (cfg.rallyPx * cfg.cohesionSlack));
  }
  // Missing members contribute 0, so they only shrink the numerator.
  return total / Math.max(1, nExpected);
}

/**
 * Party HP: 1.0 all-healthy, dropping as anyone gets hurt, and pinned low if
 * someone is below lowHpFrac (a near-dead member means P(win) is poor).
 */
export function factorHealth(members, leader, snap, cfg) {
  if (!members.size) return 0.0;
  let sum = 0.0; let lo = Infinity;
  for (const p of members.values()) {
    const f = p.hp / Math.max(1, p.maxHp);
    sum += f;
    if (f < lo) lo = f;
  }
  if (lo < cfg.lowHpFrac) return lo;        // someone's critical -> not ready
  return sum / members.size;
}

/**
 * Auto-aggro monsters near the party gate on cohesion: if orcs are close while
 * the pack is NOT assembled, readiness collapses so they avoid the fight until
 * together. Once assembled, the same monsters don't hold them back.
 */
export function factorThreat(members, leader, snap, cfg) {
  if (!leader) return 1.0;
  const aggroNear = snap.monsters.some(
    (m) => m.hp > 0 && AGGRO_MONSTERS.has(m.monsterType)
      && distPx(m.x, m.y, leader.x, leader.y) <= cfg.threatPx);
  if (!aggroNear) return 1.0;
  // Aggro present: readiness rides entirely on being assembled.
  return factorCohesion(members, leader, snap, cfg);
}

export const READINESS_FACTORS = [factorCohesion, factorHealth, factorThreat];

/**
 * P(squad wins the engagement), in [0,1]: the product of all factors. Returns
 * {score, members, leader} so callers can reuse the resolved party.
 */
export function partyReadiness(snap, cfg, leaderName) {
  const members = partyMembers(snap, cfg, leaderName);
  const leader = members.get(leaderName) || findPlayer(snap, leaderName);
  let score = 1.0;
  for (const f of READINESS_FACTORS) score *= f(members, leader, snap, cfg, leaderName);
  return { score, members, leader };
}

/**
 * Readiness with the cohesion factor removed -- the product of the remaining
 * factors (health, threat, ...). Used by the `attack` intent, which is willing to
 * engage without a tight pack but must still respect the safety factors (a dying
 * member, un-assembled aggro). Stays correct if new factors are appended to
 * READINESS_FACTORS -- only factorCohesion is skipped.
 *
 * Note: factorThreat still folds cohesion back in WHEN aggro is near, so attack
 * mode ignores clustering only for passive prey (rats); against auto-aggro
 * monsters it still won't charge in unassembled. That's the intended safety.
 */
export function readinessWithoutCohesion(snap, cfg, leaderName) {
  const members = partyMembers(snap, cfg, leaderName);
  const leader = members.get(leaderName) || findPlayer(snap, leaderName);
  let score = 1.0;
  for (const f of READINESS_FACTORS) {
    if (f === factorCohesion) continue;
    score *= f(members, leader, snap, cfg, leaderName);
  }
  return score;
}

/**
 * Exponential moving average of readiness, kept per-bot. With alpha >= 1.0 it's a
 * passthrough (raw value). Otherwise it blends in the previous smoothed score so
 * momentary dips/spikes don't jerk the combat gate. Bot-local state means no
 * coordination needed -- each process smooths its own view, and since they all see
 * nearly the same snapshot their smoothed scores track together.
 *
 * `slot` names the per-bot EMA state, so a caller that smooths two different
 * series (e.g. full readiness for the log AND a cohesion-excluded gate score)
 * keeps them in independent lanes rather than cross-contaminating one EMA.
 */
export function smoothReadiness(bot, raw, cfg, slot = 'readyEma') {
  const a = cfg.readinessSmooth;
  if (a >= 1.0) return raw;
  const prev = bot.run[slot];
  // `prev == null` and not a falsy test: a previous EMA of exactly 0.0 (fully
  // un-ready) is a real value that must be blended, not treated as "no history".
  const ema = prev == null ? raw : a * raw + (1.0 - a) * prev;
  bot.run[slot] = ema;
  return ema;
}

/**
 * Hysteretic combat gate: return true while the squad should be fighting. Enter
 * combat when score >= combatThreshold; stay in combat until score drops below
 * combatExit (<= threshold). The bot latches its fight/hold state so the decision
 * doesn't flip every tick at the boundary. `score` should be the SMOOTHED
 * readiness.
 */
export function combatGo(bot, score, cfg) {
  const wasFighting = bot.run.combatOn ?? false;
  const fighting = wasFighting
    ? score >= cfg.combatExit
    : score >= cfg.combatThreshold;
  bot.run.combatOn = fighting;
  return fighting;
}

// ---- formation / station-keeping ------------------------------------------

/** Mean position of the party, optionally excluding one player id, or null. */
export function partyCentroid(members, excludeId = null) {
  let sx = 0; let sy = 0; let n = 0;
  for (const p of members.values()) {
    if (p.id === excludeId) continue;
    sx += p.x; sy += p.y; n++;
  }
  if (!n) return null;
  return [sx / n, sy / n];
}

/** Living auto-aggro monsters within threatPx of `me`. */
function nearbyThreats(snap, me, cfg) {
  return snap.monsters.filter(
    (m) => m.hp > 0 && AGGRO_MONSTERS.has(m.monsterType)
      && distPx(m.x, m.y, me.x, me.y) <= cfg.threatPx);
}

/**
 * A (dx,dy) that regroups the party while AVOIDING aggro threats -- so a
 * straggler converges on the pack instead of strolling through the line of fire.
 * Move toward the party centroid, then bias away from any near aggro monster.
 */
export function rallyStep(me, members, snap, cfg, leader) {
  const centroid = partyCentroid(members, me.id)
    || (leader ? [leader.x, leader.y] : [me.x, me.y]);
  let [tx, ty] = centroid;
  // Repel from the nearest aggro monster within threat range.
  const threats = nearbyThreats(snap, me, cfg);
  if (threats.length) {
    const thr = nearestTo(threats, me);
    // Nudge the target point away from the threat.
    tx += me.x - thr.x;
    ty += me.y - thr.y;
  }
  return stepToward(me, tx, ty);
}

// How near the leader's last-seen tile a teleport must be to conclude "the leader
// took THIS teleport and vanished" (tiles). The leader has to be basically on the
// marker for us to chase it -- otherwise we'd dive down a hole any time they
// merely walked out of view near one.
const TELEPORT_TRIGGER_TILES = 2;

/**
 * Remember the leader's floor+tile whenever we can see them, so if they vanish
 * next to a teleport we know to chase them through it. Clear the "already told
 * you" notes once we actually re-acquire, so a stale last-seen can't re-trigger.
 */
export function trackLeader(bot, leader) {
  if (!leader) return;
  bot.run.leaderLast = {
    z: bot.z ?? 0,
    tile: [nav.tileOf(leader.x), nav.tileOf(leader.y)],
  };
  bot.run.xfloorNote = null;          // re-armed: fresh sighting
  bot.run.homeNote = null;
}

/**
 * Follow a leader who has DESCENDED/ASCENDED and thus VANISHED from our snapshot
 * (the server only sends entities on our own floor -- we get no signal of their
 * new z). We can't know where they went, so we key off OBSERVABLE evidence: the
 * leader was last seen standing on/next to a teleport on OUR floor, and is now
 * gone -> they almost certainly took it, so we take it too (walk onto a hole;
 * approach a ladder and useTeleport). After transitioning, our z changes, we
 * re-see the leader, and normal follow resumes.
 *
 * True if it issued a move/teleport this tick (caller should return); false if
 * there's nothing to chase (leader never seen, or wasn't near a teleport when
 * they vanished -- they just walked out of view).
 */
export function followAcrossFloors(bot, me, snap, log) {
  const seen = bot.run.leaderLast;
  if (!seen) return false;
  const ltile = seen.tile;
  const z = bot.z ?? 0;

  // Only chase if the leader vanished while ON/next to a teleport on OUR floor.
  const tps = nav.teleports(z);
  if (!tps.length) return false;
  const tp = tps.reduce((best, t) => {
    const d = (t.fromTile[0] - ltile[0]) ** 2 + (t.fromTile[1] - ltile[1]) ** 2;
    return best && best.d <= d ? best : { d, t };
  }, null).t;
  const [ftx, fty] = tp.fromTile;
  // Too far from a marker -> they walked off-view, they didn't teleport. Hold.
  if (Math.max(Math.abs(ftx - ltile[0]), Math.abs(fty - ltile[1]))
      > TELEPORT_TRIGGER_TILES) {
    return false;
  }

  takeTeleport(bot, me, tp);
  const note = `${z},${ftx},${fty}`;
  if (bot.run.xfloorNote !== note) {
    bot.run.xfloorNote = note;
    log?.(`escort ${me.name}: leader vanished at (${ltile[0]},${ltile[1]}) on a `
      + `${tp.mode} -> taking it @(${ftx},${fty}) from z${z}`);
  }
  return true;
}

/**
 * Last-resort recovery for an escort stranded underground with NO leader in view
 * and nothing to chase: climb toward the surface one floor at a time via the
 * known up-teleports, until it reaches z=0 and can re-acquire the leader. This is
 * the 'get everyone back to me' path -- it uses the fully-known teleport graph (we
 * DO remember where every ladder goes) to route home.
 *
 * True if it acted (caller should return); false on the surface / no way up.
 */
export function homeToSurface(bot, me, log) {
  const z = bot.z ?? 0;
  if (z >= 0) return false;                 // already on the surface
  const up = nav.nearestUpwardTeleport(z, [nav.tileOf(me.x), nav.tileOf(me.y)]);
  if (!up) return false;
  const [ftx, fty] = up.fromTile;
  takeTeleport(bot, me, up);
  const note = `${z},${ftx},${fty}`;
  if (bot.run.homeNote !== note) {
    bot.run.homeNote = note;
    log?.(`escort ${me.name}: no leader in sight on z${z} -- homing to surface `
      + `via ${up.mode} @(${ftx},${fty})`);
  }
  return true;
}

/**
 * A (dx,dy) that trails the LEADER (not the party centroid), so the column tracks
 * a moving leader out of the house instead of converging on itself. Holds position
 * once within followGapPx; biases away from near aggro; and slides along walls
 * (via navStep) so escorts don't pin on the doorway.
 */
export function followLeaderStep(bot, me, leader, snap, cfg) {
  if (!leader) return [0, 0];
  const d = distPx(me.x, me.y, leader.x, leader.y);
  if (d <= cfg.followGapPx) return [0, 0];  // close enough -- don't crowd them
  let tx = leader.x; let ty = leader.y;
  const threats = nearbyThreats(snap, me, cfg);
  if (threats.length) {
    const thr = nearestTo(threats, me);
    tx += me.x - thr.x;
    ty += me.y - thr.y;
  }
  return navStep(bot, me, tx, ty);
}

/**
 * Throttled live readout so a running swarm is legible in its log: prints at most
 * every `period` seconds, and immediately whenever the state changes. `note` lets
 * a caller name the current purpose (e.g. 'hunting rat @(78,49)' vs 'regrouping')
 * so the log shows intent over time, not just fight/wait. `fighting` lets the
 * caller pass the real (hysteretic) gate decision instead of re-deriving it from
 * a bare threshold compare.
 */
export function swarmHeartbeat(bot, role, members, score, cfg, target, me,
                               { period = 2.0, note = null, fighting = null,
                                 log = null } = {}) {
  // `fighting == null` (not falsy): the caller passing an explicit `false` gate
  // decision must not be mistaken for "no decision, derive one yourself".
  const isFighting = fighting == null
    ? !!(target && score >= cfg.combatThreshold)
    : !!(target && fighting);
  const state = isFighting
    ? `FIGHTING ${target.monsterType}`
    : (note || (target ? 'waiting (not ready)' : 'no target -- rallying'));
  const flipped = bot.run.hbState !== state;
  if (!flipped && since(bot, 'hbLast') < period) return;
  bot.run.hbLast = now();
  bot.run.hbState = state;
  log?.(`${role}: readiness=${score.toFixed(2)} party=${members.size} `
    + `hp=${me.hp}/${me.maxHp} -> ${state}`, state);
}

// Escort INTENT -- WHETHER/WHEN an escort engages (all share the readiness gate):
//   follow  -- passive: only joins a fight the party has ALREADY started (a
//              monster enraged on a member). Never initiates. The default.
//   attack  -- aggressive: hunts huntable monsters near the anchor unprompted,
//              even when the pack isn't clustered (cohesion-relaxed gate).
//   defend  -- reactive: peels only to a monster attacking a party member; never
//              touches idle mobs. Swarms an orc that aggros; helps a member a
//              retaliating rat is hitting.
export const INTENTS = ['follow', 'attack', 'defend'];

// Escort FORMATION -- HOW an escort holds station (orthogonal to intent):
//   none       -- trail the leader (default column-follow).
//   magnetize  -- boids-like self-spacing: attraction to the leader + short-range
//                 repulsion from neighbours, so escorts spread out evenly yet
//                 stay clustered. Composes with any intent.
export const FORMATIONS = ['none', 'magnetize'];

/**
 * Boids-style station-keeping: escorts settle into a ring of roughly-even spacing
 * around the leader. Split into a FAR and a NEAR regime so obstacles never trap
 * the bot:
 *
 *   * FAR (outside the ring): path to the LEADER via A*. The leader is always a
 *     reachable goal, so A* routes around trees/buildings to close the distance --
 *     no blind force-projection that can aim the goal into a wall (which made a
 *     bot 'arrive' against a trunk and freeze). We just stop once we reach the
 *     ring.
 *   * NEAR (on/inside the ring): apply the local force balance -- a symmetric ring
 *     spring (push out if too close) plus neighbour separation plus threat
 *     avoidance -- to fine-tune position and spread the ring out evenly. Here the
 *     goal is only a step away, which is fine: there's no wall to route around at
 *     conversational range, and the even-spacing equilibrium emerges from the
 *     separation term.
 *
 * Pure local rule over the snapshot; no coordination channel. Falls back to a
 * plain leader-follow if the leader isn't visible.
 */
export function magnetizeStep(bot, me, leader, members, snap, cfg) {
  if (!leader) return followLeaderStep(bot, me, leader, snap, cfg);

  const ring = Math.max(TILE, cfg.followGapPx);
  const personal = Math.max(TILE, ring);          // neighbour personal space
  const dlx = me.x - leader.x; const dly = me.y - leader.y;
  const dLead = Math.hypot(dlx, dly) || 1e-6;

  // FAR: too far outside the ring -> let A* walk us to the leader (routes around
  // obstacles). A little hysteresis (1.25*ring) so we don't flip regimes right at
  // the boundary.
  if (dLead > ring * 1.25) return navStep(bot, me, leader.x, leader.y);

  // NEAR: local force balance for fine positioning + even spacing.
  let fx = 0.0; let fy = 0.0;
  // Symmetric ring spring: signed by (dLead - ring). Outside -> inward, inside ->
  // outward, zero on the ring.
  const err = dLead - ring;
  const ux = dlx / dLead; const uy = dly / dLead;  // leader -> me
  fx += -ux * err;
  fy += -uy * err;
  // Separation: push off neighbours inside personal space, weighted by overlap.
  for (const p of members.values()) {
    if (p.id === me.id || p.id === leader.id) continue;
    const px = me.x - p.x; const py = me.y - p.y;
    const d = Math.hypot(px, py);
    if (d > 0 && d < personal) {
      const w = (personal - d) / personal;
      fx += (px / d) * personal * w;
      fy += (py / d) * personal * w;
    }
  }
  // Threat avoidance: shove away from the nearest aggro monster in range.
  const threats = nearbyThreats(snap, me, cfg);
  if (threats.length) {
    const thr = nearestTo(threats, me);
    fx += me.x - thr.x;
    fy += me.y - thr.y;
  }

  // Deadband: once the net force is tiny we're on station.
  const mag = Math.hypot(fx, fy);
  if (mag < TILE * 0.33) return [0, 0];
  // Near range: aim a couple tiles along the force (stable, quantized) so A* still
  // nudges around any small obstacle without pinning.
  const reach = Math.min(mag, 2 * TILE);
  const gx = Math.round((me.x + (fx / mag) * reach) / TILE) * TILE;
  const gy = Math.round((me.y + (fy / mag) * reach) / TILE) * TILE;
  return navStep(bot, me, gx, gy);
}

/**
 * What THIS escort should fight this tick, given its intent. Returns a monster or
 * null -- null means 'don't engage, hold formation'.
 *
 *   attack  -- hunt: the focus monster near the anchor (aggressive, unprompted).
 *   follow  -- passive: the focus monster ONLY if the LEADER is fighting it, so
 *              the leader keeps control (escorts join the leader's fight and quit
 *              when the leader does; the leader can peel them off a threat just by
 *              disengaging). Never triggers off a mere party member.
 *   defend  -- reactive: the monster currently attacking ANY party member
 *              (nearest-victim threat), never an idle mob. Never hunts.
 */
export function swarmTarget(intentMode, snap, leader, anchor, members,
                            focusRadiusPx, cfg) {
  if (intentMode === 'follow') {
    // Fight exactly what the LEADER is fighting: the enraged monster on the leader
    // (not a nearby focus pick, which could be a different mob). Lowest HP first
    // so multiple followers converge on the same one -> focus fire. NOT filtered
    // by huntTypes -- if the leader picked this fight (even an orc), the pack backs
    // the leader up regardless of the hunt filter.
    let best = null;
    for (const m of snap.monsters) {
      if (!leaderEngagedWith(m, leader)) continue;
      if (!best || m.hp < best.hp) best = m;
    }
    return best;
  }
  if (intentMode === 'defend') {
    const threatened = threatsToParty(snap, members, cfg.threatPx);
    return threatened.length ? threatened[0] : null;
  }
  // 'attack', and anything unknown, behaves like attack.
  return pickFocusMonster(snap, anchor, focusRadiusPx, cfg.huntTypes);
}

// ---- the machines ---------------------------------------------------------

/** Close to melee and swing, else path toward it. Shared by both roles. */
function engage(bot, me, target) {
  if (distPx(me.x, me.y, target.x, target.y) < MELEE_RANGE_PX) {
    bot.move(0, 0);
    bot.attack(target.id);
  } else {
    bot.move(...navStep(bot, me, target.x, target.y));
  }
}

/**
 * One brain for both roles. Every tick:
 *
 *   1. Compute party readiness (the shared P(win) score) from our snapshot.
 *   2. Decide a target from the INTENT (attack hunts, follow only joins a fight
 *      the party started, defend only peels to a threatened member).
 *   3. If there's a target AND the readiness gate is open -> focus-fire it.
 *   4. Otherwise hold station in the chosen FORMATION (magnetize self-spaces;
 *      otherwise trail the leader). The leader waits up here too, so the pack
 *      never desyncs into a cross-map stroll.
 *
 * `intentMode` shapes engagement; `formation` is ORTHOGONAL and shapes
 * station-keeping -- any intent composes with any formation. Both still share the
 * readiness model, so the hive stays coherent.
 *
 * isLeader only changes idle/fallback wandering, not the combat gate.
 */
export function makeSwarm(leaderName, cfg, focusRadiusPx, isLeader,
                          intentMode = 'follow', formation = 'none', log = null) {
  return function tick(bot, snap) {
    const me = meOf(bot, snap);
    if (!me) return;
    if (respawnIfDead(bot, me, log)) return;
    setNavObstacles(bot, snap, me);

    const { score: raw, members, leader } = partyReadiness(snap, cfg, leaderName);
    const score = smoothReadiness(bot, raw, cfg);
    trackLeader(bot, leader);          // remember floor+tile while visible

    // One-time visibility hint for a name mismatch / offline member.
    if (!bot.run.swarmGreeted) {
      bot.run.swarmGreeted = true;
      const role = isLeader ? 'leading' : `escorting '${leaderName}'`;
      const form = formation !== 'none' ? `/${formation}` : '';
      log?.(`${role} [${intentMode}${form}]; party=`
        + `${[...members.keys()].sort().join(',')} readiness=${score.toFixed(2)}`);
    }

    const anchor = leader || me;
    const target = swarmTarget(intentMode, snap, leader, anchor, members,
      focusRadiusPx, cfg);
    // `attack` presses the offensive: it doesn't wait for a tight pack, so it
    // gates on readiness EXCLUDING cohesion (health/threat still apply, so it
    // won't charge in with a dying member or into un-assembled aggro).
    // follow/defend gate on the full readiness (they only fight reactively anyway,
    // so cohesion gating them is harmless and keeps the pack tight).
    let gateScore = score;
    if (intentMode === 'attack') {
      const gateRaw = readinessWithoutCohesion(snap, cfg, leaderName);
      gateScore = smoothReadiness(bot, gateRaw, cfg, 'gateEma');
    }
    const go = combatGo(bot, gateScore, cfg);
    const label = formation !== 'none' ? `${intentMode}/${formation}` : intentMode;
    swarmHeartbeat(bot, `escort ${me.name} [${label}]`, members, score, cfg,
      target, me, { fighting: go, log });

    // Engage only when the intent picked a target AND the gate is open.
    if (target && go) {
      engage(bot, me, target);
      return;
    }

    // Not fighting: hold station per FORMATION. magnetize self-spaces around the
    // leader; otherwise trail the leader directly (so the column tracks a moving
    // leader).
    if (leader && formation === 'magnetize') {
      bot.move(...magnetizeStep(bot, me, leader, members, snap, cfg));
    } else if (leader) {
      bot.move(...followLeaderStep(bot, me, leader, snap, cfg));
    } else if (followAcrossFloors(bot, me, snap, log)) {
      // leader vanished at a teleport -> chase
    } else if (homeToSurface(bot, me, log)) {
      // stranded underground -> climb home
    } else if (members.size > 1) {
      bot.move(...rallyStep(me, members, snap, cfg, leader));
    } else {
      // Truly alone (nobody else visible): hold rather than wander off.
      bot.move(0, 0);
    }
  };
}

/**
 * The leader's brain: identical readiness gate to the escorts, but it anchors the
 * party on ITSELF (found via bot.me) rather than following anyone. So the leader
 * waits up for a tight escort before initiating, using the very same P(win) score
 * every escort computes -- keeping the pack in sync.
 *
 * Navigation is real A* (navStep) over the extracted collision grid, so the leader
 * plans around walls on its own -- no hand-fed waypoint route needed to escape the
 * starter house.
 */
export function makeSwarmLeader(cfg, focusRadiusPx, log = null) {
  return function tick(bot, snap) {
    const me = meOf(bot, snap);
    if (!me) return;
    if (respawnIfDead(bot, me, log)) return;
    setNavObstacles(bot, snap, me);

    // Anchor readiness on our own name so cohesion measures the escorts' distance
    // to us.
    const { score: raw, members } =
      partyReadiness(snap, cfg, (me.name || '').toLowerCase());
    const score = smoothReadiness(bot, raw, cfg);
    const leader = me;                  // the leader IS the anchor

    if (!bot.run.swarmGreeted) {
      bot.run.swarmGreeted = true;
      log?.(`leading; party=${[...members.keys()].sort().join(',')} `
        + `readiness=${score.toFixed(2)}`);
    }

    const target = pickFocusMonster(snap, leader, focusRadiusPx, cfg.huntTypes);
    const go = combatGo(bot, score, cfg);
    if (target && go) {
      swarmHeartbeat(bot, 'lead', members, score, cfg, target, me,
        { fighting: go, log });
      engage(bot, me, target);
      return;
    }

    // Ready, but no prey in focus range: HUNT toward the nearest rat. Use
    // HYSTERESIS so the leader doesn't yo-yo: once cohesion clears huntEnter he
    // COMMITS to advancing, and only aborts back to regroup once cohesion sags
    // below huntExit. Without this the leader took one step out (which itself
    // dropped cohesion), stepped back to regroup, and drifted in place.
    const cohesion = factorCohesion(members, leader, snap, cfg);
    const wasHunting = bot.run.swarmHunting ?? false;
    const hunting = cohesion >= (wasHunting ? cfg.huntExit : cfg.huntEnter);
    bot.run.swarmHunting = hunting;

    const prey = nearestHuntable(snap, me, cfg.huntTypes);
    if (prey && hunting) {
      const pd = distPx(me.x, me.y, prey.x, prey.y) / TILE;
      const note = `hunting ${prey.monsterType} @(${Math.round(prey.x / TILE)},`
        + `${Math.round(prey.y / TILE)}) me@(${Math.round(me.x / TILE)},`
        + `${Math.round(me.y / TILE)}) d=${pd.toFixed(1)}t coh=${cohesion.toFixed(2)}`;
      swarmHeartbeat(bot, 'lead', members, score, cfg, target, me, { note, log });
      // Committed advance: walk toward the rat at a steady pace and let the escorts
      // trail. A steady lead PULLS the column; a retreat cancels it. navStep slides
      // along walls so a doorway/corner doesn't pin us.
      bot.move(...navStep(bot, me, prey.x, prey.y));
      return;
    }

    // Escort too loose (or no prey visible): wait up / regroup rather than
    // strolling off.
    const why = prey
      ? `regrouping (coh=${cohesion.toFixed(2)}<${cfg.huntEnter.toFixed(2)})`
      : 'no prey visible -- holding';
    swarmHeartbeat(bot, 'lead', members, score, cfg, target, me,
      { note: why, log });
    if (members.size > 1) {
      bot.move(...rallyStep(me, members, snap, cfg, leader));
    } else {
      bot.move(0, 0);
    }
  };
}
