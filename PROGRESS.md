# Avalon Swarm — Progress Tracker

Living status doc for the bot-swarm project. Kept current as work proceeds so it
survives context compaction. Newest status at the top of each section.

Game: `avalon.juanandresleon.com` (browser MMORPG). Goal: coordinate a swarm of
bot characters (leader + escorts) to navigate and kill monsters together.

---

## Current state (2026-08-05)

**The swarm works and farms.** Dario leads; haiku/sonnet/opus/fable escort.
They pathfind around walls (A*), converge tightly (cohesion ~0.93), and
focus-fire rats together, roaming the field for the next target. Verified live:
all five engage; sustained kills.

Since the live run, three follow-ups landed (built + unit-tested, **not yet
live-smoke-tested**): readiness EMA + combat hysteresis, waypoint removal, and a
one-command `swarm` launcher with a **human-leader mode** and per-escort
**intents** (the "hive").

Bots are currently **stopped** (turned off at user request). Next live test:
human-leader mode with Sam/the user leading.

### How to run it — one command (new)
The `swarm` subcommand spawns the whole hive from a single invocation (still one
child process per character, since the server allows one char per ACCOUNT).

Bot leads:
```
python avalon.py swarm --leader dario_amodei --escort haiku,sonnet,opus,fable --hunt rat
```
YOU lead (human-leader mode — spawns only bot escorts that follow your
character; no bot leader). Give your in-world character name:
```
python avalon.py swarm --follow "Sam Altman" --escort haiku,sonnet,opus,fable --hunt rat
```
Per-escort intents via a `:suffix` (or a default `--intent`):
```
python avalon.py swarm --follow "Sam Altman" \
  --escort "haiku:defend:magnetize,sonnet:attack,opus,fable" --formation magnetize
```
Escort spec is `account[:intent[:formation]]`; omitted parts use `--intent` /
`--formation`. `--dry-run` prints the child commands (and resolves
account→character names) without spawning. Old per-shell `lead`/`escort`
commands still work.

### Intent (WHEN to engage) — orthogonal to Formation (HOW to hold station)
Intent and formation are **independent flags** that compose. All share the
readiness model.

**Intent** (`--intent`, or `:intent` per escort):
- **follow** (default) — *passive*. Fights ONLY what the **leader** is fighting
  (a monster enraged within melee reach of the leader). Never initiates; stops
  when the leader stops. Keyed on the **leader specifically** (not "any member")
  so the leader keeps control — to peel the pack off a threat, just disengage.
  Not filtered by `--hunt`: backs the leader even against an orc.
- **attack** — *aggressive*. Hunts huntable prey near the anchor unprompted,
  even when the pack isn't clustered (gates on readiness *excluding cohesion*,
  so it still respects the health floor and won't rush un-assembled into
  auto-aggro). Respects `--hunt` (only seeks what you told it to).
- **defend** — *reactive*. Peels only to a monster attacking **any** party member
  (enraged + within threat range of a member). Never hunts idle mobs. NOT
  filtered by `--hunt` — self-defense swarms whatever aggroed us (e.g. an orc)
  even while out ratting.

**Formation** (`--formation`, or `:intent:formation` per escort):
- **none** (default) — trail the leader (column-follow).
- **magnetize** — boids force-balance: anchor spring to a target ring radius +
  short-range neighbour repulsion + threat avoidance. Settles into a
  roughly-equidistant ring around the leader. Symmetric spring (no lag when the
  leader retreats). Verified in a sim: 4 escorts settle ~ring radius from the
  leader, spread out. Composes with any intent.
  - **Obstacle fix (FAR/NEAR split):** projecting the force into a goal could
    aim it THROUGH a tree, landing the goal inside the wall; A* snapped that back
    to the bot's own tile → "arrived" → frozen. Fix: when FAR from the ring, path
    to the LEADER via A* (always reachable, routes around obstacles) and stop at
    the ring; when NEAR, use the local force balance for fine spacing. Plus
    player-collision (above) so they don't stack. Sim-verified: walks around a
    tall wall, settles into an even ring, doesn't pile up.

