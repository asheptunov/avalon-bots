# Avalon Farm — browser userscript

The `farm` loop from `avalon.py`, ported to JavaScript and driven from the
browser instead of a terminal. Hand someone the script and they control their
character from the page — no Python, no terminal, no credentials file.

## Why this can coexist with your open tab

The Python bot opens its own WebSocket and sends `join`. The server allows **one
connection per character**, so the bot and an open browser tab are mutually
exclusive — the incumbent wins and the newcomer gets `joinRejected`.

This userscript never connects. It patches `window.WebSocket` before the game
bundle loads, captures the socket the page opens, and rides it: reading the
snapshot stream and sending `move`/`attack` on the same connection. So

- there is no second connection to reject,
- there are no credentials to enter — you are already logged in,
- and the character it drives is the one on your screen, live.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open `avalon-farm.user.js`, copy it, and paste it into a new Tampermonkey
   script. (Or drag the file into Chrome with Tampermonkey installed.)
3. Load the game. A panel appears in the top-right.
4. Wait until your character is in the world, then press **Start**.

The bot sends nothing until you press Start.

## Controls

| Control | CLI equivalent | Notes |
|---|---|---|
| hunt | `--hunt` | which monster to seek; "(anything)" hunts all |
| retreat below % | `--retreat-hp` | fall back to the healer under this |
| resume above % | `--resume-hp` | resume fighting only above this |
| loot drops | `--loot` | sweep corpses and loose drops |
| eat / cook / stack | `--eat --cook --stack` | upkeep that makes long runs possible |

Retreat and resume are deliberately different numbers. That hysteresis is what
stops a bot at the threshold oscillating between fleeing and swinging.

## Build

The script is generated — edit `src/`, not the `.user.js`:

```
python web/build.py            # -> web/avalon-farm.user.js
node --test web/test/test_port.mjs web/test/test_bundle.mjs
```

`build.py` concatenates `src/*.js` in dependency order, strips the ES module
keywords, and embeds `avalon_maps.json` as a literal (a userscript can't read a
local file, and the game's CSP would block fetching one).

## Keeping the maps fresh

Collision maps are **generated from the game client**, which means a game
redeploy can invalidate them — trees and water move, and the bot paths into
walls the map thinks are open. The Python side re-extracts automatically on
startup; a userscript can't, so the maps are frozen at build time.

It does, however, *detect* the problem: on join the script compares the bundle
hash it was built from against the one the page is actually running, and logs

```
!! MAPS ARE STALE -- built from /assets/index-ABC.js, game is running /assets/index-XYZ.js
```

When you see that:

```
python extract_maps.py && python web/build.py
```

then reinstall the script.

## Behaviour worth knowing

- **No reconnect.** The game constructs its socket once, at module load, and on
  close only shows "disconnected" — recovery requires a page reload. The bot
  stops on close and says so; reload the tab to resume.
- **Errors are contained.** The script runs on the game's own message listener,
  so every callback is wrapped: a bug in the bot logs to the console and stops
  the loop, but never throws into the game client.
- **Nothing is sent until you press Start**, and pressing Stop halts it.

## Scope

This ports the single-character `farm` loop. The swarm (`lead`/`escort`/`swarm`)
is **not** included: it spawns one process per character, which a userscript
can't do. Driving extra characters needs an extension with a background worker
holding one socket per account — a separate build, and the place where the
credentials popup would live.

`FarmConfig` also carries the Python loop's `depth` / `entryTile` (farm
underground) and `healerName` (retreat to Brother Aldric) options. The machinery
is ported and tested, but the panel doesn't expose them yet, so they sit at their
defaults — surface-only, no healer. Wiring them up is a UI change, not a logic
one.

## Layout

```
src/protocol.js   binary codec (port of avalon_bot.py's Reader/decode_*)
src/hook.js       WebSocket interception
src/bot.js        AvalonBot over the hooked socket
src/nav.js        A* over the collision grid (port of avalon_nav.py)
src/farm.js       the farm state machine (port of avalon.py's make_farm)
src/ui.js         on-page control panel
src/main.js       wiring
```
