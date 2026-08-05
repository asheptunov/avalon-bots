"""
avalon -- a human-driven CLI for issuing high-level intents to the game.

Each subcommand opens one WebSocket as your character, does its job, and
either exits (one-shot intents like `respawn`) or holds the connection and
loops until Ctrl-C (continuous intents like `farm` / `follow`).

Credentials: reads creds.json in the cwd by default. It may be a single
{"username","password"} object or an ARRAY of them. Pick which account with
--account <username> (or --character, which also selects the owning account);
or override entirely with --user/--password or AVALON_USER/AVALON_PASS.

Examples:
    python avalon.py --account dario_amodei respawn
    python avalon.py --character "Dario Amodei" heal
    python avalon.py farm
    python avalon.py follow "Dario Amodei"
    # Swarm: Sam leads, Luna/Terra/Sol escort. Nobody fights until the pack is
    # tight (party-readiness gate). Run each in its own terminal:
    python avalon.py --character "Sam Altman" lead   --members luna,terra,sol
    python avalon.py --character "Luna"       escort "Sam Altman" --members luna,terra,sol
    python avalon.py move 46,82
    python avalon.py move "Dario Amodei"
    python avalon.py where              # print everyone's position and exit
    python avalon.py send '{"type":"chat","text":"hi"}'   # raw escape hatch
"""

import argparse
import asyncio
import json
import math
import os
import sys
import time

import avalon_bot as ab
import avalon_nav as nav

TILE = 32  # px per tile, from the `welcome` message


def _now():
    return time.monotonic()

# Optional named locations. Fill in as you discover useful spots.
LOCATIONS = {
    # "bank": (60, 40),
}


# --------------------------------------------------------------------------
# credentials
# --------------------------------------------------------------------------

def load_accounts(args):
    """Return a list of {"username","password"} accounts.

    creds.json may be a single object or an array of objects. --user/--password
    or AVALON_USER/AVALON_PASS override the file entirely with one account.
    """
    user = args.user or os.environ.get("AVALON_USER")
    pw = args.password or os.environ.get("AVALON_PASS")
    if user and pw:
        return [{"username": user, "password": pw}]
    if os.path.exists(args.creds):
        with open(args.creds) as f:
            data = json.load(f)
        accts = data if isinstance(data, list) else [data]
        accts = [a for a in accts if a.get("username") and a.get("password")]
        if accts:
            return accts
    sys.exit("no credentials: use creds.json, --user/--password, or AVALON_USER/AVALON_PASS")


def pick_account(accounts, who):
    """Choose an account by --account/--character name (matches the account
    username case-insensitively, ignoring spaces/underscores). With no hint,
    require an unambiguous single account so we never guess which to log in."""
    if who:
        key = who.lower().replace(" ", "").replace("_", "")
        m = [a for a in accounts
             if a["username"].lower().replace("_", "").replace(" ", "") == key]
        if m:
            return m[0]
        # not an account name -- fall through; it may be a character name and
        # there's only one account anyway.
    if len(accounts) == 1:
        return accounts[0]
    if who:
        return None  # let caller try matching `who` as a character after login
    names = [a["username"] for a in accounts]
    sys.exit(f"multiple accounts in creds.json {names}; pass --account <username>")


def pick_character(chars, name):
    if not chars:
        sys.exit("no characters on this account")
    if name:
        c = next((c for c in chars if c.get("name", "").lower() == name.lower()), None)
        if not c:
            sys.exit(f"no character named {name!r}; have: {[c.get('name') for c in chars]}")
        return c
    return chars[0]


# --------------------------------------------------------------------------
# geometry helpers
# --------------------------------------------------------------------------

def me_of(bot, snap):
    return next((p for p in snap["players"] if p["id"] == bot.me), None)

def _norm_name(s):
    return s.lower().replace("_", " ").strip()

def name_matches(query, name):
    """Forgiving player-name match: case-insensitive, treats '_' like ' ', and
    accepts a first-word or substring hit so 'sam', 'sam_altman', and
    'Sam Altman' all resolve to the character displayed as 'sam altman'."""
    q, n = _norm_name(query), _norm_name(name)
    return n == q or (n and n.split()[0] == q) or (q and q in n)

def find_player(snap, query, exclude_id=None):
    return next((p for p in snap["players"]
                 if p["id"] != exclude_id and name_matches(query, p["name"])), None)

def step_toward(me, tx_px, ty_px):
    """Return (dx,dy) each in {-1,0,1} pointing from me toward a px target."""
    dx = (tx_px > me["x"]) - (tx_px < me["x"])
    dy = (ty_px > me["y"]) - (ty_px < me["y"])
    return dx, dy


# Within this of a waypoint counts as "arrived" -> advance to the next leg.
WAYPOINT_REACHED_PX = TILE * 1.5


def route_advance(bot, me, route):
    """Advance bot._route_i past any waypoint we've reached; return the current
    (target) index. Shared by leader and escorts so both thread the SAME
    known-walkable path (the client has no collision map, so a shared road is how
    the pack crosses walls without chasing each other's live position into a
    corner)."""
    i = getattr(bot, "_route_i", 0)
    while i < len(route) and dist_px(me["x"], me["y"], *route[i]) < WAYPOINT_REACHED_PX:
        i += 1
    bot._route_i = i
    return i


