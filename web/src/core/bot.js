// AvalonBot over a hooked socket.
//
// Deliberately the same shape as avalon_bot.py's AvalonBot so the farm loop
// ports across with only syntax changes: same method names, same state fields,
// same inventory helpers. What's gone is auth and the run loop -- we never log
// in (the page did) and we never own the socket, so `run()` becomes "react to
// frames the hook hands us".
//
// The Python version's `async def` methods are `send`-and-forget over a socket;
// here send is synchronous, so these are plain methods. Callers still `await`
// them harmlessly, which keeps the ported logic identical to read.

import {
  decodeSnapshot, decodeCombatEvent, encodeMove, encodeAttack,
  SRV_SNAPSHOT, SRV_COMBAT_EVENT,
} from './protocol.js';

/**
 * How long a monster stays "on us" after its last landed hit.
 *
 * Attacks arrive about once a second, so this has to span several swings or the
 * bot would forget its attacker between blows and flip back to hunting. Long
 * enough to survive a miss (damage=0 events are real and frequent), short enough
 * that walking away from a leashed monster ends the fight.
 */
export const ATTACKER_MEMORY_S = 6.0;

export class AvalonBot {
  constructor(send) {
    this._send = send;
    // Per-run scratch space for the farm loop and the pathfinder (chase timers,
    // loot bans, the cached A* path). It lives in ONE object so a restart can
    // reset it wholesale -- an earlier version stashed these as `_`-prefixed
    // fields on the bot and cleared them by deleting every `_` key, which also
    // deleted `_send` and killed the transport on the first Start.
    this.run = {};
    this.me = null;          // id of our player
    this.name = null;
    this.state = {};         // latest decoded snapshot
    this.groundRev = -1;
    this.groundItems = [];   // last known floor contents (see onBinary)
    this.z = null;
    this.fleeing = false;
    // Timestamp (seconds) of the last hit WE landed on anything, and on whom.
    //
    // The mirror image of attackedBy, and it exists for the corner standoff (see
    // farm.js's unreachable check). Melee is decided on pixel distance, but the
    // server enforces its own reachability: around a wall corner a monster can be
    // well inside MELEE_RANGE_PX and still be unhittable. Nothing in the snapshot
    // says so -- the only evidence is the absence of our own combat events while
    // we are swinging. So we record when we last connected; a fight where we are
    // attacking and this never advances is a fight we are not really in.
    this.lastHitAt = -Infinity;
    this.lastHitTargetId = null;
    // monsterId -> timestamp (seconds) of the last hit it landed on us.
    //
    // This is the ONLY reliable "who is attacking me" signal the server gives.
    // The snapshot's `enraged` flag is NOT it: measured live in the orc cave, an
    // orc hit us ~100 times, taking us from 199 to 20 HP, and never once came
    // through with enraged set. Anything keying self-defense off that flag is
    // dead code in production, however well it tests against hand-made
    // snapshots. See onBinary.
    this.attackedBy = new Map();
    this.equipment = {};     // slot -> item (from welcome/equipmentUpdate)
    this.stats = {};         // authoritative stats from welcome/playerStats
    this.done = false;
    this.joined = false;
    // Extra JSON-frame listeners, see onJson. Not per-run state: these are
    // installed once at wiring time and must survive a farm restart.
    this.jsonHandlers = [];
  }

  /** Register a JSON-frame listener, e.g. the healer dialogue handler. */
  onJsonMessage(fn) { this.jsonHandlers.push(fn); }

  // ---- outbound ---------------------------------------------------------

  send(msg) { return this._send(JSON.stringify(msg)); }

  move(dx, dy) { return this._send(encodeMove(dx, dy)); }

  attack(targetId) { return this._send(encodeAttack(targetId)); }

  chat(text) { return this.send({ type: 'chat', text }); }

  harvest(nodeId) { return this.send({ type: 'harvest', nodeId }); }

  /** Interact with a ladder teleport. Holes ('walk') need no message. */
  useTeleport() { return this.send({ type: 'useTeleport' }); }

  useItem(instanceId) { return this.send({ type: 'useItem', instanceId }); }

  /**
   * The one verb behind looting, stacking and dropping.
   * `to` mirrors the client's drag targets:
   *   {kind:'container', containerInstanceId, slotIndex?}
   *   {kind:'equipment', slot}
   *   {kind:'ground', x, y}
   */
  moveItem(instanceId, to, quantity) {
    const msg = { type: 'moveItem', instanceId, to };
    if (quantity != null) msg.quantity = quantity;
    return this.send(msg);
  }

  /**
   * Loot one item into the backpack. The item may lie loose on the floor OR sit
   * inside a ground container (a monster's corpse) -- the server addresses both
   * by the item's own instanceId, so no separate "open" step is needed.
   */
  takeItem(item, quantity) {
    const pack = this.backpack();
    if (!pack) return false;
    this.moveItem(item.instanceId,
      { kind: 'container', containerInstanceId: pack.instanceId }, quantity);
    return true;
  }

  talkTo(npcId, optionId) {
    const msg = { type: 'talkTo', npcId };
    if (optionId != null) msg.optionId = optionId;
    return this.send(msg);
  }

  // ---- inventory (the backpack lives in equipment, not the snapshot) -----

  /** Every item held, recursing into containers -- mirrors the client's z(). */
  *iterItems() {
    function* walk(items) {
      for (const it of items) {
        if (!it) continue;
        yield it;
        if (it.contents) yield* walk(it.contents);
      }
    }
    yield* walk(Object.values(this.equipment || {}));
  }

  findItem(itemId) {
    for (const it of this.iterItems()) if (it.itemId === itemId) return it;
    return null;
  }

