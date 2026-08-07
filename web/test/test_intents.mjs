// Tests for the utility intents (heal / follow / move) and the dialogue handler.
//
// Two of these pin bugs that reached the live server, which is the bar for what
// belongs here: the assertions describe behaviour a user would notice, not
// implementation detail.

import test from 'node:test';
import assert from 'node:assert/strict';

const SRC = new URL('../src/core/', import.meta.url);
const intents = await import(new URL('intents.js', SRC).href);
const farm = await import(new URL('farm.js', SRC).href);
const nav = await import(new URL('nav.js', SRC).href);
const { TILE } = await import(new URL('protocol.js', SRC).href);

// A bot stub that records what was sent instead of touching a socket.
function botOf(over = {}) {
  const sent = [];
  return {
    me: 'ME', z: 0, run: {}, done: false, sent,
    move(dx, dy) { sent.push(['move', dx, dy]); },
    talkTo(id, opt) { sent.push(['talkTo', id, opt]); },
    useItem(id) { sent.push(['useItem', id]); },
    send(msg) { sent.push(['send', msg]); },
    findItem() { return null; },
    countItem() { return 0; },
    ...over,
  };
}

const P = (o) => ({
  id: 'ME', name: 'me', x: 0, y: 0, hp: 100, maxHp: 100, ...o,
});
const snapOf = (players, over = {}) =>
  ({ z: 0, players, monsters: [], npcs: [], groundItems: [], ...over });

const lastMove = (bot) => [...bot.sent].reverse().find((s) => s[0] === 'move');

test('resolveTarget accepts tiles, and centres them in the tile', () => {
  assert.deepEqual(intents.resolveTarget('58,22', snapOf([])),
    [(58 + 0.5) * TILE, (22 + 0.5) * TILE]);
});

test('resolveTarget falls back to a visible player, else null', () => {
  const snap = snapOf([P({ id: 'X', name: 'Sam Altman', x: 100, y: 200 })]);
  assert.deepEqual(intents.resolveTarget('sam', snap), [100, 200]);
  assert.equal(intents.resolveTarget('nobody-here', snap), null);
});

// REGRESSION (hit live): the arrival radius must not be tighter than A*'s
// one-tile step granularity. At 0.75 tiles the bot stopped on the tile ADJACENT
// to its goal -- pathStep returned [0,0] because in tile terms it had arrived,
// while makeMove still said "not arrived". It sat there sending move(0,0)
// forever, never finishing and never moving.
test('move finishes when standing one tile from the goal (no arrival deadlock)', () => {
  nav.loadMaps({ 0: { widthTiles: 10, heightTiles: 10, rows: Array(10).fill('..........'), teleports: [] } });
  const bot = botOf();
  // Goal is the centre of tile (5,5); stand on the centre of (5,6) -- exactly
  // one tile away, which is where the deadlock used to happen.
  const me = P({ x: (5 + 0.5) * TILE, y: (6 + 0.5) * TILE });
  intents.makeMove('5,5', () => {})(bot, snapOf([me]));
  assert.equal(bot.done, true, 'one tile out must count as arrived');
  assert.deepEqual(lastMove(bot), ['move', 0, 0], 'and it stops');
});

test('move keeps walking while genuinely far away', () => {
  nav.loadMaps({ 0: { widthTiles: 20, heightTiles: 20, rows: Array(20).fill('.'.repeat(20)), teleports: [] } });
  const bot = botOf();
  const me = P({ x: (2 + 0.5) * TILE, y: (2 + 0.5) * TILE });
  intents.makeMove('15,15', () => {})(bot, snapOf([me]));
  assert.equal(bot.done, false, 'still en route');
  const mv = lastMove(bot);
  assert.ok(mv[1] !== 0 || mv[2] !== 0, 'and it actually steps');
});

