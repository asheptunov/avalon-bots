# Avalon Swarm — Progress Tracker

Living status doc for the bot-swarm project. Kept current as work proceeds so it
survives context compaction. Newest status at the top of each section.

Game: `avalon.juanandresleon.com` (browser MMORPG). Goal: coordinate a swarm of
bot characters (leader + escorts) to navigate and kill monsters together.

---

## 2026-08-09 — the corner "freeze" that was really a 6.6x detour (v0.11.2)

**Sam reported the v0.11.1 fix helped but did not finish the job**: still
intermittent freezes while walking toward a faraway orc, still sticking on one
corner. Both were real, and neither was the bug v0.11.1 fixed.

**It was not a freeze at all — he moved on 400 of 400 ticks.** Traced one case on
the real z=-1 map: standing at 33,86 with an orc at 22,81, he walks **east, away
from an orc sitting to his west**, for 82 seconds. A* is not confused — the path
is valid and its length ticks down 80→79→78. The two are 12 tiles apart in a
straight line and **80 tiles apart by path**: a 6.6x detour around a wall. He
always arrives. From the outside that is indistinguishable from being stuck,
which is exactly how it survived the last fix.

The v0.11.1 reach check asked *"does a path exist?"* and never *"how long is
it?"*. Two fixes:

1. **`MAX_CHASE_DETOUR` (3.0x `roamPx`).** `findPath` already returns the tiles,
   so the length is free — cap it. Prey down a longer walk is prey for a
   different patch of cave, and it now logs `UNREACHABLE` and roams instead.
   Deliberately loose: an honest corner costs more than the straight line, and
   the sweep found legitimate chases up to 2.8x, so a tighter cap would start
   refusing real fights.
2. **`ROAM_MIN_TILES` (5).** Found while checking the first fix did not just move
   the problem into ROAM — one site covered **11 tiles in 120 seconds**. Cause:
   the roam filter tested "can I take a step toward this goal", which is not "does
   this goal go anywhere". A goal landing in rock gets snapped by
   `nearestWalkable` onto the nearest open tile, which at a pocket edge is two
   tiles away. Measured: **every one of 2000 sampled goals passed the step test,
   yet the median was 3 tiles off and 59% were within 3.** Also fixed the scoring
   — when alone every candidate scored 0 against a `-Infinity` best, so the
   *first* sample always won and the other seven were wasted work. Path length is
   now the tie-breaker.

**Measured.** Worst roam stall 11 tiles/3.9 away → **55 tiles/28.5 away**; z=-2
24 → 80 tiles. Freeze sweep still **0 frozen across 1009 situations**. Suite 353.

**Throughput is unchanged: 5.74 vs 5.73 kills/min** (A/B with both constants
neutralised). With 10+ spawns a floor there is essentially always a closer orc,
so declining the long walk costs nothing. Getting that number honest took three
harness rewrites — the first two read 59.7 and 599.95 kills/min *identically on
both builds*, because the bot spent 159 of 200 ticks swinging and then, once
respawn-at-home was added, re-killed the same corpse under its feet every tick.
A metric that cannot separate the builds is not evidence; the respawn timer is
what finally made travel time dominate.

**Rejected on evidence:** ranking prey by path length instead of pixels. Sounds
right, but nearest-by-pixel disagrees with nearest-by-path in only **5.7% of 1851
situations, median 1.0x and worst 2.8x extra walking** — the mispick is not what
hurts. The absolute detour is, and it happens with only one orc in view.

---

## 2026-08-09 — the bot stops freezing at corners in the orc cave (v0.11.1)

**The symptom.** Dario locks onto an orc some distance off, never moves, and
stands near a corner until you jitter him loose. Reproduced offline against the
real extracted maps — no live session needed — and measured: **0 movement in 300
consecutive ticks**, on the tile he started on.

**It was never one bug.** It is three, all the same shape: a tick whose answer
cannot change until the bot stands somewhere else.

