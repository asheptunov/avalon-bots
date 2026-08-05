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

Bots are currently **stopped** (turned off at user request).

### How to run it (today)
One process per character, each its own account (server allows one character per
ACCOUNT in-world at a time). From the repo dir:
```
python avalon.py --account dario_amodei lead   --members haiku,sonnet,opus,fable --hunt rat
python avalon.py --account haiku  escort "Dario Amodei" --members haiku,sonnet,opus,fable --hunt rat
python avalon.py --account sonnet escort "Dario Amodei" --members haiku,sonnet,opus,fable --hunt rat
python avalon.py --account opus   escort "Dario Amodei" --members haiku,sonnet,opus,fable --hunt rat
python avalon.py --account fable  escort "Dario Amodei" --members haiku,sonnet,opus,fable --hunt rat
```
(A one-command launcher is a planned improvement — see Open items.)

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
- **Key gotcha (fixed):** server labels tiles by `round(px/TILE)`, NOT
  `floor`. Flooring caused a half-tile mismatch that pinned bots at walls.
  `avalon_nav._tile` uses round.

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

Requested next (in priority order):

1. **Readiness EMA + combat hysteresis** — the instantaneous readiness jitters
   (0.61↔0.88 tick-to-tick), so the combat gate flips. Smooth readiness with an
   EMA and add combat-gate hysteresis (enter at `combat_threshold`, keep
   fighting until a lower `combat_exit`). Parameterized. *(started; not done)*
2. **Remove vestigial waypoints** — A* obsoletes `--route`/`WAYPOINT_REACHED_PX`
   /`route_advance`/`nearest_route_index`. Strip it (or keep as manual override).
3. **One-command launcher** — spin up leader + N escorts from a single command
   instead of N shells. Should support **optional human leader** (a mode where
   the user IS the leader and only bot escorts are spawned).

Deferred / nice-to-have:

- **Auto-reconnect** on `websockets ConnectionClosedError` (server dropped all
  bots once and killed the swarm; reconnect would make it resilient).

## Done

- [x] Party-readiness model (cohesion/health/threat, hysteresis), parameterized.
- [x] Leader hunt-move toward nearest prey; escort follow-the-leader.
- [x] Collision-map extraction (z=-1..-6 ASCII + z=0 via headless Node).
- [x] A* pathfinding wired into leader/escort/`move`. Live-validated.
- [x] Tile-mapping fix (round vs floor).
- [x] `where` shows z + raw px.
- [x] Committed: `feat(nav): A* pathfinding over extracted collision maps + leader/escort swarm`.