def nearest_route_index(pt, route):
    """Index of the route waypoint closest to a point (x_px, y_px). Lets an
    escort cap its own progress at the leader's spot on the road, so it trails
    rather than overtakes -- no messaging needed, just the leader's position."""
    if not route:
        return 0
    return min(range(len(route)),
               key=lambda i: dist_px(pt[0], pt[1], *route[i]))


def nav_step(bot, me, tx_px, ty_px):
    """Step toward a pixel target using real A* pathfinding over the extracted
    collision grid (avalon_nav). Routes around walls/buildings and follows the
    path tile-by-tile; on a z-level with no map it degrades to a greedy step.

    This replaced an earlier blind wall-slide heuristic once we extracted the
    client's collision map -- planning beats fumbling, so bots no longer orbit
    corners or pin in doorways."""
    return nav.path_step(bot, me, getattr(bot, "z", 0), (tx_px, ty_px))

def dist_px(ax, ay, bx, by):
    return math.hypot(ax - bx, ay - by)

def parse_route(spec):
    """';'-separated 'x,y' tile waypoints -> [(x_px, y_px), ...]. Empty -> []."""
    route = []
    for leg in spec.split(";"):
        leg = leg.strip()
        if not leg:
            continue
        xs, ys = leg.split(",", 1)
        route.append(((float(xs) + 0.5) * TILE, (float(ys) + 0.5) * TILE))
    return route

def resolve_target(spec, snap):
    """A target spec -> (x_px, y_px). Accepts 'x,y' tiles, a location name,
    or a player name (resolved against the current snapshot)."""
    if "," in spec:
        xs, ys = spec.split(",", 1)
        return (float(xs) + 0.5) * TILE, (float(ys) + 0.5) * TILE
    if spec.lower() in LOCATIONS:
        tx, ty = LOCATIONS[spec.lower()]
        return (tx + 0.5) * TILE, (ty + 0.5) * TILE
    p = find_player(snap, spec)
    if p:
        return p["x"], p["y"]
    return None


# --------------------------------------------------------------------------
# intents -- each is an on_snapshot coroutine plus optional one-shot action
# --------------------------------------------------------------------------

async def intent_where(bot, snap):
    print(f"z={bot.z}  (snap z={snap.get('z')})")
    for p in snap["players"]:
        tag = "  <- you" if p["id"] == bot.me else ""
        extra = f"  px=({p['x']:.0f},{p['y']:.0f})" if p["id"] == bot.me else ""
        print(f"{p['name']:>16}  tile=({p['x']/TILE:5.0f},{p['y']/TILE:5.0f})  "
              f"hp={p['hp']}/{p['maxHp']}  lvl={p['level']}{tag}{extra}")
    me = me_of(bot, snap)
    living = [m for m in snap["monsters"] if m["hp"] > 0]
    print(f"\n{len(living)} monsters, {len(snap['npcs'])} npcs nearby")
    if living and me:
        by_dist = sorted(living, key=lambda m: dist_px(m["x"], m["y"], me["x"], me["y"]))
        print("nearest monsters:")
        for m in by_dist[:8]:
            d = dist_px(m["x"], m["y"], me["x"], me["y"]) / TILE
            print(f"  {m['monsterType']:>12}  tile=({m['x']/TILE:5.0f},"
                  f"{m['y']/TILE:5.0f})  {d:4.1f} tiles  hp={m['hp']}/{m['maxHp']}")
    npc_names = [n.get("name") or n.get("npcType") for n in snap["npcs"]]
    if npc_names:
        print("npcs:", ", ".join(npc_names))
    held = [f"{it['itemId']} x{it['quantity']}" for it in bot.iter_items()]
    print("inventory:", ", ".join(held) if held else "(empty)")
    bot.done = True


async def intent_respawn(bot, snap):
    me = me_of(bot, snap)
    if me and me["hp"] <= 0:
        await bot.send({"type": "respawn"})
        print("respawn sent")
    elif me:
        print(f"already alive ({me['hp']}/{me['maxHp']}) at "
              f"tile ({me['x']/TILE:.0f},{me['y']/TILE:.0f})")
    bot.done = True


# HP-restoring potions, smallest first, with their heal amount (from the
# bundle's `ff={healthPotion:30,largeHealthPotion:60}`). Mana potions don't
# heal HP, so they're excluded.
HEAL_POTIONS = [("healthPotion", 30), ("largeHealthPotion", 60)]
# NPC types / names that offer a heal dialogue option.
HEALER_NAMES = {"brother aldric", "aldric"}


