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
  decodeSnapshot, encodeMove, encodeAttack, SRV_SNAPSHOT,
} from './protocol.js';

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
   * [freeSlots, capacity]. Slots -- not weight -- are the real carry limit:
   * the server has weight values for flavour but no capacity cap.
   */
  packSpace() {
    const pack = this.backpack();
    if (!pack) return [0, 0];
    const contents = pack.contents || [];
    let free = 0;
    for (const c of contents) if (c == null) free++;
    return [free, contents.length];
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
    // Combat events and death notices carry nothing the farm loop needs -- it
    // reads hp straight off the snapshot. Decoded here only so an unrecognised
    // opcode stays distinguishable from one we deliberately ignore.
    return null;
  }
}
