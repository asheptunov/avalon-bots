// On-page control panel: the CLI flags, as widgets.
//
// Deliberately plain DOM in a shadow root -- the game is a PixiJS canvas app and
// we must not collide with its styles or swallow its input. Everything the
// Python CLI took as a flag (--hunt, --retreat-hp, --resume-hp, --loot, ...)
// shows up here, plus a live status readout and a log tail.

import { MONSTER_TYPES } from './core/protocol.js';

const CSS = `
:host { all: initial; }
.panel {
  position: fixed; top: 12px; right: 12px; z-index: 2147483647;
  width: 268px; font: 12px/1.45 ui-monospace, Menlo, Consolas, monospace;
  color: #e6e6e6; background: rgba(18,18,22,.94);
  border: 1px solid #3a3a44; border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0,0,0,.45);
}
/* Chrome on the panel is not text -- keep a stray drag off the labels. The LOG
   is deliberately excluded: it is the only record of a run, and a blanket
   user-select:none on .panel made it impossible to copy a stall out of the
   overlay and read it anywhere else. */
.hdr, .row label, .stat, button, select, .tgl { user-select: none; }
.hdr {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-bottom: 1px solid #2c2c34; cursor: default;
}
.hdr b { font-weight: 600; letter-spacing: .3px; flex: 1; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #6b6b76; }
.dot.on { background: #4ade80; box-shadow: 0 0 6px #4ade80; }
.body { padding: 9px 10px; display: grid; gap: 8px; }
.row { display: flex; align-items: center; gap: 8px; }
.row label { flex: 1; color: #a9a9b6; }
select, input[type=number] {
  font: inherit; color: #e6e6e6; background: #24242c;
  border: 1px solid #3a3a44; border-radius: 4px; padding: 2px 5px; width: 84px;
}
input[type=checkbox] { accent-color: #4ade80; }
button {
  font: inherit; font-weight: 600; color: #0b0b0e; background: #4ade80;
  border: 0; border-radius: 5px; padding: 6px 10px; cursor: pointer; flex: 1;
}
button.stop { background: #f87171; }
button:disabled { opacity: .5; cursor: default; }
.stat { color: #a9a9b6; display: flex; justify-content: space-between; }
.stat b { color: #e6e6e6; font-weight: 600; }
.log {
  height: 108px; overflow-y: auto; background: #101014;
  border: 1px solid #2c2c34; border-radius: 4px; padding: 5px 6px;
  color: #9aa4b2; white-space: pre-wrap; word-break: break-word;
  user-select: text; -webkit-user-select: text; cursor: text;
}
.log div { margin-bottom: 1px; }
.warn { color: #fbbf24; }
.collapsed .body { display: none; }
.tgl { cursor: pointer; color: #a9a9b6; padding: 0 2px; }
`;

const HUNTABLE = MONSTER_TYPES.filter((t) => t !== 'trainingDummy');