def make_heal(force_healer=False):
    """Heal to full. By default prefer drinking a health potion, falling back to
    a healer NPC (Brother Aldric). With force_healer=True, skip potions and go
    straight to the healer -- useful for testing the dialogue path.

    The backpack lives in the `equipment` message, not the snapshot, so this
    reads bot.equipment (populated by avalon_bot's run loop)."""
    async def intent(bot, snap):
        me = me_of(bot, snap)
        if not me:
            return
        if me["hp"] >= me["maxHp"]:
            print(f"already full ({me['hp']}/{me['maxHp']})")
            bot.done = True
            return

        # 1) Drink potions while one would actually help. A potion only counts if
        #    the missing HP is at least half its heal value -- otherwise the
        #    overheal is wasted, so we stop and let regen finish the last sliver
        #    rather than spamming useItem (which the server just ignores).
        if not force_healer:
            now = _now()
            missing = me["maxHp"] - me["hp"]
            last_drink = getattr(bot, "_heal_last_drink", 0.0)
            useful = [(bot.find_item(pid), amt) for pid, amt in HEAL_POTIONS
                      if bot.find_item(pid) and missing >= amt * 0.5]
            if useful:
                potion, amt = useful[0]
                if now - last_drink < 0.8:   # server has a short potion cooldown
                    return
                print(f"hp {me['hp']}/{me['maxHp']} -- drinking {potion['itemId']} "
                      f"(+{amt}, x{bot.count_item(potion['itemId'])} held)")
                await bot.use_item(potion["instanceId"])
                bot._heal_last_drink = now
                return
            if last_drink:
                held = sum(bot.count_item(pid) for pid, _ in HEAL_POTIONS)
                tail = ("out of health potions" if not held
                        else "close enough (regen will finish)")
                print(f"hp {me['hp']}/{me['maxHp']} -- {tail}")
                bot.done = True
                return

        # 2) Head to a healer NPC and use their dialogue.
        healer = next((n for n in snap["npcs"]
                       if n.get("name", "").lower() in HEALER_NAMES
                       or n.get("npcType", "").lower() in HEALER_NAMES), None)
        if not healer:
            print(f"hp {me['hp']}/{me['maxHp']} -- no healer NPC nearby. "
                  "Move to Brother Aldric, then run `heal` again.")
            bot.done = True
            return

        if dist_px(me["x"], me["y"], healer["x"], healer["y"]) > TILE * 1.5:
            # Walk to the healer first.
            await bot.move(*step_toward(me, healer["x"], healer["y"]))
            return

        # In range: stop and open the dialogue. The heal option id is dynamic,
        # so we open the dialogue and let on_event pick the heal option.
        await bot.move(0, 0)
        if not getattr(bot, "_heal_talk_sent", False):
            bot._heal_talk_sent = True
            bot._heal_npc = healer["id"]
            print(f"hp {me['hp']}/{me['maxHp']} -- talking to {healer.get('name')}")
            await bot.talk_to(healer["id"])
    return intent


async def heal_on_event(bot, msg):
    """Dialogue handler for the Aldric heal path: when the dialogue arrives,
    pick the option whose label looks like healing and send it back."""
    if msg.get("type") != "dialogue":
        return
    if msg.get("npcId") != getattr(bot, "_heal_npc", None):
        return
    opts = msg.get("options") or []
    heal_opt = next((o for o in opts
                     if "heal" in (o.get("label", "") + o.get("id", "")).lower()
                     or "cure" in o.get("label", "").lower()), None)
    if heal_opt:
        print(f"  picking dialogue option: {heal_opt.get('label')!r}")
        await bot.talk_to(bot._heal_npc, heal_opt["id"])
    else:
        labels = [o.get("label") for o in opts]
        print(f"  no heal option in dialogue; options were: {labels}")
    bot.done = True


def make_follow(target_name, keep_px):
    """Trail a player, staying ~keep_px behind.

    Two things make this actually sticky where the naive version stalls:

    * Hysteresis: start chasing when the gap exceeds keep_px, but only *stop*
      once we're comfortably inside it (keep_px*0.6). Without this the bot
      sits right at the boundary flip-flopping between move and stop and can
      end up parked while the target drifts away a pixel at a time.

    * Last-known-position memory: when the target walks off our screen the
      snapshot no longer lists them (`t is None`). The old code stopped dead
      there, which is exactly the "didn't continue after I moved again" bug.
      Instead we keep walking toward where we last saw them for a few seconds,
      which carries us far enough to re-acquire them on the next screen.
    """
    stop_px = keep_px * 0.6
    LOST_GRACE_S = 4.0  # keep chasing a vanished target this long

    async def intent(bot, snap):
        me = me_of(bot, snap)
        if not me:
            return
        t = find_player(snap, target_name, exclude_id=bot.me)

        if t:
            if not getattr(bot, "_follow_seen", False):
                bot._follow_seen = True
                print(f"following {t['name']!r} "
                      f"(keep {keep_px/TILE:.0f} tiles behind)", file=sys.stderr)
            bot._follow_last = (t["x"], t["y"], _now())
            tx, ty = t["x"], t["y"]
        else:
            last = getattr(bot, "_follow_last", None)
            if not last or _now() - last[2] > LOST_GRACE_S:
                # Never seen them, or lost too long ago -- hold position and,
                # the first time, say who *is* visible so a name typo/mismatch
                # (the usual "it just stands there" cause) is obvious.
                if not getattr(bot, "_follow_warned", False):
                    bot._follow_warned = True
                    visible = [p["name"] for p in snap["players"]
                               if p["id"] != bot.me]
                    print(f"target {target_name!r} not in view. Visible players: "
                          f"{visible or '(none)'}", file=sys.stderr)
                await bot.move(0, 0)
                return
            tx, ty = last[0], last[1]

        d = dist_px(me["x"], me["y"], tx, ty)
        chasing = getattr(bot, "_follow_chasing", False)
        if d > keep_px:
            chasing = True
        elif d <= stop_px:
            chasing = False
        bot._follow_chasing = chasing

        if chasing:
            await bot.move(*step_toward(me, tx, ty))
        else:
            await bot.move(0, 0)
    return intent