**KEY LIVE ASSUMPTION (validate next test):** all three intents rely on the
server's `enraged` monster flag meaning "actively in a fight". Confirmed the
field is decoded (`avalon_bot.decode_snapshot`), but NOT yet confirmed in-game
that a rat you (or an attack-escort) hit actually flips `enraged=True`, nor that
an aggroing orc does. If `enraged` doesn't behave as assumed, follow/defend
won't trigger and we need the combat-event stream (`attackerId`/`targetId`,
already decoded but not routed to `on_event`) instead.

**What determines if the party attacks:** no comms. Each escort picks its target
from its intent (follow→leader's fight, attack→focus pick, defend→threatened
member) over its own snapshot, and fires if its readiness gate is open. Multiple
escorts converge on the same monster (lowest-HP-first) → focus fire emerges.

---

## Architecture

- **Independent processes, no comms.** Each bot runs the same rules over its own
  100ms snapshot, so focus-fire + rally emerge with no messaging channel. (Local
  IPC is a fallback if ever needed.)
- **Leader + escorts.** Leader anchors the party on itself; escorts follow it.
  Both compute the same party-readiness score, so "wait up before fighting"
  falls out for free.
- **Readiness = P(win fight)** in [0,1], a product of pluggable factors:
  `factor_cohesion` (pack tight near leader), `factor_health` (party HP; pinned
  low if anyone critical), `factor_threat` (aggro monsters near an unassembled
  party collapse readiness). Combat gated on `readiness >= combat_threshold`.
  Extensible: append a factor fn to `READINESS_FACTORS`.
- **Navigation = real A\*** over the game's actual collision grid (see below).

## Navigation / maps (the big win this session)

- Client has **no server-side pathfinding** — `move` is a held `(dx,dy)` heading
  (`01 01 00` = OP_MOVE east). We do our own routing.
- Extracted the game's **collision maps from the client JS bundle**:
  - `extract_maps.py` — underground floors z=-1..-6 are ASCII `rows` (`#`=wall).
  - `extract_z0.js` — surface z=0 is procedurally generated; we run the client's
    OWN generator headless in Node (faithful, not a re-port) to get a bit-exact
    grid. `extract_maps.py` invokes it and merges.
  - Output: `avalon_maps.json` (7 zones, committed).
- `avalon_nav.py` — loads the grid, `find_path` (8-connected A*, no corner-cut),
  `path_step` (cached path follower). Validated in-game tile-for-tile.
- **Dynamic obstacles (player collision):** the server blocks players from
  walking through each other, which the static map doesn't know — so bots stacked
  single-file and pinned on each other. Fix: `find_path`/`path_step` take a
  `blocked` set of occupied tiles; each bot stashes the other players' tiles on
  itself each tick (`set_nav_obstacles` → `bot._occupied`) and A* routes around
  them. Start tile is never blocked; a blocked goal snaps to the nearest free
  tile. Sim-verified: 4 stacked escorts spread into a ring, no shared tiles.
- **Key gotcha (fixed):** server labels tiles by `round(px/TILE)`, NOT
  `floor`. Flooring caused a half-tile mismatch that pinned bots at walls.
  `avalon_nav._tile` uses round.

## Z-transitions / following the leader between floors

- **Mechanic (from the bundle):** each zone has `teleports` markers, two kinds:
  - `mode:"walk"` = **hole** — step onto the tile, server auto-transitions you
    (no message).
  - `mode:"interact"` = **ladder** — get within ~1.5 tiles and send
    `{type:"useTeleport"}` (server picks the teleport by your position). Added
    `AvalonBot.use_teleport()`.
  - Each marker has a fixed dest `(toTile, toZ)`. Surface z=0 has 6 holes → z=-1
    (hardcoded in the client, not a teleports array — synthesized in extraction).
    Underground floors have holes down + ladders up; graph is bidirectional.
- **Extracted into `avalon_maps.json`** (`extract_maps.py` now also parses
  `teleports`; anchor was made robust — the zone-array var name changed from
  `const ui=` to an anonymous array). `avalon_nav.teleports(z)` /
  `nearest_teleport(z, to_z, from_tile, mode)`.
- **THE HARD PART — other floors are invisible:** the snapshot only contains
  entities on the VIEWER's own floor (every player/monster is stamped with the
  viewer's z). So when the leader descends, they simply VANISH from the escorts'
  snapshots — there's no "leader moved to z=-1" signal.