1. **Prey selection is nearest-by-PIXEL, and pixels go through walls.** The caves
   are not one open room. z=-2 has a 154-tile pocket around 13,47 and z=-1 the
   same shape at 63,95, whose nearby orcs are in a *different connected region* —
   flood fill confirms no path exists. Locking onto one handed A* an unroutable
   goal; the chase fell through to `pathStep`'s nudge, and `safeStep` vetoed every
   direction because the wall IS the thing in the way. `nearestHuntable` now takes
   a `reachable` predicate and **demotes** walled-off prey (same rule as
   `claimed`, so it is still visible when it is all there is), and the tick drops
   it with an `UNREACHABLE` log so ROAM relocates us.
2. **A DEFEND target is kept even when unroutable** — correctly, it is hitting
   us — so the chase branch could still command `[0,0]`. It now falls back to
   `sidestep`, the same answer the corner standoff already gives.
3. **The one that made it intermittent: roaming cached a goal it could not walk
   to, for 20 seconds.** The goal was a random point with no walkability check,
   and when alone the bot took the *first* angle it sampled. From the z=-1 ledge,
   **30% of raw random goals commanded no movement at all** — so he stood still
   until the cache expired, which is exactly why jittering him by hand worked.
   Roam now always samples 8 candidates, rejects any it cannot move toward, drops
   a stalled goal immediately, and falls back to `anyFreeStep` (any legal
   direction, shuffled) rather than emitting nothing.

Self-defense outranks all of it: `reachChecker` short-circuits on
`bot.isAttacking(m.id)`, because a landed combat event is harder evidence of
reachability than A* over a map extracted from the client bundle. Without that
the fix would have invented a new freeze — roaming away from a fight already
underway.

**Verified**: the two real freeze sites go 0/300 → **300/300 ticks moving**, and a
sweep of **1009 (stand, monster) situations across z=-1..-3 finds zero freezes**.
Cost is 0.005 ms/tick roaming and 1.74 ms/tick worst case (18 unreachable
monsters in view) against a 100 ms budget. 351 tests (+4, each seen failing
before the fix).

---

## 2026-08-08 — the depot sees through nested bags, and the trip empties the pack (#5)

**The bank was full long before it was full.** A depot box has a fixed slot
count, and `bankStep` addressed every `moveItem` at the box's own `instanceId`.
So once the top level was occupied the trip deposited nothing and the bot walked
back out with the same full pack — even when the box held bags with plenty of
room inside them. Backpacks are containers, and a backpack inside a backpack is
more storage again; Dario's depot is already a depth-2 chain.

`depotSlot(depot)` now picks the destination container instead of assuming the
box, and `moveItem` is addressed to whatever it returns.

- **Breadth-first, deliberately.** Fill the box's own slots, then a bag at depth
  1, then depth 2. Depth-first would bury the first dagger of the run at the
  bottom of the deepest chain while a sibling bag sat empty — storage nobody can
  read when they open the box.
- **Nesting does not create capacity.** Each bag still costs a slot in its
  parent and the game still charges its weight (`backpack` 5oz, `largeBackpack`
  7oz, `adventurersBackpack` 4oz). What it buys is that a full-looking box is
  rarely actually full.
- **An empty spare bag is now haul.** The old rule skipped every container in the
  pack, which made it impossible for the bot to ever *set up* the nesting. Empty
  bags get stowed (that is what grows the depot); a bag with anything in it is
  storage the player arranged, and stays.
- **Corpses are excluded.** An empty corpse in the bank looks exactly like a
  spare bag, and it despawns with the haul inside.
- **A genuinely full nest ends the trip** with a log line, instead of re-offering
  the same item until the 90 s timeout.
- The "depot open (n/m slots used)" line counts through the nesting now — the
  top-level number is a lie once the box holds bags, and this is the figure you
  use to decide whether to buy another backpack.

Bounded at depth 8 with a `seen` set: the depot structure comes from the server,
and an unbounded walk over a cycle would spin the tick rather than fail loudly.

