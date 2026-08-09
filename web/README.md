# Avalon bots

Bots for [Avalon](https://avalon.juanandresleon.com). One set of logic, two ways
to run it:

| | Browser userscript | Headless CLI |
|---|---|---|
| Drives | the character in your open tab | its own login |
| Credentials | none — you're already logged in | `~/.avalon/creds.json` |
| Coexists with your tab | **yes** | no (one socket per character) |
| Multiple characters | no | **yes** (the swarm) |
| Who it's for | anyone you hand the script to | development and testing |

Both run the **same** `src/core/` modules. Anything verified through the CLI is
what ships in the browser.

## Why the userscript can coexist with your open tab

The server allows **one connection per character**, so a bot that opens its own
socket and an open browser tab are mutually exclusive — the incumbent wins and
the newcomer gets `joinRejected`.

The userscript never connects. It patches `window.WebSocket` before the game
bundle loads, captures the socket the page opens, and rides it: reading the
snapshot stream and sending `move`/`attack` on the same connection. So there is
no second connection to reject, no credentials to enter, and the character it
drives is the one on your screen.

## Install (userscript)

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open the [latest release](https://github.com/asheptunov/avalon-bots/releases/latest/download/avalon-farm.user.js).
   Tampermonkey offers to install it.
3. Load the game. A panel appears top-right.
4. Wait until your character is in the world, then press **Start**.

Updates are automatic — the script carries `@updateURL`, so Tampermonkey picks
up new releases on its own check. Nothing is sent until you press Start.

### Controls

| Control | CLI equivalent | Notes |
|---|---|---|
| hunt | `--hunt` | which monster to seek; "(anything)" hunts all |
| retreat below % | `--retreat-hp` | fall back to the healer under this |
| resume above % | `--resume-hp` | resume fighting only above this |
| loot drops | `--loot` | sweep corpses and loose drops |
| eat when hungry | `--no-eat` to disable | eat to hold `wellFed`, which is what regenerates HP |
| cook raw meat | `--no-cook` to disable | raw meat is worth far more cooked |
| merge stacks | `--no-stack` to disable | pour split stacks together to free pack slots |
| bank at depot when full | `--no-bank` to disable | walk to the town depot, stow the haul, come back |
| empty the pack when banking | `--no-bank-empty` to disable | stow everything but food and potions, instead of stopping at a weight/slot threshold |
| go to the monster's area | `--no-travel` to disable | walk (and descend) to where the hunted monster actually spawns |
| avoid other players | `--no-courtesy` to disable | don't tag their monsters or take their drops |

Retreat and resume are deliberately different numbers. That hysteresis is what
stops a bot at the threshold oscillating between fleeing and swinging.

### Banking

A full backpack used to be the end of a run — the bot kept killing, but every
drop past the last free slot was left on the ground. Now it walks to the **depot**
(the town bank, a sanctuary at ~74,41 on z=0), deposits, and resumes. Food and
potions are kept back: `wellFed` is the only thing that regenerates HP, so a bot
that banks its last apple has banked its own healing.

Both carry limits trigger a trip. Slots are the obvious one; **weight** is the one
that bites on ore and armour, where the pack still shows free slots while the
server refuses every pickup ("Overloading stops you picking more up"). `where`
prints both.

**The trip empties the pack** down to food and potions. It used to stop at two
thresholds — under 80% carried weight and 40% of slots free — and the weight one
bound first on any real haul: a pack of orc gear stopped after 5 deposits of 12
and walked out with 144oz still in the bag, 72% loaded before the first kill. One
plate armour drop (72oz) overflowed that and sent the bot straight back, so the
rule meant to prevent commuting was causing it. Emptying fully leaves at 47oz
instead of 191 — **3.4× the headroom**, and room for two plate drops instead of
none — which makes trips less frequent, not more. `--no-bank-empty` restores the
thresholds.

**Nested bags.** A depot box holds a fixed number of slots, but a backpack stored
in it is itself a container, and a bag inside that bag is more storage again. The
bot searches the nesting breadth-first for a free slot — box, then depth 1, then
depth 2 — so a full-looking box is rarely actually full, and the haul stays as
shallow as it can rather than being buried at the bottom of the deepest chain.
Empty spare bags in the pack get stowed (that is what grows the depot); a bag
with anything in it is left alone. Corpses are never filled.

### Going where the monster actually is

Picking a monster used to be a promise the bot couldn't keep. Choose "caveBat" on
the surface and it roamed z=0 forever, because **every cave bat in the game spawns
underground** and nothing ever told it to go down — it hunted a monster that does
not exist where it was standing.

So the hunt choice now implies a destination. The client bundle carries the whole
spawn table — 155 points of `{monsterType, tile, leashTiles, nightOnly}` — and it
is extracted alongside the collision maps, from the same bundle, so it cannot
disagree with the world:

```sh
node src/cli/main.js spots --hunt caveBat    # where would it go? (no login needed)
```

Nearby spawns are grouped into one **spot**, because a lone monster on a 5-tile
leash is a few seconds of farming and then a respawn wait — concentrations are
what make a place worth walking to. The bot picks the best spot, changes floors if
it is downstairs, walks there, and farms. It stops travelling the moment a hunted
monster comes into view, so arriving mid-cave starts the fight rather than shoving
through to a nominal centre tile.

Two rules in the ranking are worth knowing, because both were wrong first:

- **Depth is discounted, not ignored.** The richest cave-bat cluster in the bundle
  is on z=-4, through hell and past two bosses. Ranking on spawn count alone
  marched a starting character down there to gain one extra bat, so each floor
  down costs a fixed fraction of a spot's value — which keeps a bat hunt on z=-1,
  one ladder from town.
- **The floors are not connected.** z=-1 holds a bat cave around the 58,22
  entrance and a separate orc den reachable only through the hole at 20,78, with
  no path between them. So the descent picks the hole that can actually *reach*
  the spot, not the nearest one; ranking holes by distance alone walked the bot
  into the wrong cave and left it roaming — the same symptom all this removes.

Monsters with no spawn point anywhere (`ghost`) and night-only ones (`wraith`,
absent by day unless you pass `--night`) are reported rather than silently walked
toward.

### Staying out of other players' way

This is a live server with real people on it, and an untiring bot that tags the
monster someone is walking toward — or hoovers the drops off their kill — is
indistinguishable from a griefer. Courtesy is **on by default**:

- A monster with another player within ~6 tiles, *closer to it than we are*, is
  theirs. The bot drops the target and roams off to find its own. The
  "closer than we are" half is deliberate: a passer-by must not make us abandon a
  half-killed monster, which would waste our damage and hand them a mob they
  never engaged.
- A drop within ~5 tiles of another player is theirs, with no fallback. Unlike a
  monster, loot stealing is irreversible and the drop is not going anywhere, so
  leaving it is always the right call.
- With nobody else around it costs nothing — every check short-circuits on an
  empty player list.
- When there *is* somebody, roaming samples several directions and takes the one
  landing furthest from them, so the bot drifts out of a busy area on its own
  rather than waiting to be told each monster is spoken for.

`--allies alice,bob` marks other characters as **ours**, so a pair of your own
bots on one field don't each politely yield every monster to the other and farm
nothing. (The swarm has its own targeting and is unaffected.)

## CLI

```
cd web && npm install
node src/cli/main.js --help
```

Credentials go in `~/.avalon/creds.json` — deliberately outside the repo, as
either one `{"username":…,"password":…}` object or an array of them:

```json
[{"username": "alice", "password": "…"},
 {"username": "bob",   "password": "…"}]
```

`AVALON_USER` / `AVALON_PASS` override the file entirely, and `--creds <path>`
points elsewhere. `--account` names an account; `--character` may name either,
and falls back to searching for whichever account owns that character.

```sh
# farm indefinitely
node src/cli/main.js farm --account alice --hunt rat

# the whole hive in ONE process (Python needed a process per character)
node src/cli/main.js swarm --leader alice --escort bob:defend:magnetize,carol

# escorts following a HUMAN leader — you play, they fight
node src/cli/main.js swarm --follow "Your Character" --escort bob,carol

# debugging verbs
node src/cli/main.js where   --account alice
node src/cli/main.js move    58,22 --account alice
node src/cli/main.js follow  "Someone" --account alice
node src/cli/main.js heal    --account alice
node src/cli/main.js send    '{"type":"…"}' --account alice
node src/cli/main.js spots   --hunt caveBat        # no login needed
```

## Collision maps take care of themselves

The maps are **generated from the game client** — the server never sends
terrain. z=-1..-6 are ASCII grids in the bundle; z=0 is procedural, so we run the
client's *own* generator rather than re-implementing seeded noise (a re-port
diverges silently the first time the game tweaks a constant).

The same extraction picks up the **monster spawn table** and the per-floor
teleports, which is what lets the bot walk to where its prey lives. `maps` prints
the spawns per floor per type, because that is how a bad parse shows itself — a
wrong anchor still reports a plausible total, and "z=0 has no rats" is the line
that catches it.

That means a redeploy invalidates any baked-in copy, and it fails quietly: the
bot walks into a tree the map says is open. So neither runtime uses a baked-in
copy as its source of truth.

* **CLI** — re-extracts from the live client on startup.
* **Userscript** — extracts from the bundle *the page is running*, which the
  browser has already downloaded. The maps cannot disagree with the client,
  because they come from it.

`maps.json` is embedded in the build purely as a fallback for when extraction
fails; the script says so in the log when it falls back. To refresh it:

```sh
node src/cli/main.js maps --out maps.json
```

## Build

The userscript is generated — edit `src/`, never the `.user.js`:

```sh
node build.mjs      # -> avalon-farm.user.js
npm test            # 170 tests
```

`build.mjs` concatenates `src/` in dependency order, strips ES module keywords,
and embeds the map fallback. It fails the build on any surviving module syntax:
Tampermonkey silently refuses to install a script it can't parse, so the failure
has to happen here instead.

`src/core/swarm.js` and `src/core/intents.js` are deliberately **not** bundled —
the userscript drives one character and has no way to trigger them, so including
them would ship ~900 lines of unreachable code.

## Behaviour worth knowing

- **No reconnect (userscript).** The game constructs its socket once at module
  load and, on close, only shows "disconnected". The bot stops and says so;
  reload the tab to resume.
- **Errors are contained.** The script runs on the game's own message listener,
  so every callback is wrapped: a bug in the bot logs to the console and stops
  the loop, but never throws into the game client.
- **The healer needs a dialogue answer.** `talkTo` only opens the dialogue; the
  heal is an *option* with a dynamic id. `handleDialogue` picks it and sends
  `endDialogue` — without that the bot stands at the healer and heals nobody.

## Layout

```
src/core/protocol.js    binary codec
src/core/maps.js        collision-map + spawn-table extraction from the bundle
src/core/bot.js         AvalonBot: state, inventory, outbound verbs
src/core/nav.js         A* over the collision grid; hunting-ground selection
src/core/farm.js        the farm state machine
src/core/swarm.js       party readiness + escort/leader behaviour
src/core/intents.js     heal / follow / move
src/transport/browser.js  rides the game page's socket
src/transport/pagemaps.js extracts maps from the running client
src/transport/node.js     login + its own socket (CLI)
src/cli/main.js         headless CLI
src/main.js, src/ui.js  userscript entry + control panel
```