def pick_focus_monster(snap, leader, radius_px, hunt_types=None):
    """The monster the pack should focus: the lowest-HP living monster within
    radius_px of the leader. Everyone applying this same rule independently
    converges on one target -- focus-fire with no coordination channel.

    hunt_types (a set of monsterType strings) restricts what counts as a target,
    so the pack won't dogpile a 16k-HP training dummy or aggro a boss it wandered
    past. None means "anything"."""
    if not leader:
        return None
    near = [m for m in snap["monsters"]
            if m["hp"] > 0
            and (hunt_types is None or m["monsterType"] in hunt_types)
            and dist_px(m["x"], m["y"], leader["x"], leader["y"]) <= radius_px]
    return min(near, key=lambda m: m["hp"]) if near else None


def nearest_huntable(snap, anchor, hunt_types):
    """Nearest living monster of a huntable type to the anchor, or None. Used by
    the leader to walk the party toward prey when nothing's in focus range."""
    prey = [m for m in snap["monsters"]
            if m["hp"] > 0
            and (hunt_types is None or m["monsterType"] in hunt_types)]
    if not prey:
        return None
    return min(prey, key=lambda m: dist_px(m["x"], m["y"], anchor["x"], anchor["y"]))


# --------------------------------------------------------------------------
# party readiness -- the shared "should we fight?" brain
# --------------------------------------------------------------------------
#
# Every swarm bot (leader and escorts alike) computes the SAME readiness score
# from its own snapshot, so they gate combat consistently with no messaging.
# Readiness is a probability-like score in [0,1] -- think P(the squad wins this
# engagement). Combat is allowed only when readiness >= COMBAT_THRESHOLD.
#
# It's a product of independent factors, each a function
# (party_members, leader, snap, cfg) -> [0,1]. To add a new consideration
# (retreat when someone's dying, back off from a boss, ...), write another
# factor and append it to READINESS_FACTORS -- nothing else changes.

# Monster types that auto-aggro (charge the party unprompted). Rats don't; orcs
# and friends do. Presence of these near an unassembled party tanks readiness so
# the pack avoids them until everyone's together.
AGGRO_MONSTERS = {"orc", "orcZealot", "goblin", "wraith", "hellMage",
                  "hellArchmage", "iceWizard", "lizardman", "orrinVale"}


class PartyConfig:
    """All the tunables for the readiness model in one editable place."""
    def __init__(self, member_names, rally_px, threat_px,
                 combat_threshold=0.6, low_hp_frac=0.35, hunt_types=None,
                 cohesion_slack=2.5, hunt_enter=0.5, hunt_exit=0.3,
                 follow_gap_px=None):
        self.member_names = member_names        # names that make up the party
        self.rally_px = rally_px                # "tight" = within this of leader
        self.threat_px = threat_px              # aggro monsters this close matter
        self.combat_threshold = combat_threshold
        self.low_hp_frac = low_hp_frac
        self.hunt_types = hunt_types            # monster types to hunt (None=any)
        # Cohesion falloff: a member scores 0 only past rally_px*cohesion_slack.
        # Larger = a loose-but-nearby clump still reads as "tight enough".
        self.cohesion_slack = cohesion_slack
        # Sticky-hunt hysteresis: the leader COMMITS to advancing once cohesion
        # clears hunt_enter, and only aborts back to regroup below hunt_exit. The
        # gap between the two is what kills the one-step-out/one-step-back drift.
        self.hunt_enter = hunt_enter
        self.hunt_exit = hunt_exit
        # How close an escort trails the leader (defaults to rally_px).
        self.follow_gap_px = follow_gap_px if follow_gap_px is not None else rally_px


def party_members(snap, cfg, leader_name):
    """The party members currently visible in this snapshot (leader included),
    keyed by matched name. Missing members simply won't appear -- factors treat
    absence as 'not ready'."""
    names = set(cfg.member_names) | {leader_name}
    seen = {}
    for p in snap["players"]:
        for want in names:
            if want not in seen and name_matches(want, p["name"]):
                seen[want] = p
    return seen


def factor_cohesion(members, leader, snap, cfg):
    """1.0 when every named member is present AND within rally_px of the leader;
    degrades toward 0 as members go missing or straggle. This is the 'tight
    escort' gate."""
    if not leader:
        return 0.0
    n_expected = len(set(cfg.member_names) | {leader["name"].lower()})
    # Count everyone we can actually place, scored by how close they are.
    scores = []
    for p in members.values():
        d = dist_px(p["x"], p["y"], leader["x"], leader["y"])
        scores.append(max(0.0, 1.0 - d / (cfg.rally_px * cfg.cohesion_slack)))
    # Missing members contribute 0.
    scores += [0.0] * max(0, n_expected - len(members))
    return sum(scores) / max(1, n_expected)


def factor_health(members, leader, snap, cfg):
    """Party HP: 1.0 all-healthy, dropping as anyone gets hurt, and pinned low
    if someone is below low_hp_frac (a near-dead member means P(win) is poor)."""
    if not members:
        return 0.0
    fracs = [p["hp"] / max(1, p["maxHp"]) for p in members.values()]
    if min(fracs) < cfg.low_hp_frac:
        return min(fracs)          # someone's critical -> squad isn't ready
    return sum(fracs) / len(fracs)