test('move gives up (and says who IS visible) on an unresolvable target', () => {
  const bot = botOf();
  const lines = [];
  intents.makeMove('ghost', (m) => lines.push(m))(bot, snapOf([P({ id: 'ME' })]));
  assert.equal(bot.done, true);
  assert.match(lines.join(' '), /can't resolve/);
});

test('follow has hysteresis: chase past keepPx, stop only well inside it', () => {
  nav.loadMaps({ 0: { widthTiles: 40, heightTiles: 40, rows: Array(40).fill('.'.repeat(40)), teleports: [] } });
  const keep = TILE * 2;
  const tick = intents.makeFollow('target', keep, () => {});
  const bot = botOf();
  const me = P({ id: 'ME', x: 0, y: 0 });

  // Far -> chase.
  tick(bot, snapOf([me, P({ id: 'T', name: 'target', x: TILE * 5, y: 0 })]));
  assert.equal(bot.run.followChasing, true);

  // Inside keepPx but not yet inside the stop band -> KEEP chasing. This is the
  // whole point: flipping here is what left the bot parked at the boundary.
  tick(bot, snapOf([P({ id: 'ME', x: TILE * 1.5, y: 0 }),
    P({ id: 'T', name: 'target', x: TILE * 3, y: 0 })]));
  assert.equal(bot.run.followChasing, true, 'still chasing between stopPx and keepPx');

  // Well inside -> stop.
  tick(bot, snapOf([P({ id: 'ME', x: TILE * 2.9, y: 0 }),
    P({ id: 'T', name: 'target', x: TILE * 3, y: 0 })]));
  assert.equal(bot.run.followChasing, false);
});

test('follow keeps heading to the last known spot when the target goes off screen', () => {
  nav.loadMaps({ 0: { widthTiles: 40, heightTiles: 40, rows: Array(40).fill('.'.repeat(40)), teleports: [] } });
  const tick = intents.makeFollow('target', TILE * 2, () => {});
  const bot = botOf();
  tick(bot, snapOf([P({ id: 'ME', x: 0, y: 0 }),
    P({ id: 'T', name: 'target', x: TILE * 8, y: 0 })]));
  assert.ok(bot.run.followLast, 'remembers where the target was');

  // Target vanishes from the snapshot -- must still walk toward the memory,
  // not stop dead (the "didn't continue after I moved" bug).
  tick(bot, snapOf([P({ id: 'ME', x: 0, y: 0 })]));
  const mv = lastMove(bot);
  assert.ok(mv[1] !== 0 || mv[2] !== 0, 'still moving toward the last sighting');
});

// REGRESSION (hit live): the healer path sends talkTo, but the heal itself is a
// dialogue OPTION with a dynamic id. Without an answer the bot opened the
// dialogue and stood there -- "retreat to the healer" healed nobody.
test('handleDialogue picks the heal option and closes the dialogue', () => {
  const bot = botOf();
  bot.run.healNpc = 'npc-1';
  const handled = farm.handleDialogue(bot, {
    type: 'dialogue',
    npcId: 'npc-1',
    options: [
      { id: 'quest:x', label: 'Tell me about the rats.' },
      { id: 'heal', label: 'Heal me.' },
      { id: 'bye', label: 'Not yet.' },
    ],
  }, () => {});
  assert.equal(handled, true);
  assert.deepEqual(bot.sent.find((s) => s[0] === 'talkTo'), ['talkTo', 'npc-1', 'heal']);
  assert.ok(bot.sent.some((s) => s[0] === 'send' && s[1].type === 'endDialogue'),
    'closes the dialogue so the NEXT retreat can reopen it');
  assert.equal(bot.run.healNpc, null);
});

test('handleDialogue ignores dialogue from an NPC we did not open', () => {
  const bot = botOf();
  bot.run.healNpc = 'npc-1';
  assert.equal(farm.handleDialogue(bot, {
    type: 'dialogue', npcId: 'someone-else', options: [{ id: 'heal', label: 'Heal me.' }],
  }, () => {}), false);
  assert.equal(bot.sent.length, 0);
});

test('handleDialogue still closes a dialogue that has no heal option', () => {
  const bot = botOf();
  bot.run.healNpc = 'npc-1';
  farm.handleDialogue(bot, {
    type: 'dialogue', npcId: 'npc-1', options: [{ id: 'bye', label: 'Goodbye.' }],
  }, () => {});
  assert.ok(bot.sent.some((s) => s[0] === 'send' && s[1].type === 'endDialogue'),
    'a stuck-open dialogue would swallow the next talkTo');
  assert.ok(!bot.sent.some((s) => s[0] === 'talkTo'), 'and picks nothing');
});

test('heal exits immediately at full HP', () => {
  const bot = botOf();
  intents.makeHeal({ log: () => {} })(bot, snapOf([P({ id: 'ME', hp: 100, maxHp: 100 })]));
  assert.equal(bot.done, true);
});

test('heal walks to the healer, then opens the dialogue in range', () => {
  nav.loadMaps({ 0: { widthTiles: 40, heightTiles: 40, rows: Array(40).fill('.'.repeat(40)), teleports: [] } });
  const npc = { id: 'A', name: 'Brother Aldric', npcType: 'healer', x: TILE * 10, y: 0 };
  const tick = intents.makeHeal({ log: () => {} });

  const far = botOf();
  tick(far, snapOf([P({ id: 'ME', hp: 20, x: 0, y: 0 })], { npcs: [npc] }));
  const mv = lastMove(far);
  assert.ok(mv[1] !== 0 || mv[2] !== 0, 'walks toward the healer');
  assert.ok(!far.sent.some((s) => s[0] === 'talkTo'), 'without talking from across the map');

  const near = botOf();
  tick(near, snapOf([P({ id: 'ME', hp: 20, x: TILE * 10, y: 0 })], { npcs: [npc] }));
  assert.ok(near.sent.some((s) => s[0] === 'talkTo'), 'opens the dialogue in range');
  assert.equal(near.run.healNpc, 'A', 'and records who, so handleDialogue can answer');
});