### And then the trip stopped stopping early (v0.7.0)

Nesting made the bank hold more; it did not make the bot *use* the trip. The
stopping rule was two thresholds — under 80% carried weight, and 40% of slots
free — and the weight one bound first on every realistic haul.

Simulated against the bundle's own weight table (`plateArmor` 72oz, `chainmail`
55, `ironSword` 40, …) with Sam's real 250oz cap:

| | leaves the bank at | headroom | plate drops (72oz) before overflow |
|---|---|---|---|
| old (thresholds) | 191oz | 59oz (24%) | 0 |
| new (empty) | 47oz | 203oz (81%) | 2 |

It stopped after **5 deposits of 12**, stranding 144oz of pure haul in the bag
and walking out 72% loaded. A single plate drop overflowed that instantly — so
the rule written to prevent commuting was the thing causing it.

Now `nextDeposit` returning null is the *only* stopping condition: bank down to
the essentials and leave. The hysteresis the thresholds provided is not needed,
because you cannot leave too early when you leave with nothing left to leave —
and trips get **less** frequent, not more. `--no-bank-empty` (and the panel's
"empty the pack when banking") restores the old behaviour.

Two consequences worth noting:

- **The reserves are now the whole policy.** Nothing else stops the trip, so
  `KEEP_QUANTITY` is load-bearing in a way it was not. Kept generous — the whole
  keep-list is ~47oz against a 250oz cap, because food is nearly weightless and
  the one heavy keep is the torch (12oz), which is also the one thing you cannot
  improvise underground. `rawMeat` dropped 10 → 2: it is haul we can cook, it
  weighs *more* raw (3oz) than cooked (2oz), and ten of it was ten slots of
  half-value food.
- **`DEPOT_TIMEOUT_S` 90 → 180.** The budget covers the walk as well as the
  deposits, and a timeout mid-empty strands the bot with a half-full bag — the
  exact state this change exists to avoid.

302 tests (23 new). **Not yet live-tested** — see the open item below.

---

## 2026-08-08 — the bot goes to where its prey lives (#4)

**The bug.** Pick "caveBat" on floor 0 and the bot roamed the surface forever.
Every cave bat in the game spawns underground, `cfg.depth` was 0, and
`descendStep` is gated on `depth < 0` — so nothing ever told it to go down. It was
hunting a monster that does not exist where it was standing.

**The data was already there.** The client bundle carries a full spawn table —
155 entries of `{id, monsterType, tileX, tileY, leashTiles, nightOnly}`, one
`spawns:[…]` per underground zone plus a bare array for the surface. So this needed
no hand-written coordinate table: `maps.js` extracts it beside the terrain, and
`nav.huntingGrounds()` clusters and ranks it. `spots --hunt caveBat` prints the
answer without logging in.

| floor | spawns |
|---|---|
| z=0 | rat×21, iceWizard×13, wraith×5 (night), iceArchmage, trainingDummy |
| z=-1 | caveBat×30, orc×10 |
| z=-2 | orc×18, caveBat×6, goblin×6, orcZealot |
| z=-3 | goblin×14, caveBat×4 |
| z=-4 | caveBat×5, orrinVale |
| z=-5 | hellMage×10, hellArchmage |
| z=-6 | lizardman×8 |

### Three things that were wrong on the first pass
1. **The surface array is an assignment, not a property.** Anchoring on the record
   shape (`[{id:"…",monsterType:`) matches z=-1's inline `spawns:[…]` *first* and
   labels it the surface — which puts cave bats on z=0 and loses every rat in the
   game. The `=[` prefix is the thing that distinguishes it. Regression-tested.
2. **Depth has to be discounted.** The richest caveBat cluster is on z=-4, through
   hell past two bosses; ranking by raw count sent a level-1 character there for
   one extra bat. Each floor down now costs 55% of a spot's value, which keeps the
   hunt on z=-1.