def factor_threat(members, leader, snap, cfg):
    """Auto-aggro monsters near the party gate on cohesion: if orcs are close
    while the pack is NOT assembled, readiness collapses so they avoid the fight
    until together. Once assembled, the same monsters don't hold them back."""
    if not leader:
        return 1.0
    aggro_near = any(
        m["hp"] > 0 and m["monsterType"] in AGGRO_MONSTERS
        and dist_px(m["x"], m["y"], leader["x"], leader["y"]) <= cfg.threat_px
        for m in snap["monsters"])
    if not aggro_near:
        return 1.0
    # Aggro present: readiness rides entirely on being assembled.
    return factor_cohesion(members, leader, snap, cfg)


READINESS_FACTORS = [factor_cohesion, factor_health, factor_threat]


def party_readiness(snap, cfg, leader_name):
    """P(squad wins the engagement), in [0,1]: the product of all factors.
    Returns (score, members, leader) so callers can reuse the resolved party."""
    members = party_members(snap, cfg, leader_name)
    leader = members.get(leader_name) or find_player(snap, leader_name)
    score = 1.0
    for f in READINESS_FACTORS:
        score *= f(members, leader, snap, cfg)
    return score, members, leader


def party_centroid(members, exclude_id=None):
    pts = [(p["x"], p["y"]) for p in members.values() if p["id"] != exclude_id]
    if not pts:
        return None
    return sum(x for x, _ in pts) / len(pts), sum(y for _, y in pts) / len(pts)


def rally_step(me, members, snap, cfg, leader):
    """A (dx,dy) that regroups the party while AVOIDING aggro threats -- so a
    straggler converges on the pack instead of strolling through the line of
    fire. Move toward the party centroid, then bias away from any near aggro
    monster."""
    centroid = party_centroid(members, exclude_id=me["id"]) or (
        (leader["x"], leader["y"]) if leader else (me["x"], me["y"]))
    tx, ty = centroid
    # Repel from the nearest aggro monster within threat range.
    threats = [m for m in snap["monsters"]
               if m["hp"] > 0 and m["monsterType"] in AGGRO_MONSTERS
               and dist_px(m["x"], m["y"], me["x"], me["y"]) <= cfg.threat_px]
    if threats:
        thr = min(threats, key=lambda m: dist_px(m["x"], m["y"], me["x"], me["y"]))
        # Nudge the target point away from the threat.
        tx += (me["x"] - thr["x"])
        ty += (me["y"] - thr["y"])
    return step_toward(me, tx, ty)


def follow_leader_step(bot, me, leader, snap, cfg):
    """A (dx,dy) that trails the LEADER (not the party centroid), so the column
    tracks a moving leader out of the house instead of converging on itself.
    Holds position once within follow_gap_px; biases away from near aggro; and
    slides along walls (via nav_step) so escorts don't pin on the doorway."""
    if not leader:
        return 0, 0
    d = dist_px(me["x"], me["y"], leader["x"], leader["y"])
    if d <= cfg.follow_gap_px:
        return 0, 0                     # close enough -- don't crowd the leader
    tx, ty = leader["x"], leader["y"]
    threats = [m for m in snap["monsters"]
               if m["hp"] > 0 and m["monsterType"] in AGGRO_MONSTERS
               and dist_px(m["x"], m["y"], me["x"], me["y"]) <= cfg.threat_px]
    if threats:
        thr = min(threats, key=lambda m: dist_px(m["x"], m["y"], me["x"], me["y"]))
        tx += (me["x"] - thr["x"])
        ty += (me["y"] - thr["y"])
    return nav_step(bot, me, tx, ty)


def swarm_heartbeat(bot, role, members, score, cfg, target, me, period=2.0,
                    note=None):
    """Throttled live readout so a running swarm is legible in its log: prints
    at most every `period` seconds, and immediately whenever the state changes.
    `note` lets a caller name the current purpose (e.g. 'hunting rat @(78,49)'
    vs 'regrouping') so the log shows intent over time, not just fight/wait."""
    fighting = bool(target and score >= cfg.combat_threshold)
    state = ("FIGHTING " + target["monsterType"]) if fighting else (
        note or ("waiting (not ready)" if target else "no target -- rallying"))
    now = _now()
    last = getattr(bot, "_hb_last", 0.0)
    flipped = getattr(bot, "_hb_state", None) != state
    if not flipped and now - last < period:
        return
    bot._hb_last = now
    bot._hb_state = state
    print(f"{role}: readiness={score:.2f} party={len(members)} "
          f"hp={me['hp']}/{me['maxHp']} -> {state}", file=sys.stderr)