export function createPanel({ onStart, onStop }) {
  const host = document.createElement('div');
  host.id = 'avalon-bot-panel';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;

  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `
    <div class="hdr"><span class="dot"></span><b>Avalon Farm</b><span class="tgl">–</span></div>
    <div class="body">
      <div class="row"><label for="hunt">hunt</label>
        <select id="hunt">
          <option value="">(anything)</option>
          ${HUNTABLE.map((t) => `<option value="${t}"${t === 'rat' ? ' selected' : ''}>${t}</option>`).join('')}
        </select></div>
      <div class="row"><label for="retreat">retreat below %</label>
        <input id="retreat" type="number" min="0" max="100" step="5" value="35"></div>
      <div class="row"><label for="resume">resume above %</label>
        <input id="resume" type="number" min="0" max="100" step="5" value="85"></div>
      <div class="row"><label for="loot">loot drops</label>
        <input id="loot" type="checkbox" checked></div>
      <div class="row"><label for="eat">eat when hungry</label>
        <input id="eat" type="checkbox" checked></div>
      <div class="row"><label for="cook">cook raw meat</label>
        <input id="cook" type="checkbox" checked></div>
      <div class="row"><label for="stack">merge stacks</label>
        <input id="stack" type="checkbox" checked></div>
      <div class="row"><label for="bank">bank at depot when full</label>
        <input id="bank" type="checkbox" checked></div>
      <div class="row"><label for="bank-empty">empty the pack when banking</label>
        <input id="bank-empty" type="checkbox" checked></div>
      <div class="row"><label for="travel">go to the monster's area</label>
        <input id="travel" type="checkbox" checked></div>
      <div class="row"><label for="courtesy">avoid other players</label>
        <input id="courtesy" type="checkbox" checked></div>
      <div class="row"><label for="defend">fight back when attacked</label>
        <input id="defend" type="checkbox" checked></div>
      <div class="row"><button id="go">Start</button></div>
      <div class="stat"><span>state</span><b id="s-state">idle</b></div>
      <div class="stat"><span>hp</span><b id="s-hp">–</b></div>
      <div class="stat"><span>pack</span><b id="s-pack">–</b></div>
      <div class="log" id="log"></div>
    </div>`;

  root.append(style, panel);
  (document.body || document.documentElement).appendChild(host);

  const $ = (id) => root.getElementById(id);
  const logEl = $('log');
  const dot = panel.querySelector('.dot');
  const go = $('go');
  let running = false;

  panel.querySelector('.tgl').onclick = () => {
    panel.classList.toggle('collapsed');
    panel.querySelector('.tgl').textContent =
      panel.classList.contains('collapsed') ? '+' : '–';
  };

  // Keep keystrokes in our inputs from reaching the game (WASD would walk).
  for (const ev of ['keydown', 'keyup', 'keypress']) {
    panel.addEventListener(ev, (e) => e.stopPropagation());
  }

  function readConfig() {
    const hunt = $('hunt').value;
    return {
      huntTypes: hunt ? [hunt] : null,
      retreatFrac: Math.max(0, Math.min(100, +$('retreat').value)) / 100,
      resumeFrac: Math.max(0, Math.min(100, +$('resume').value)) / 100,
      loot: $('loot').checked,
      // Three independent switches: eating keeps regen up, cooking upgrades raw
      // meat, stacking frees pack slots. They are unrelated jobs and you may
      // well want one without the others.
      eat: $('eat').checked,
      cook: $('cook').checked,
      stack: $('stack').checked,
      bank: $('bank').checked,
      bankEmpty: $('bank-empty').checked,
      // Walk to where the hunted monster actually spawns, changing floors if it
      // lives underground. Without this, picking a monster that does not spawn
      // where you are standing just roams forever -- cave bats are all on z=-1,
      // so a caveBat hunt on the surface never found a thing.
      travel: $('travel').checked,
      // Yield contested monsters and drops, and drift toward empty ground.
      // Leave it on unless you know the field is yours -- it is what keeps the
      // bot from looking like it is stealing kills.
      courtesy: $('courtesy').checked,
      // Swing back at whatever is actually hitting us, hunt filter or not. In a
      // mixed area (the orc hole is full of bats) a strict hunt filter means
      // taking the damage without ever answering it.
      defend: $('defend').checked,
    };
  }

  const api = {
    log(msg, cls) {
      const d = document.createElement('div');
      if (cls || /^!!/.test(msg)) d.className = 'warn';
      d.textContent = msg;
      logEl.appendChild(d);
      while (logEl.childElementCount > 200) logEl.removeChild(logEl.firstChild);
      logEl.scrollTop = logEl.scrollHeight;
    },
    setRunning(on) {
      running = on;
      dot.classList.toggle('on', on);
      go.textContent = on ? 'Stop' : 'Start';
      go.classList.toggle('stop', on);
    },
    setStatus({ state, hp, maxHp, free, cap }) {
      if (state != null) $('s-state').textContent = state;
      if (hp != null) $('s-hp').textContent = `${hp}/${maxHp}`;
      if (cap != null) $('s-pack').textContent = cap ? `${cap - free}/${cap}` : 'none';
    },
    enable(on) { go.disabled = !on; },
  };

  go.onclick = () => (running ? onStop() : onStart(readConfig()));
  api.setRunning(false);
  return api;
}