- **Follow heuristic (last-seen-hole, no comms):** each escort remembers the
  leader's floor+tile while visible (`track_leader`). When the leader vanishes
  AND was last seen on a different floor, the escort heads to the teleport on ITS
  floor nearest the leader's last-seen tile and takes it (walk onto a hole, or
  approach a ladder + `useTeleport`) — `follow_across_floors`. After
  transitioning, z updates, it re-sees the leader, normal follow resumes.
  - Limitation: guesses the nearest teleport; can pick wrong if the leader took a
    far/second teleport before the escort caught up. Good enough for "you walked
    into a hole they were trailing you toward."
  - **NOT yet live-tested** — the whole z-follow path (incl. whether walk-holes
    transition a bot exactly like the browser) needs an in-game run.

## Key facts / constraints

- **One character per ACCOUNT** in-world at a time (not per character). N bots
  need N accounts. Accounts in `creds.json` (git-ignored; extract with jq only,
  never print): sam_altman, dario_amodei, haiku, sonnet, opus, fable.
- Roster: haiku/sonnet/opus/fable → one char each; dario_amodei → "Dario
  Amodei"; sam_altman → sol/terra/luna/"sam altman".
- Server **spawns you where you last logged out**, not a fixed spawn.
- `trainingDummy` has ~16k HP — excluded via `--hunt rat` (hunt_types filter).
- TILE = 32px. `MELEE_RANGE_PX = 40`.
- Rat field is west of the starter house (rats ~tile (55-79, 21-66)).

## Operational constraints (standing)

- Sam = the user/observer. Don't change Sam's game state without permission.
- Dario is yielded for bot testing.
- Skip `devAnnounce` (broadcasts to all players). Don't spawn an actual raid.
- Don't read/print `creds.json` contents (jq extraction only).
- Commit without asking (one-line Conventional Commits, no body/trailer).
  `git push` is opt-in — ask first.

---

## Open items

Next up:

- **Live-validate the `enraged` assumption** (see KEY LIVE ASSUMPTION above) —
  the single most load-bearing unknown. Everything follow/defend depends on it.
- **Live smoke-test the reworked hive** — `swarm --follow "<my char>"` with mixed
  intents/formations. Confirm: **follow** stays idle until YOU attack something,
  then piles on, and STOPS when you disengage (leader keeps control); **defend**
  ignores idle rats but swarms a mob attacking a member; **attack** hunts on its
  own; **magnetize** self-spaces into an even ring with no lag when you retreat.
- **Verify EMA/hysteresis defaults feel right live** — defaults are
  `--readiness-smooth 0.4`, `--combat-exit = threshold-0.15`. Insurance for
  marginal packs; confirm it doesn't make engagement feel sluggish.

Deferred / nice-to-have:

- **Auto-reconnect** on `websockets ConnectionClosedError` (server dropped all
  bots once and killed the swarm; reconnect would make it resilient).
- **More intents / factors** — the hive is extensible: add intents (e.g.
  "orbit", "screen") the same way, and readiness factors by appending to
  `READINESS_FACTORS`.

## Done

- [x] Party-readiness model (cohesion/health/threat, hysteresis), parameterized.
- [x] Leader hunt-move toward nearest prey; escort follow-the-leader.
- [x] Collision-map extraction (z=-1..-6 ASCII + z=0 via headless Node).
- [x] A* pathfinding wired into leader/escort/`move`. Live-validated.
- [x] Tile-mapping fix (round vs floor).
- [x] `where` shows z + raw px.
- [x] Committed: `feat(nav): A* pathfinding over extracted collision maps + leader/escort swarm`.
- [x] Readiness EMA (`--readiness-smooth`) + combat-gate hysteresis
  (`--combat-exit`). Bot-local EMA, independent slots. Unit-tested.
- [x] Removed vestigial waypoint routing (`--route` and all `route_*` helpers).
- [x] One-command `swarm` launcher: bot-leader (`--leader`) or human-leader
  (`--follow`) mode, spawns child processes, tears down on Ctrl-C.
- [x] Escort intents: follow / attack / defend (the hive), reworked so follow is
  passive (leader-controlled), defend is threat-reactive (not a hunter), attack
  presses. All keyed on the server `enraged` flag. Unit-tested.
- [x] Split formation (magnetize) out of intent into an orthogonal `--formation`
  flag; rebalanced the boids forces into a symmetric ring spring (no retreat
  lag). Equilibrium verified in a sim.