def make_swarm(leader_name, cfg, focus_radius_px, is_leader):
    """One brain for both roles. Every tick:

      1. Compute party readiness (the shared P(win) score) from our snapshot.
      2. If ready AND there's a target -> everyone focus-fires the same monster.
      3. If NOT ready -> rally: converge on the party while dodging aggro
         threats (so we minimize non-combat exposure). The leader waits up here
         too, so the pack never desyncs into a cross-map stroll.

    is_leader only changes idle/fallback wandering, not the combat gate -- the
    leader obeys the same readiness rule as the escorts, which is what makes the
    'wait up before fighting' behavior fall out for free."""
    async def intent(bot, snap):
        me = me_of(bot, snap)
        if not me:
            return

        score, members, leader = party_readiness(snap, cfg, leader_name)

        # One-time visibility hint for a name mismatch / offline member.
        if not getattr(bot, "_swarm_greeted", False):
            bot._swarm_greeted = True
            role = "leading" if is_leader else f"escorting {leader_name!r}"
            print(f"{role}; party={sorted(members)} readiness={score:.2f}",
                  file=sys.stderr)

        anchor = leader or me
        target = pick_focus_monster(snap, anchor, focus_radius_px, cfg.hunt_types)
        swarm_heartbeat(bot, f"escort {me['name']}", members, score, cfg, target, me)

        # Gate: only fight when the squad is ready enough to win.
        if target and score >= cfg.combat_threshold:
            if dist_px(me["x"], me["y"], target["x"], target["y"]) < ab.MELEE_RANGE_PX:
                await bot.move(0, 0)
                await bot.attack(target["id"])
            else:
                await bot.move(*nav_step(bot, me, target["x"], target["y"]))
            return

        # Not ready (or nothing to fight): trail the leader directly so the
        # column tracks him out of the house. Falls back to centroid regroup if
        # the leader isn't visible this snapshot.
        if leader:
            await bot.move(*follow_leader_step(bot, me, leader, snap, cfg))
        elif len(members) > 1:
            await bot.move(*rally_step(me, members, snap, cfg, leader))
        else:
            # Truly alone (nobody else visible): hold rather than wander off.
            await bot.move(0, 0)
    return intent


def make_swarm_leader(cfg, focus_radius_px, route=None):
    """The leader's brain: identical readiness gate to the escorts, but it
    anchors the party on ITSELF (found via bot.me) rather than following anyone.
    So the leader waits up for a tight escort before initiating, using the very
    same P(win) score every escort computes -- keeping the pack in sync.

    `route` is an optional list of (x_px, y_px) waypoints. The client has no
    collision map, so we can't PLAN around walls -- instead the caller hands us a
    known-walkable path and we walk it in order (bringing the pack) before
    hunting locally at the end. This is what gets them out of the starter house
    without orbiting a corner."""
    route = route or []
    async def intent(bot, snap):
        me = me_of(bot, snap)
        if not me:
            return
        # Anchor readiness on our own name so cohesion measures the escorts'
        # distance to us.
        score, members, _ = party_readiness(snap, cfg, me["name"].lower())
        leader = me  # the leader IS the anchor

        if not getattr(bot, "_swarm_greeted", False):
            bot._swarm_greeted = True
            extra = f" route={len(route)}wp" if route else ""
            print(f"leading; party={sorted(members)} readiness={score:.2f}{extra}",
                  file=sys.stderr)

        # ROUTE: walk the given waypoints (in order) before hunting locally.
        # Combat still preempts below, so a monster blocking the path gets
        # fought; but with no target we follow the road, not the nearest rat.
        wp_i = getattr(bot, "_route_i", 0)
        if wp_i < len(route):
            wx, wy = route[wp_i]
            if dist_px(me["x"], me["y"], wx, wy) < WAYPOINT_REACHED_PX:
                bot._route_i = wp_i + 1          # arrived -> next leg
                wp_i += 1
        if wp_i < len(route):
            wx, wy = route[wp_i]
            # Only advance the pack once cohesion is decent (same wait-up idea),
            # so escorts don't get strung out between rooms.
            cohesion = factor_cohesion(members, leader, snap, cfg)
            hunting = getattr(bot, "_swarm_hunting", False)
            hunting = cohesion >= (cfg.hunt_exit if hunting else cfg.hunt_enter)
            bot._swarm_hunting = hunting
            # Fight anything huntable already in range/ready even while enroute.
            block = pick_focus_monster(snap, leader, focus_radius_px, cfg.hunt_types)
            if not (block and score >= cfg.combat_threshold):
                note = (f"enroute wp {wp_i+1}/{len(route)} -> "
                        f"({wx/TILE:.0f},{wy/TILE:.0f}) "
                        f"me@({me['x']/TILE:.0f},{me['y']/TILE:.0f}) coh={cohesion:.2f}")
                swarm_heartbeat(bot, "lead", members, score, cfg, None, me, note=note)
                if hunting:
                    await bot.move(*nav_step(bot, me, wx, wy))
                else:
                    await bot.move(*rally_step(me, members, snap, cfg, leader))
                return

        target = pick_focus_monster(snap, leader, focus_radius_px, cfg.hunt_types)
        if target and score >= cfg.combat_threshold:
            swarm_heartbeat(bot, "lead", members, score, cfg, target, me)
            if dist_px(me["x"], me["y"], target["x"], target["y"]) < ab.MELEE_RANGE_PX:
                await bot.move(0, 0)
                await bot.attack(target["id"])
            else:
                await bot.move(*nav_step(bot, me, target["x"], target["y"]))
            return

        # Ready, but no prey in focus range: HUNT toward the nearest rat. Use
        # HYSTERESIS so the leader doesn't yo-yo: once cohesion clears hunt_enter
        # he COMMITS to advancing, and only aborts back to regroup once cohesion
        # sags below hunt_exit. Without this the leader took one step out (which
        # itself dropped cohesion), stepped back to regroup, and drifted in place.
        cohesion = factor_cohesion(members, leader, snap, cfg)
        hunting = getattr(bot, "_swarm_hunting", False)
        hunting = cohesion >= (cfg.hunt_exit if hunting else cfg.hunt_enter)
        bot._swarm_hunting = hunting

        prey = nearest_huntable(snap, me, cfg.hunt_types)
        if prey and hunting:
            pd = dist_px(me["x"], me["y"], prey["x"], prey["y"]) / TILE
            note = (f"hunting {prey['monsterType']} @"
                    f"({prey['x']/TILE:.0f},{prey['y']/TILE:.0f}) "
                    f"me@({me['x']/TILE:.0f},{me['y']/TILE:.0f}) "
                    f"d={pd:.1f}t coh={cohesion:.2f}")
            swarm_heartbeat(bot, "lead", members, score, cfg, target, me, note=note)
            # Committed advance: walk toward the rat at a steady pace and let the
            # escorts trail. A steady lead PULLS the column; a retreat cancels it.
            # nav_step slides along walls so a doorway/corner doesn't pin us.
            await bot.move(*nav_step(bot, me, prey["x"], prey["y"]))
            return

        # Escort too loose (or no prey visible): wait up / regroup rather than
        # strolling off.
        why = (f"regrouping (coh={cohesion:.2f}<{cfg.hunt_enter:.2f})"
               if prey else "no prey visible -- holding")
        swarm_heartbeat(bot, "lead", members, score, cfg, target, me, note=why)
        if len(members) > 1:
            await bot.move(*rally_step(me, members, snap, cfg, leader))
        else:
            await bot.move(0, 0)
    return intent