3. **The floors are not connected regions.** z=-1 has a bat cave at the 58,22
   entrance and a separate orc den reachable *only* via the hole at 20,78 — no
   path between them. Choosing the nearest hole handed A* an unreachable goal, so
   `bestTeleportToward` now verifies connectivity and only then ranks by distance.
   Every basic mob (rat/caveBat/orc/goblin) has a verified route from town.

Also: `travel` is on by default but off whenever `--depth` is given explicitly
(that is the caller naming a floor), `--no-travel` opts out, and the panel gained a
"go to the monster's area" tick box. `ghost` is in `MONSTER_TYPES` with no spawn
point anywhere, and `wraith` is the actual night-only monster — both are now
reported rather than silently walked toward.

---

## 2026-08-07 — depot banking, and two failure modes that were killing runs

**The bot now banks.** When the pack fills it walks to the town depot, stows the
haul, and goes back to farming — so a full bag is a round trip instead of the end
of the run. `--no-bank` restores the old behaviour; `--bank-free N` sets how many
slots trigger the trip. Live-verified on Sam: filled up 30 tiles out, walked in,
deposited, resumed killing.

### What the depot actually is
Not the quest "chests" (`openChest`, one-time `chestClaimed`) — those are a
different thing. The bank is the client's **depot**: six boxes in the town depot
building, `openDepot {boxId}` → `depotUpdate {depot}`, where `depot` is an
ordinary container with an `instanceId`. So depositing is the same `moveItem`
into `{kind:'container', containerInstanceId}` that looting already used.

| box | tile | stand on | note |
|---|---|---|---|
| depot-n1..n4 | 72/74/76/78, 39 | y+1 (south) | box tiles are BLOCKED |
| depot-w1, w2 | 68, 43 / 68, 45 | x+1 (east) | |

The depot building is a **sanctuary** (client safe-zone set is
`["temple","depot"]`), so the trip is also the safest place on the map.

**We keep the consumables.** Food and potions are held back (with a per-item
reserve; surplus above it does get stowed). A bot that banks its last apple has
banked its own HP regeneration — `wellFed` is the only thing that regenerates HP.

### Three geometry traps, all paid for live
1. **`tile * TILE`, never `(tile + 0.5) * TILE`.** The server maps px→tile with
   `round()`, not `floor()`, so the half-tile form names the NEXT tile. The first
   live run walked to 75,41 instead of 74,40, sat 2.2 tiles from the box, and got
   "You are too far away" on every request.
2. **Reach is measured from the BOX, not from the tile you walk to.** Arriving at
   the standing tile is the goal; the range check has to be against the box.
3. **A\* reports "arrived" from the tile ADJACENT to the goal** (`[0,0]`). Gating
   the open on a tighter radius than A\* can deliver freezes the bot — it stands
   still re-asking a pathfinder that has already finished. Treat `[0,0]` as the
   signal to stop walking and start asking. Same trap `intents.js` documents.

### Two live failure modes, fixed
**Dario looped on a corpse, refused "too heavy to carry".** `bot.js` used to
assert weight was flavour and slots were the real limit. **That was false** — the
client says "Overloading stops you picking more up", and `playerStats` carries
`carriedWeightOz`/`capacityOz` (Sam: 191/250). Now: `bot.overloaded()` stops us
asking, and `handleLootRefusal` bans an item the server actually refused, because
the proactive check knows our total weight but not what the next item weighs.
Banking triggers on weight too — otherwise an overloaded bot with free slots
never leaves.

**Chasing a rat dropped him to z=-1 and he never came back.** A `walk`-mode
teleport fires on *contact*, so A\* was happy to route a chase straight through
one. Underground there are no rats, so he never fought, just looped looting while
cave bats ate him — and nothing could climb back, because `descendStep` only runs
when the configured depth is negative. Now `nav.trapdoorTiles(z)` makes the holes
walls whenever we are not deliberately descending, and `climbStep` recovers if we
end up on the wrong floor anyway.

`where` now prints carried weight, which is usually the answer to "why isn't it
looting?".