  countItem(itemId) {
    let n = 0;
    for (const it of this.iterItems()) if (it.itemId === itemId) n += it.quantity || 0;
    return n;
  }

  /** The equipped backpack (the only container we loot into), or null. */
  backpack() {
    for (const it of Object.values(this.equipment || {})) {
      if (it && it.contents != null) return it;
    }
    return null;
  }

  /**
   * [freeSlots, capacity] in SLOTS. See also `overloaded()` -- slots are only
   * half the limit, and a bot that checks this one alone will loot in a loop.
   */
  packSpace() {
    const pack = this.backpack();
    if (!pack) return [0, 0];
    const contents = pack.contents || [];
    let free = 0;
    for (const c of contents) if (c == null) free++;
    return [free, contents.length];
  }

  /**
   * [carriedOz, capacityOz] from the server's own stats, or [0, 0] if it hasn't
   * told us yet.
   *
   * This exists because "slots are the real carry limit" -- which this file used
   * to assert -- is FALSE. The client says it plainly: "Overloading stops you
   * picking more up." A bot that only counts slots sees room, sends takeItem,
   * gets refused on weight, and sends it again forever. That is exactly the loop
   * Dario got stuck in on a corpse he could not lift.
   */
  weight() {
    const s = this.stats || {};
    return [s.carriedWeightOz || 0, s.capacityOz || 0];
  }

  /**
   * True when we're too heavy to pick anything else up.
   *
   * `margin` leaves headroom because the check has to be made BEFORE we know
   * what the next item weighs: at exactly capacity the server still refuses, and
   * a bot that waits for equality re-learns that once per item.
   */
  overloaded(marginOz = 0) {
    const [carried, cap] = this.weight();
    if (!cap) return false;                 // no stats yet -- don't guess
    return carried + marginOz >= cap;
  }

  /** True if a server status effect (e.g. 'wellFed') is active. */
  hasStatus(kind) {
    return (this.stats?.statusEffects || []).some((s) => s.kind === kind);
  }

  // ---- inbound ----------------------------------------------------------

  /** Feed a JSON frame from the hook. */
  onJson(msg) {
    switch (msg?.type) {
      case 'welcome':
        this.me = msg.id;
        this.name = msg.name;
        this.equipment = msg.equipment || {};
        this.stats = msg.stats || {};
        this.joined = true;
        break;
      case 'equipmentUpdate':
        this.equipment = msg.equipment || {};
        break;
      case 'playerStats':
        this.stats = msg.stats || {};
        break;
      default:
        break;
    }
    // Behaviours that must answer JSON (the healer dialogue) register here.
    // Kept as a hook rather than an import so bot.js stays behaviour-agnostic
    // and every transport gets it for free -- a transport that forgot to call
    // it would silently break healing, which is exactly how that bug happened.
    for (const fn of this.jsonHandlers) {
      try { fn(this, msg); } catch (e) { console.error('[avalon] json handler:', e); }
    }
  }

  /**
   * Feed a binary frame from the hook. Returns the decoded snapshot when this
   * frame was one, else null.
   */
  onBinary(buf) {
    const view = new Uint8Array(buf);
    if (!view.length) return null;
    const op = view[0];
    if (op === SRV_SNAPSHOT) {
      const snap = decodeSnapshot(buf, this.groundRev, this.z);
      this.groundRev = snap.groundRev;
      this.z = snap.z;
      // groundItems === null means "unchanged", NOT "empty floor" -- carry the
      // last known list forward or every consumer sees a bare floor on ~99% of
      // ticks and looting never fires.
      if (snap.groundItems == null) snap.groundItems = this.groundItems;
      else this.groundItems = snap.groundItems;
      this.state = snap;
      return snap;
    }
    // Combat events are how we learn WHO is hitting us -- the snapshot cannot
    // tell us (see attackedBy). Note a damage=0 event still counts: a miss is a
    // monster swinging at us, which is exactly the thing we want to answer.
    if (op === SRV_COMBAT_EVENT) {
      const ev = decodeCombatEvent(buf);
      if (ev.targetId === this.me && ev.attackerId) {
        this.attackedBy.set(ev.attackerId, this._now());
      }
      // Our own swing connecting. A blocked hit still counts: the server only
      // sends this when the attack actually resolved against the target, which
      // is precisely the "we can reach it" fact the corner check needs. A swing
      // at something behind a wall produces no event at all.
      if (ev.attackerId === this.me && ev.targetId) {
        this.lastHitAt = this._now();
        this.lastHitTargetId = ev.targetId;
      }
      return null;
    }
    // Death notices carry nothing the farm loop needs -- it reads hp straight
    // off the snapshot. Falling through keeps an unrecognised opcode
    // distinguishable from one we deliberately ignore.
    return null;
  }

  /** Seconds, on the same clock farm.js uses. Overridable in tests. */
  _now() { return performance.now() / 1000; }

  /**
   * True if `monsterId` has hit us within `withinS`.
   *
   * Prunes as it goes: a long run in a busy cave would otherwise accumulate an
   * entry per monster that ever landed a blow, and every one of them gets tested
   * on every tick.
   */
  /** True if one of OUR attacks landed on `monsterId` within `withinS`. */
  isHitting(monsterId, withinS = ATTACKER_MEMORY_S) {
    if (this.lastHitTargetId !== monsterId) return false;
    return this._now() - this.lastHitAt <= withinS;
  }

  isAttacking(monsterId, withinS = ATTACKER_MEMORY_S) {
    const at = this.attackedBy.get(monsterId);
    if (at === undefined) return false;
    if (this._now() - at <= withinS) return true;
    this.attackedBy.delete(monsterId);
    return false;
  }
}