def make_move(spec):
    async def intent(bot, snap):
        me = me_of(bot, snap)
        if not me:
            return
        dest = resolve_target(spec, snap)
        if dest is None:
            print(f"cannot resolve target {spec!r}")
            bot.done = True
            return
        tx, ty = dest
        if dist_px(me["x"], me["y"], tx, ty) <= TILE:
            await bot.move(0, 0)
            print(f"arrived at tile ({me['x']/TILE:.0f},{me['y']/TILE:.0f})")
            bot.done = True
        else:
            await bot.move(*nav_step(bot, me, tx, ty))
    return intent


def make_farm(until_hp_frac=None):
    """Fight nearby monsters. If until_hp_frac is set, stop and exit cleanly
    once HP falls to that fraction (a safe grind-to-X%, no death spiral)."""
    async def intent(bot, snap):
        me = me_of(bot, snap)
        if me and until_hp_frac is not None:
            frac = me["hp"] / max(1, me["maxHp"])
            if frac <= until_hp_frac:
                await bot.move(0, 0)
                print(f"reached {me['hp']}/{me['maxHp']} "
                      f"({frac*100:.0f}% <= {until_hp_frac*100:.0f}%) -- stopping")
                bot.done = True
                return
        # Reuse the flee-aware combat AI already in avalon_bot.
        await ab.example_ai(bot, snap)
    return intent


def make_send(raw):
    async def intent(bot, snap):
        msg = json.loads(raw)
        await bot.send(msg)
        print("sent:", msg)
        bot.done = True
    return intent


# --------------------------------------------------------------------------
# runner
# --------------------------------------------------------------------------

async def run(bot, intent, on_event=None):
    """Wrap the intent so a `bot.done` flag can close a one-shot cleanly."""
    bot.done = False

    async def wrapped(b, snap):
        # Once done, the socket is closing -- don't run the intent again (it
        # would try to send on a closed socket and raise ConnectionClosed).
        if getattr(b, "done", False):
            return
        await intent(b, snap)
        if getattr(b, "done", False):
            await b.ws.close()

    async def wrapped_event(b, msg):
        if getattr(b, "done", False):
            return
        if on_event:
            await on_event(b, msg)
        if getattr(b, "done", False):
            await b.ws.close()

    try:
        await bot.run(on_snapshot=wrapped, on_event=wrapped_event)
    except ab.JoinRejected as e:
        sys.exit(f"join rejected: {e}\n"
                 "That character is already in the world -- close the browser "
                 "tab playing it, or use --character for a different one.")
    except (KeyboardInterrupt, asyncio.CancelledError):
        print("\nstopped")


def build_intent(args):
    """Return (on_snapshot, on_event); on_event is None for most commands."""
    if args.cmd == "where":
        return intent_where, None
    if args.cmd == "respawn":
        return intent_respawn, None
    if args.cmd == "heal":
        return make_heal(force_healer=args.healer), heal_on_event
    if args.cmd == "farm":
        frac = (args.until_hp / 100.0) if args.until_hp is not None else None
        return make_farm(frac), None
    if args.cmd == "follow":
        return make_follow(args.target, args.keep * TILE), None
    if args.cmd in ("escort", "lead"):
        is_leader = args.cmd == "lead"
        leader_name = "" if is_leader else args.leader
        # For the leader, "the party" is the escorts; for an escort, it's the
        # other escorts plus itself. Both need the full member list to score
        # cohesion, so we pass every named member either way.
        members = [m.strip() for m in args.members.split(",") if m.strip()]
        hunt = {h.strip() for h in args.hunt.split(",") if h.strip()}
        # "*" (or empty) means hunt anything -> None disables the type filter.
        hunt_types = None if (not hunt or "*" in hunt) else hunt
        cfg = PartyConfig(
            member_names=[m.lower() for m in members],
            rally_px=args.rally * TILE,
            threat_px=args.threat * TILE,
            combat_threshold=args.threshold,
            hunt_types=hunt_types,
            cohesion_slack=args.cohesion_slack,
            hunt_enter=args.hunt_enter,
            hunt_exit=args.hunt_exit,
        )
        # A leader has no "leader_name" to follow, so it anchors on itself: use
        # its own display name once known. We pass "" and make_swarm falls back
        # to `me` as the anchor when leader can't be resolved.
        if is_leader:
            # The leader is itself part of the party for cohesion scoring.
            route = parse_route(getattr(args, "route", ""))
            return make_swarm_leader(cfg, args.focus_radius * TILE, route=route), None
        return make_swarm(leader_name, cfg, args.focus_radius * TILE,
                          is_leader=False), None
    if args.cmd == "move":
        return make_move(args.target), None
    if args.cmd == "send":
        return make_send(args.json), None
    sys.exit(f"unknown command {args.cmd}")