226 tests (`test_depot.mjs`, `test_hazards.mjs` are new); the approach was also
checked exhaustively from all 89 reachable tiles around the bank.

---

## ⚠️ 2026-08-07 — ported to JavaScript; the Python stack is gone

Everything below this banner describes the **Python** implementation, which has
been replaced by the JS one under `web/` and deleted (it remains in git history).
The game mechanics, the reasoning, and the hard-won rules are all still accurate
and worth reading — **only the file names and commands are stale.**

Translation table:

| Python (deleted) | Now |
|---|---|
| `python avalon.py <cmd> --account X` | `node web/src/cli/main.js <cmd> --account X` |
| `python extract_maps.py` | `node web/src/cli/main.js maps --out web/maps.json` |
| `python test_farm.py` | `cd web && npm test` |
| `avalon.py`, `avalon_bot.py` | `web/src/core/{farm,swarm,bot,protocol}.js` |
| `avalon_nav.py` | `web/src/core/nav.js` |
| `extract_maps.py` + `extract_z0.js` | `web/src/core/maps.js` |
| `avalon_maps.json` | `web/maps.json` (build fallback only — see below) |
| `creds.json` in-repo | `~/.avalon/creds.json`, or `AVALON_USER`/`AVALON_PASS` |

What actually changed in behaviour, not just in spelling:

- **The swarm runs in ONE process.** Python needed a child process per character
  because a blocking socket loop drives one; Node's event loop holds them all.
- **Collision maps can no longer go stale.** The CLI re-extracts from the live
  client on startup, and the userscript extracts from the bundle *the page is
  running*. `web/maps.json` is only a fallback for a failed extract.
- **There is a browser userscript** (`web/avalon-farm.user.js`) that rides the
  game page's own WebSocket, so it coexists with you playing — no second
  connection for the server to reject, and no credentials.
- **Two fixed bugs that the Python still has**: `factor_cohesion` double-counted
  the leader whenever the member query differed from the display name (a stacked
  party scored 0.5, so the combat gate never opened), and the healer path opened
  the dialogue without ever picking the heal option.

See `web/README.md` for current usage.

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

## Solo farming (`farm`) — kill / loot / cook / eat / heal

`python avalon.py --account sam_altman farm` now runs **indefinitely**: it kills,
sweeps up the drops, cooks and stacks what it picks up, eats to keep HP
regenerating, and retreats to Aldric to heal when hurt. Unit-tested (37 tests in
`test_farm.py`); **not yet live-smoke-tested**.

State machine (hysteretic, so it can't oscillate at a threshold):

| state | when | what it does |
|---|---|---|
| RETREAT | hp ≤ `--retreat-hp` (35%) | eat, fall back to the healer, potion/dialogue heal |
| FIGHT | prey visible | chase + melee the nearest `--hunt` type |
| LOOT | no prey | walk to the nearest allowed drop, `moveItem` it into the backpack |
| — | nothing to do | cook raw meat, merge split stacks, eat if hungry |
| ROAM | idle | wander `--roam` tiles so new spawns come into view |

Resumes fighting only above `--resume-hp` (85%), not at the retreat line.

### Mechanics learned from the bundle (load-bearing)

- **HP regen requires the `wellFed` status.** The tooltip is explicit: *"Health
  only regenerates while you are fed."* An unfed bot never heals between fights
  and death-spirals — this is why `farm` eats, and why `--no-eat` is a footgun.
  Statuses arrive on `welcome`/`playerStats` as
  `stats.statusEffects[{kind,remainingMs}]` → `AvalonBot.has_status()`.
- **Looting is `moveItem`, not a `pickup` verb.** Send
  `{type:"moveItem", instanceId:<the ITEM's instanceId>, to:{kind:"container",
  containerInstanceId:<backpack>}}`. The client maps groundItem.id →
  item.instanceId; we already decode `groundItems[].item.instanceId` directly.
- **Ground items are only re-sent when `groundRev` changes** — `groundItems:
  None` means *unchanged*, NOT *empty floor*. `AvalonBot.run` now carries the
  last list forward (`bot.ground_items`); without this any loot logic sees a
  bare floor on ~99% of ticks. This bit us and is easy to reintroduce.
- **Carry limit is SLOTS, not weight.** Items have `oz` weights (`Mg` in the
  bundle) but there is no capacity cap; a container has a fixed-length
  `contents` array whose `None`s are the free slots → `pack_space()`.
  Merging split stacks is what actually frees space, hence `--no-stack`'s
  warning.
- **Cooking**: `rawMeat` → `cookedMeat` by `useItem` on it (server-side, near a
  fire). Worth it — `wellFed` duration is 180s raw vs **480s** cooked (`Xg`).
- **Food choice**: any food restores regen equally; only the wellFed *duration*
  differs. So we eat the shortest-lasting food normally (saving the good stuff)
  and the longest-lasting one in an emergency (so we don't stop to eat again
  mid-retreat).
- **Loot ownership**: fresh drops carry `ownerId`/`ownerExpiresAt` reserving them
  for whoever earned the kill; we skip other people's rather than eat a refusal.
- **Monsters drop a `corpse` CONTAINER, not loose items.** The drops are in its
  `contents`; taking the corpse itself loots nothing. This is why the first live
  run killed dozens of rats and collected nothing. `contents` is already in the
  snapshot (the client's "open container" is pure UI, no round-trip), so we take
  the inner items by their own instanceId — no open step needed.

### The `.js` bundle is a moving target — maps MUST auto-refresh

The surface collision map is **generated from the client bundle** (the server
never sends terrain), so when the game redeploys, a pinned copy goes stale and
bots path straight into trees the map thinks are open. That is exactly what
happened: `index-5zRK5L7e.js` → `index-B5ZZen4-.js` moved a tree onto (61,37)
and Sam pinned on it for two whole runs.

The browser is immune because it always fetches the current bundle. We now match
that: `avalon.py` calls `nav.refresh_maps_if_stale()` on every run, comparing the
live bundle path from `index.html` against the `bundle` stamp written into
`avalon_maps.json`, and re-extracts when they differ (`--no-map-check` to skip).
`extract_z0.js` also now finds the worldgen loop by **structure, not minified
names** — the old anchor `const Gh=8,xn=e=>e+Gh,ko=[]` became
`const Qf=8,gn=e=>e+Qf,Ys=[]` and silently broke extraction.

Flags: `--hunt`, `--retreat-hp`, `--resume-hp`, `--heal-to`, `--healer`,
`--roam`, `--until-hp`, `--depth`, `--entry`, `--no-loot`, `--no-eat`,
`--no-cook`, `--no-stack`.

### Underground (`--depth`) — LIVE-VERIFIED
```
python avalon.py --account sam_altman farm --depth -1 --entry 58,22 --hunt "*"
```
Descends via the known holes, farms the floor, and climbs back out when hurt.
**Safety property:** every down-hole has its up-ladder on the SAME tile, so the
exit is always exactly where he landed (unit-tested for all of z=-1..-6).
Underground the ESCAPE branch outranks the normal retreat — the ladder ends a
fight outright, which beats trading blows on a floor with no healer.

Floors (spawn tables, from the bundle):
- **z=-1**: 30 caveBat + 10 orc — verified safe at lvl 3-4 (bats are 22 HP and
  hit for 2; Sam hits for 14-16). He leveled 3 → 4 in one ~3 min run.
- **z=-2**: 18 orc + 6 goblin + 6 caveBat + 1 orcZealot — orc-heavy, untested.
- **z=-3**: 14 goblin + 4 caveBat — the goblins you wanted, untested.

**Live run (z=-1, ~3 min): 0 deaths, 7 escapes, 10 loots, gold 23 → 32,
levelled up.** Take z=-2/-3 one at a time and watch the first minutes: orcs are
the unknown, and `--hunt goblin` would make him walk past them rather than
through them.

It **reports when the backpack fills** (`!! BACKPACK FULL`) and keeps farming
without looting, and warns on `!! OUT OF FOOD` since that silently disables
regen.

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
- **Follow trigger (last-seen-AT-a-teleport, no comms):** each escort remembers
  the leader's floor+tile while visible (`track_leader`). We CANNOT know the
  leader's new z (it's off our floor → invisible), so we can't trigger on "their
  z ≠ mine" — an early version did exactly that and it NEVER fired (the recorded
  z always equaled our own, since we only see them when co-located). Correct
  trigger: the leader vanished AND was last seen ON/next to a teleport on OUR
  floor (within `TELEPORT_TRIGGER_TILES`=2) → they took it → we take it too (walk
  onto a hole; approach a ladder + `useTeleport`) — `follow_across_floors`. If
  they vanished away from any teleport (just walked out of view), we hold.
  Because a z=0 hole and the z=-1 ladder back up share the same tile coords, an
  escort that overshoots a floor self-heals (finds the return ladder at the same
  tile). `_xfloor_note` re-arms on every fresh sighting.
  - Limitation: guesses the nearest teleport to the last-seen tile; fine for
    "you stepped into the hole they were trailing you toward."