def main():
    p = argparse.ArgumentParser(prog="avalon", description=__doc__)
    p.add_argument("--creds", default="creds.json")
    p.add_argument("--user")
    p.add_argument("--password")
    p.add_argument("--account", help="account username to log into (creds.json array)")
    p.add_argument("--character", help="character name (default: first on the account)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("where", help="print positions of everyone visible and exit")
    sub.add_parser("respawn", help="respawn if dead")

    h = sub.add_parser("heal", help="drink a health potion, else visit a healer NPC")
    h.add_argument("--healer", action="store_true",
                   help="skip potions; go straight to Brother Aldric")

    fa = sub.add_parser("farm", help="fight nearby monsters until Ctrl-C")
    fa.add_argument("--until-hp", type=float, default=None, metavar="PCT",
                    help="stop and exit once HP drops to this %% (e.g. 50)")

    f = sub.add_parser("follow", help="follow a player until Ctrl-C")
    f.add_argument("target")
    f.add_argument("--keep", type=int, default=2, help="tiles to keep behind (default 2)")

    def add_swarm_args(sp):
        sp.add_argument("--members", default="",
                        help="comma-separated party member names (for rally/readiness), "
                             "e.g. 'luna,terra,sol'")
        sp.add_argument("--rally", type=int, default=4,
                        help="tiles: party is 'tight' within this of the leader (default 4)")
        sp.add_argument("--threat", type=int, default=8,
                        help="tiles: aggro monsters this close gate an unassembled party (default 8)")
        sp.add_argument("--threshold", type=float, default=0.6,
                        help="min readiness P(win) in [0,1] to start fighting (default 0.6)")
        sp.add_argument("--focus-radius", type=int, default=6,
                        help="focus-fire monsters within this many tiles of the leader (default 6)")
        sp.add_argument("--hunt", default="rat",
                        help="comma-separated monster types to hunt/focus-fire; "
                             "'*' or '' means anything (default 'rat')")
        sp.add_argument("--cohesion-slack", type=float, default=2.5,
                        help="cohesion falloff: a member scores 0 past "
                             "rally*this (larger = looser clump reads tight; default 2.5)")
        sp.add_argument("--hunt-enter", type=float, default=0.5,
                        help="cohesion needed for the leader to START advancing "
                             "on prey (default 0.5)")
        sp.add_argument("--hunt-exit", type=float, default=0.3,
                        help="cohesion below which the leader ABORTS advancing "
                             "back to regroup (default 0.3; must be < hunt-enter)")
        sp.add_argument("--route", default="",
                        help="leader only: ';'-separated 'x,y' tile waypoints to "
                             "walk (in order) before hunting locally, e.g. "
                             "'90,52;84,58;78,50'. Escorts trail automatically.")

    ld = sub.add_parser("lead",
                        help="lead a party: wait up for a tight escort, then focus-fire")
    add_swarm_args(ld)

    e = sub.add_parser("escort",
                       help="follow a leader and focus-fire once the party is tight")
    e.add_argument("leader", help="name of the player to escort")
    add_swarm_args(e)

    m = sub.add_parser("move", help="walk to 'x,y' tile, a location name, or a player")
    m.add_argument("target")

    s = sub.add_parser("send", help="send one raw JSON message and exit")
    s.add_argument("json")

    args = p.parse_args()
    accounts = load_accounts(args)
    who = args.account or args.character
    acct = pick_account(accounts, who)

    if acct is None:
        # `who` didn't name an account and there are several; try to find the
        # account that actually owns a character named `who`.
        for a in accounts:
            session, chars = ab.login(a["username"], a["password"])
            if any(c.get("name", "").lower() == who.lower() for c in chars):
                acct, cached = a, (session, chars)
                break
        else:
            names = [a["username"] for a in accounts]
            sys.exit(f"no account or character matching {who!r}; accounts: {names}")
        session, chars = cached
    else:
        session, chars = ab.login(acct["username"], acct["password"])

    chosen = pick_character(chars, args.character)
    token = chosen.get("characterToken") or chosen.get("token")
    print(f"connected as {chosen.get('name')} "
          f"(account {acct['username']}) -- {args.cmd}", file=sys.stderr)

    bot = ab.AvalonBot(session, token)
    on_snapshot, on_event = build_intent(args)
    asyncio.run(run(bot, on_snapshot, on_event))


if __name__ == "__main__":
    main()