- **Homing recovery (`home_to_surface`):** an escort stranded underground with NO
  leader in view and nothing to chase climbs toward the surface one floor at a
  time via the nearest UP teleport (`nav.nearest_upward_teleport`), until it hits
  z=0 and re-acquires the leader. Uses the fully-known teleport graph. This is
  the "get everyone back to me" path for bots that got separated. Unit-tested.
- **Auto-respawn** (`respawn_if_dead`): swarm bots respawn on death (they WILL
  die underground) instead of lying as a corpse.
  - **Live status:** first run FAILED (bad trigger). Trigger reworked, plus
    homing + respawn added, all unit-tested. Full live re-test still pending.

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

- **Live-smoke-test nested depot banking (#5)** — the search is unit-tested but
  the server's rules are not readable offline. Two unknowns: does the server
  accept a `moveItem` addressed to a container that is itself inside the depot
  (the whole feature rests on this), and is there a nesting depth it refuses?
  Dario's depth-2 chain says 2 is fine.
  - **And watch the full empty**, which is the riskier half: the bot should now
    walk out of the bank carrying only food and potions. Two things to confirm —
    that it does not time out mid-empty on a large pack (the 180 s budget covers
    the walk too), and that the reserves are actually enough to farm on, since
    nothing but `KEEP_QUANTITY` stops the trip now. If it walks out too light,
    raise the reserves rather than restoring the thresholds.
  - Still open on #5, deliberately not built: **buying backpacks from
    Quartermaster Wren**. The protocol is confirmed in the bundle (`openShop
    {npcId}` → `{buy:[{itemId,price}],sell:[…]}` → `buyItem {npcId,itemId,
    quantity}`, shopkeepers are npcType `merchant`/`smith`), but Wren is
    server-side data — not in the bundle — so the NPC, the stock and the price
    can only be confirmed live. It also spends the character's gold.
  - Also open: **sorting loot by category** into a designated bag.

- **Live-smoke-test `farm`** — the whole loop is unit-tested but has never run
  against the server. Watch for: does `moveItem` from the ground actually pick
  up (the one protocol guess we can't verify offline), does `useItem` on rawMeat
  cook rather than eat it, and does the healer dialogue re-open cleanly on the
  second retreat.
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

- [x] Corner-standoff fix (#7): melee is a pixel test but reachability is the
  server's, so around a wall a bat could hit us while our swings resolved against
  nothing — and the fight branch's `move(0, 0)` made that a livelock. The bot now
  tracks its OWN combat events (`bot.isHitting`); in range and swinging with
  nothing landing for 1.5s means a wall, and it sidesteps around it. Shared by
  the farm loop and the swarm's `engage`.
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
