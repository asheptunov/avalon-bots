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
import random
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


def occupied_tiles(snap, me):
    """Tiles currently occupied by OTHER players -- the dynamic obstacles A* must
    route around, because the server enforces player-vs-player collision that the
    static map doesn't know about. Excludes `me` (we stand on our own tile). Each
    bot computes this from its own snapshot; no coordination needed."""
    mid = me["id"]
    return frozenset((nav._tile(p["x"]), nav._tile(p["y"]))
                     for p in snap["players"] if p["id"] != mid)


def nav_step(bot, me, tx_px, ty_px):
    """Step toward a pixel target using real A* pathfinding over the extracted
    collision grid (avalon_nav). Routes around walls/buildings AND other players
    (dynamic obstacles), and follows the path tile-by-tile; on a z-level with no
    map it degrades to a greedy step.

    The set of player-occupied tiles is stashed on the bot each tick (see
    set_nav_obstacles); reading it here keeps nav_step's many call sites simple.
    This replaced an earlier blind wall-slide heuristic once we extracted the
    client's collision map -- planning beats fumbling, so bots no longer orbit
    corners, pin in doorways, or stack single-file on each other."""
    blocked = getattr(bot, "_occupied", None)
    return nav.path_step(bot, me, getattr(bot, "z", 0), (tx_px, ty_px),
                         blocked=blocked)


def set_nav_obstacles(bot, snap, me):
    """Record the player-occupied tiles on the bot for this tick so nav_step can
    route around them. Call once at the top of each intent that navigates."""
    bot._occupied = occupied_tiles(snap, me)

def dist_px(ax, ay, bx, by):
    return math.hypot(ax - bx, ay - by)

def _parse_tile(spec):
    """'58,22' -> (58, 22); None -> None."""
    if not spec:
        return None
    try:
        xs, ys = spec.split(",", 1)
        return int(xs), int(ys)
    except ValueError:
        sys.exit(f"bad tile {spec!r}; want 'x,y' (e.g. 58,22)")


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


async def respawn_if_dead(bot, me):
    """If the bot is dead, send a respawn (throttled) and report True so the
    caller skips this tick -- a corpse can't fight or follow, and swarm bots
    WILL die (esp. to underground monsters), so they need to get back up on their
    own. Returns True while dead."""
    if me["hp"] > 0:
        return False
    now = _now()
    if now - getattr(bot, "_respawn_last", 0.0) > 2.0:
        bot._respawn_last = now
        await bot.send({"type": "respawn"})
        print(f"{me['name']}: dead -- respawning", file=sys.stderr)
    return True


# HP-restoring potions, smallest first, with their heal amount (from the
# bundle's `ff={healthPotion:30,largeHealthPotion:60}`). Mana potions don't
# heal HP, so they're excluded.
HEAL_POTIONS = [("healthPotion", 30), ("largeHealthPotion", 60)]
# NPC types / names that offer a heal dialogue option.
HEALER_NAMES = {"brother aldric", "aldric"}
# The server ignores potions drunk faster than this.
POTION_COOLDOWN_S = 0.8


def useful_potion(bot, me):
    """The smallest held potion whose heal wouldn't mostly overheal, as
    (item, amount), or None.

    The `missing >= amt * 0.5` rule is why this is shared rather than inlined:
    it's the policy that stops us burning a 60-point potion on a 5-point graze,
    and both `heal` and `farm` must apply it identically."""
    missing = me["maxHp"] - me["hp"]
    for pid, amt in HEAL_POTIONS:
        it = bot.find_item(pid)
        if it and missing >= amt * 0.5:
            return it, amt
    return None


async def drink_potion(bot, me, prefix=""):
    """Drink a useful potion if one is held and the cooldown has elapsed.

    Returns True if we drank. Shared by `heal` (one-shot) and `farm` (repeating)
    so the overheal rule and the cooldown can't drift apart between them."""
    now = _now()
    if now - getattr(bot, "_heal_last_drink", 0.0) < POTION_COOLDOWN_S:
        return False
    found = useful_potion(bot, me)
    if not found:
        return False
    potion, amt = found
    bot._heal_last_drink = now
    print(f"{prefix}drinking {potion['itemId']} "
          f"(+{amt}, x{bot.count_item(potion['itemId'])} held)")
    await bot.use_item(potion["instanceId"])
    return True


def find_npc(snap, query=None):
    """The first NPC matching `query` (forgivingly, like find_player), or the
    first known healer when no query is given."""
    for n in snap["npcs"]:
        name, kind = n.get("name") or "", n.get("npcType") or ""
        if query:
            if name_matches(query, name) or name_matches(query, kind):
                return n
        elif name.lower() in HEALER_NAMES or kind.lower() in HEALER_NAMES:
            return n
    return None


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

        # 1) Drink potions while one would actually help; once none does, stop
        #    and let regen finish the last sliver rather than spamming useItem.
        if not force_healer:
            if await drink_potion(bot, me, prefix=f"hp {me['hp']}/{me['maxHp']} -- "):
                return
            if useful_potion(bot, me):
                return          # holding one, just waiting out the cooldown
            if getattr(bot, "_heal_last_drink", 0.0):
                held = sum(bot.count_item(pid) for pid, _ in HEAL_POTIONS)
                tail = ("out of health potions" if not held
                        else "close enough (regen will finish)")
                print(f"hp {me['hp']}/{me['maxHp']} -- {tail}")
                bot.done = True
                return

        # 2) Head to a healer NPC and use their dialogue.
        healer = find_npc(snap)
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


def make_heal_on_event(one_shot=True):
    """Dialogue handler for the Aldric heal path: when the dialogue arrives,
    pick the option whose label looks like healing and send it back.

    `one_shot` is the difference between the two callers: `heal` is a one-shot
    command and exits once healed, while `farm` heals many times over a long run
    and must close the dialogue and carry on instead."""
    async def on_event(bot, msg):
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
        if one_shot:
            bot.done = True
            return
        # Leave the NPC cleanly so the next retreat can re-open the dialogue.
        await bot.send({"type": "endDialogue"})
        bot._heal_npc = None
    return on_event


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


# --- combat-state read (snapshot-only, no event plumbing) -------------------
# The server marks a monster `enraged` while it's actively fighting -- it aggroed
# a party member, or a passive mob (a rat) is retaliating against whoever hit it.
# We don't get "who is it hitting", but an enraged monster is (by mechanics) on
# top of its victim, so proximity to a party member tells us WHICH member it's
# on. That's enough to distinguish "someone's in a fight" (join in) from "there's
# an idle rat nearby" (leave it alone) -- with zero coordination channel.

def monster_threatening_party(m, members, threat_px):
    """True if monster `m` is actively fighting a party member: it's enraged AND
    within threat_px of some member. (Enraged = it aggroed or is retaliating; the
    range check pins it to a member it's actually on.)"""
    if not (m["hp"] > 0 and m.get("enraged")):
        return False
    return any(dist_px(m["x"], m["y"], p["x"], p["y"]) <= threat_px
               for p in members.values())


def threats_to_party(snap, members, threat_px):
    """Monsters actively fighting a party member, lowest-HP first. Deliberately
    NOT filtered by hunt_types: defend is self-defense, so the pack swarms
    whatever is attacking a member (an orc that aggroed us) even when we're only
    out HUNTING rats. hunt_types governs what we seek out, not what we fend off."""
    out = [m for m in snap["monsters"]
           if monster_threatening_party(m, members, threat_px)]
    return sorted(out, key=lambda m: m["hp"])       # focus lowest-HP first


# How close an enraged monster must be to the leader to count as "the leader is
# fighting THIS one". Melee-scale (not the party's wide threat radius) so an
# escort's own fight a few tiles away doesn't read as the leader's -- that
# distinction is what keeps the leader in control of the follow-pack.
LEADER_ENGAGE_PX = ab.MELEE_RANGE_PX * 1.5


def leader_engaged_with(target, leader, engage_px=LEADER_ENGAGE_PX):
    """True if the LEADER is committed to fighting `target` -- that monster is
    enraged and in melee reach of the leader. This is the `follow` trigger:
    passive escorts pile onto exactly what the leader is fighting, and stop when
    the leader stops, so the leader keeps control (peeling the party off a threat
    just means the leader disengages). Keying off the leader specifically -- and
    at melee scale, not the party's wide threat radius -- is what preserves that
    control: otherwise an escort's own fight a few tiles off drags the pack in
    and the leader can't call them off."""
    if not target or not leader:
        return False
    return (target["hp"] > 0 and target.get("enraged")
            and dist_px(target["x"], target["y"], leader["x"], leader["y"]) <= engage_px)


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
                 follow_gap_px=None, readiness_smooth=1.0, combat_exit=None):
        self.member_names = member_names        # names that make up the party
        self.rally_px = rally_px                # "tight" = within this of leader
        self.threat_px = threat_px              # aggro monsters this close matter
        self.combat_threshold = combat_threshold
        self.low_hp_frac = low_hp_frac
        # Readiness EMA: each tick the reported readiness is
        #   smooth = alpha*raw + (1-alpha)*prev_smooth
        # alpha=1.0 disables it (report the raw instantaneous value, the old
        # behaviour). Smaller alpha = stickier, so a one-tick straggle or a
        # transient threat can't instantly slam the combat gate shut/open.
        self.readiness_smooth = readiness_smooth
        # Combat-gate hysteresis: START fighting at combat_threshold, keep
        # fighting until smoothed readiness sags below combat_exit (< threshold).
        # The band between the two stops the gate chattering at the boundary.
        # Defaults to combat_threshold (no hysteresis) unless set lower.
        self.combat_exit = combat_exit if combat_exit is not None else combat_threshold
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


def readiness_without_cohesion(snap, cfg, leader_name):
    """Readiness with the cohesion factor removed -- the product of the remaining
    factors (health, threat, ...). Used by the `attack` intent, which is willing
    to engage without a tight pack but must still respect the safety factors (a
    dying member, un-assembled aggro). Stays correct if new factors are appended
    to READINESS_FACTORS -- only factor_cohesion is skipped.

    Note: factor_threat still folds cohesion back in WHEN aggro is near, so attack
    mode ignores clustering only for passive prey (rats); against auto-aggro
    monsters it still won't charge in unassembled. That's the intended safety."""
    members = party_members(snap, cfg, leader_name)
    leader = members.get(leader_name) or find_player(snap, leader_name)
    score = 1.0
    for f in READINESS_FACTORS:
        if f is factor_cohesion:
            continue
        score *= f(members, leader, snap, cfg)
    return score


def smooth_readiness(bot, raw, cfg, slot="_ready_ema"):
    """Exponential moving average of readiness, kept per-bot. With alpha=1.0 it's
    a passthrough (raw value). Otherwise it blends in the previous smoothed score
    so momentary dips/spikes don't jerk the combat gate. Bot-local state means no
    coordination needed -- each process smooths its own view, and since they all
    see nearly the same snapshot their smoothed scores track together.

    `slot` names the per-bot EMA state, so a caller that smooths two different
    series (e.g. full readiness for the log AND a cohesion-excluded gate score)
    keeps them in independent lanes rather than cross-contaminating one EMA."""
    a = cfg.readiness_smooth
    if a >= 1.0:
        return raw
    prev = getattr(bot, slot, None)
    ema = raw if prev is None else a * raw + (1.0 - a) * prev
    setattr(bot, slot, ema)
    return ema


def combat_go(bot, score, cfg):
    """Hysteretic combat gate: return True while the squad should be fighting.
    Enter combat when score >= combat_threshold; stay in combat until score drops
    below combat_exit (<= threshold). The bot latches its fight/hold state so the
    decision doesn't flip every tick at the boundary. `score` should be the
    SMOOTHED readiness."""
    fighting = getattr(bot, "_combat_on", False)
    if fighting:
        fighting = score >= cfg.combat_exit
    else:
        fighting = score >= cfg.combat_threshold
    bot._combat_on = fighting
    return fighting


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


# How close (px) an escort must get to a ladder tile before it can `useTeleport`.
# The client uses ~1.5 tiles; match it (a touch tighter to be safely in range).
TELEPORT_INTERACT_PX = TILE * 1.4


# How near the leader's last-seen tile a teleport must be to conclude "the leader
# took THIS teleport and vanished" (tiles). The leader has to be basically on the
# marker for us to chase it -- otherwise we'd dive down a hole any time they
# merely walked out of view near one.
TELEPORT_TRIGGER_TILES = 2


async def take_teleport(bot, me, tp):
    """Move onto / interact with a teleport marker. Returns True once we've sent
    the `useTeleport` (or stepped onto a hole), False while still walking there.

    The two modes differ in how you trigger them, which is the whole reason this
    is shared: a 'walk' hole transitions you the moment you stand on the tile
    (no message at all), while an 'interact' ladder needs you within ~1.5 tiles
    and then an explicit useTeleport."""
    ftx, fty = tp["fromTile"]
    goal_px = (ftx * TILE, fty * TILE)
    if tp["mode"] == "walk":
        await bot.move(*nav_step(bot, me, *goal_px))
        return False
    if dist_px(me["x"], me["y"], *goal_px) <= TELEPORT_INTERACT_PX:
        await bot.move(0, 0)
        await bot.use_teleport()
        return True
    await bot.move(*nav_step(bot, me, *goal_px))
    return False


async def follow_across_floors(bot, me, snap):
    """Follow a leader who has DESCENDED/ASCENDED and thus VANISHED from our
    snapshot (the server only sends entities on our own floor -- we get no signal
    of their new z). We can't know where they went, so we key off OBSERVABLE
    evidence: the leader was last seen standing on/next to a teleport on OUR
    floor, and is now gone -> they almost certainly took it, so we take it too
    (walk onto a hole; approach a ladder and `useTeleport`). After transitioning,
    our z changes, we re-see the leader, and normal follow resumes.

    Returns True if it issued a move/teleport this tick (caller should return),
    False if there's nothing to chase (leader never seen, or wasn't near a
    teleport when they vanished -- they just walked out of view)."""
    seen = getattr(bot, "_leader_last", None)
    if not seen:
        return False
    ltile = seen["tile"]
    z = getattr(bot, "z", 0)

    # Only chase if the leader vanished while ON/next to a teleport on OUR floor.
    # The nearest teleport to their last-seen tile must be within a tile or two;
    # otherwise they didn't teleport (they walked off-view) and we hold.
    tps = nav.teleports(z)
    if not tps:
        return False
    tp = min(tps, key=lambda t: (t["fromTile"][0] - ltile[0]) ** 2
             + (t["fromTile"][1] - ltile[1]) ** 2)
    ftx, fty = tp["fromTile"]
    if max(abs(ftx - ltile[0]), abs(fty - ltile[1])) > TELEPORT_TRIGGER_TILES:
        return False                    # leader wasn't at a teleport -> don't dive

    await take_teleport(bot, me, tp)
    if getattr(bot, "_xfloor_note", None) != (z, ftx, fty):
        bot._xfloor_note = (z, ftx, fty)
        print(f"escort {me['name']}: leader vanished at ({ltile[0]},{ltile[1]}) "
              f"on a {tp['mode']} -> taking it @({ftx},{fty}) from z{z}",
              file=sys.stderr)
    return True


async def home_to_surface(bot, me):
    """Last-resort recovery for an escort stranded underground with NO leader in
    view and nothing to chase: climb toward the surface one floor at a time via
    the known up-teleports, until it reaches z=0 and can re-acquire the leader.
    This is the 'get everyone back to me' path -- it uses the fully-known teleport
    graph (we DO remember where every ladder goes) to route home.

    Returns True if it acted (caller should return); False on the surface / no way
    up (nothing to do here)."""
    z = getattr(bot, "z", 0)
    if z >= 0:
        return False                    # already on the surface
    up = nav.nearest_upward_teleport(z, (nav._tile(me["x"]), nav._tile(me["y"])))
    if not up:
        return False
    ftx, fty = up["fromTile"]
    await take_teleport(bot, me, up)
    if getattr(bot, "_home_note", None) != (z, ftx, fty):
        bot._home_note = (z, ftx, fty)
        print(f"escort {me['name']}: no leader in sight on z{z} -- homing to "
              f"surface via {up['mode']} @({ftx},{fty})", file=sys.stderr)
    return True


def track_leader(bot, leader):
    """Remember the leader's floor+tile whenever we can see them, so if they
    vanish next to a teleport we know to chase them through it. Clear it once we
    actually re-acquire on a new floor so a stale last-seen can't re-trigger."""
    if leader:
        bot._leader_last = {"z": getattr(bot, "z", 0),
                            "tile": (nav._tile(leader["x"]), nav._tile(leader["y"]))}
        bot._xfloor_note = None         # re-armed: fresh sighting
        bot._home_note = None


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
                    note=None, fighting=None):
    """Throttled live readout so a running swarm is legible in its log: prints
    at most every `period` seconds, and immediately whenever the state changes.
    `note` lets a caller name the current purpose (e.g. 'hunting rat @(78,49)'
    vs 'regrouping') so the log shows intent over time, not just fight/wait.
    `fighting` lets the caller pass the real (hysteretic) gate decision instead
    of re-deriving it from a bare threshold compare."""
    if fighting is None:
        fighting = bool(target and score >= cfg.combat_threshold)
    else:
        fighting = bool(target and fighting)
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


# Escort INTENT -- WHETHER/WHEN an escort engages (all share the readiness gate):
#   follow  -- passive: only joins a fight the party has ALREADY started (a
#              monster enraged on a member). Never initiates. The default.
#   attack  -- aggressive: hunts huntable monsters near the anchor unprompted,
#              even when the pack isn't clustered (cohesion-relaxed gate).
#   defend  -- reactive: peels only to a monster attacking a party member; never
#              touches idle mobs. Swarms an orc that aggros; helps a member a
#              retaliating rat is hitting.
INTENTS = ("follow", "attack", "defend")

# Escort FORMATION -- HOW an escort holds station (orthogonal to intent):
#   none       -- trail the leader (default column-follow).
#   magnetize  -- boids-like self-spacing: attraction to the leader + short-range
#                  repulsion from neighbours, so escorts spread out evenly yet
#                  stay clustered. Composes with any intent.
FORMATIONS = ("none", "magnetize")


def magnetize_step(bot, me, leader, members, snap, cfg):
    """Boids-style station-keeping: escorts settle into a ring of roughly-even
    spacing around the leader. Split into a FAR and a NEAR regime so obstacles
    never trap the bot:

      * FAR (outside the ring): path to the LEADER via A*. The leader is always a
        reachable goal, so A* routes around trees/buildings to close the distance
        -- no blind force-projection that can aim the goal into a wall (which
        made a bot 'arrive' against a trunk and freeze). We just stop once we
        reach the ring.
      * NEAR (on/inside the ring): apply the local force balance -- a symmetric
        ring spring (push out if too close) plus neighbour separation plus threat
        avoidance -- to fine-tune position and spread the ring out evenly. Here
        the goal is only a step away, which is fine: there's no wall to route
        around at conversational range, and the even-spacing equilibrium emerges
        from the separation term.

    Pure local rule over the snapshot; no coordination channel. Falls back to a
    plain leader-follow if the leader isn't visible."""
    if not leader:
        return follow_leader_step(bot, me, leader, snap, cfg)

    ring = max(TILE, cfg.follow_gap_px)
    personal = max(TILE, ring)                      # neighbour personal space
    dlx, dly = me["x"] - leader["x"], me["y"] - leader["y"]
    d_lead = math.hypot(dlx, dly) or 1e-6

    # FAR: too far outside the ring -> let A* walk us to the leader (routes around
    # obstacles). A little hysteresis (1.25*ring) so we don't flip regimes right
    # at the boundary.
    if d_lead > ring * 1.25:
        return nav_step(bot, me, leader["x"], leader["y"])

    # NEAR: local force balance for fine positioning + even spacing.
    fx = fy = 0.0
    # Symmetric ring spring: signed by (d_lead - ring). Outside -> inward,
    # inside -> outward, zero on the ring.
    err = d_lead - ring
    ux, uy = dlx / d_lead, dly / d_lead             # leader -> me
    fx += -ux * err
    fy += -uy * err
    # Separation: push off neighbours inside personal space, weighted by overlap.
    for p in members.values():
        if p["id"] == me["id"] or p["id"] == leader["id"]:
            continue
        px, py = me["x"] - p["x"], me["y"] - p["y"]
        d = math.hypot(px, py)
        if 0 < d < personal:
            w = (personal - d) / personal
            fx += (px / d) * personal * w
            fy += (py / d) * personal * w
    # Threat avoidance: shove away from the nearest aggro monster in range.
    threats = [m for m in snap["monsters"]
               if m["hp"] > 0 and m["monsterType"] in AGGRO_MONSTERS
               and dist_px(m["x"], m["y"], me["x"], me["y"]) <= cfg.threat_px]
    if threats:
        thr = min(threats, key=lambda m: dist_px(m["x"], m["y"], me["x"], me["y"]))
        fx += (me["x"] - thr["x"])
        fy += (me["y"] - thr["y"])

    # Deadband: once the net force is tiny we're on station.
    mag = math.hypot(fx, fy)
    if mag < TILE * 0.33:
        return 0, 0
    # Near range: aim a couple tiles along the force (stable, quantized) so A*
    # still nudges around any small obstacle without pinning.
    reach = min(mag, 2 * TILE)
    gx = round((me["x"] + fx / mag * reach) / TILE) * TILE
    gy = round((me["y"] + fy / mag * reach) / TILE) * TILE
    return nav_step(bot, me, gx, gy)


def swarm_target(intent_mode, snap, leader, anchor, members, focus_radius_px, cfg):
    """What THIS escort should fight this tick, given its intent. Returns a
    monster dict or None -- None means 'don't engage, hold formation'.

      attack  -- hunt: the focus monster near the anchor (aggressive, unprompted).
      follow  -- passive: the focus monster ONLY if the LEADER is fighting it, so
                 the leader keeps control (escorts join the leader's fight and
                 quit when the leader does; the leader can peel them off a threat
                 just by disengaging). Never triggers off a mere party member.
      defend  -- reactive: the monster currently attacking ANY party member
                 (nearest-victim threat), never an idle mob. Never hunts."""
    if intent_mode == "attack":
        return pick_focus_monster(snap, anchor, focus_radius_px, cfg.hunt_types)
    if intent_mode == "follow":
        # Fight exactly what the LEADER is fighting: the enraged monster on the
        # leader (not a nearby focus pick, which could be a different mob). Lowest
        # HP first so multiple followers converge on the same one -> focus fire.
        # NOT filtered by hunt_types -- if the leader picked this fight (even an
        # orc), the pack backs the leader up regardless of the hunt filter.
        on_leader = [m for m in snap["monsters"] if leader_engaged_with(m, leader)]
        return min(on_leader, key=lambda m: m["hp"]) if on_leader else None
    if intent_mode == "defend":
        threatened = threats_to_party(snap, members, cfg.threat_px)
        return threatened[0] if threatened else None
    # unknown -> behave like attack
    return pick_focus_monster(snap, anchor, focus_radius_px, cfg.hunt_types)


def make_swarm(leader_name, cfg, focus_radius_px, is_leader,
               intent_mode="follow", formation="none"):
    """One brain for both roles. Every tick:

      1. Compute party readiness (the shared P(win) score) from our snapshot.
      2. Decide a target from the INTENT (attack hunts, follow only joins a fight
         the party started, defend only peels to a threatened member).
      3. If there's a target AND the readiness gate is open -> focus-fire it.
      4. Otherwise hold station in the chosen FORMATION (magnetize self-spaces;
         otherwise trail the leader). The leader waits up here too, so the pack
         never desyncs into a cross-map stroll.

    `intent_mode` shapes engagement; `formation` is ORTHOGONAL and shapes
    station-keeping -- any intent composes with any formation. Both still share
    the readiness model, so the hive stays coherent.

    is_leader only changes idle/fallback wandering, not the combat gate."""
    async def intent(bot, snap):
        me = me_of(bot, snap)
        if not me:
            return
        if await respawn_if_dead(bot, me):
            return
        set_nav_obstacles(bot, snap, me)

        raw, members, leader = party_readiness(snap, cfg, leader_name)
        score = smooth_readiness(bot, raw, cfg)
        track_leader(bot, leader)          # remember floor+tile while visible

        # One-time visibility hint for a name mismatch / offline member.
        if not getattr(bot, "_swarm_greeted", False):
            bot._swarm_greeted = True
            role = "leading" if is_leader else f"escorting {leader_name!r}"
            form = f"/{formation}" if formation != "none" else ""
            print(f"{role} [{intent_mode}{form}]; party={sorted(members)} "
                  f"readiness={score:.2f}", file=sys.stderr)

        anchor = leader or me
        target = swarm_target(intent_mode, snap, leader, anchor, members,
                              focus_radius_px, cfg)
        # `attack` presses the offensive: it doesn't wait for a tight pack, so it
        # gates on readiness EXCLUDING cohesion (health/threat still apply, so it
        # won't charge in with a dying member or into un-assembled aggro).
        # follow/defend gate on the full readiness (they only fight reactively
        # anyway, so cohesion gating them is harmless and keeps the pack tight).
        if intent_mode == "attack":
            gate_raw = readiness_without_cohesion(snap, cfg, leader_name)
            gate_score = smooth_readiness(bot, gate_raw, cfg, slot="_gate_ema")
        else:
            gate_score = score
        go = combat_go(bot, gate_score, cfg)
        label = f"{intent_mode}/{formation}" if formation != "none" else intent_mode
        swarm_heartbeat(bot, f"escort {me['name']} [{label}]", members,
                        score, cfg, target, me, fighting=go)

        # Engage only when the intent picked a target AND the gate is open.
        if target and go:
            if dist_px(me["x"], me["y"], target["x"], target["y"]) < ab.MELEE_RANGE_PX:
                await bot.move(0, 0)
                await bot.attack(target["id"])
            else:
                await bot.move(*nav_step(bot, me, target["x"], target["y"]))
            return

        # Not fighting: hold station per FORMATION. magnetize self-spaces around
        # the leader; otherwise trail the leader directly (so the column tracks a
        # moving leader).
        if leader and formation == "magnetize":
            await bot.move(*magnetize_step(bot, me, leader, members, snap, cfg))
        elif leader:
            await bot.move(*follow_leader_step(bot, me, leader, snap, cfg))
        elif await follow_across_floors(bot, me, snap):
            return                          # leader vanished at a teleport -> chase
        elif await home_to_surface(bot, me):
            return                          # stranded underground -> climb home
        elif len(members) > 1:
            await bot.move(*rally_step(me, members, snap, cfg, leader))
        else:
            # Truly alone (nobody else visible): hold rather than wander off.
            await bot.move(0, 0)
    return intent


def make_swarm_leader(cfg, focus_radius_px):
    """The leader's brain: identical readiness gate to the escorts, but it
    anchors the party on ITSELF (found via bot.me) rather than following anyone.
    So the leader waits up for a tight escort before initiating, using the very
    same P(win) score every escort computes -- keeping the pack in sync.

    Navigation is real A* (nav_step) over the extracted collision grid, so the
    leader plans around walls on its own -- no hand-fed waypoint route needed to
    escape the starter house."""
    async def intent(bot, snap):
        me = me_of(bot, snap)
        if not me:
            return
        if await respawn_if_dead(bot, me):
            return
        set_nav_obstacles(bot, snap, me)
        # Anchor readiness on our own name so cohesion measures the escorts'
        # distance to us.
        raw, members, _ = party_readiness(snap, cfg, me["name"].lower())
        score = smooth_readiness(bot, raw, cfg)
        leader = me  # the leader IS the anchor

        if not getattr(bot, "_swarm_greeted", False):
            bot._swarm_greeted = True
            print(f"leading; party={sorted(members)} readiness={score:.2f}",
                  file=sys.stderr)

        target = pick_focus_monster(snap, leader, focus_radius_px, cfg.hunt_types)
        go = combat_go(bot, score, cfg)
        if target and go:
            swarm_heartbeat(bot, "lead", members, score, cfg, target, me, fighting=go)
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
        set_nav_obstacles(bot, snap, me)
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


# --------------------------------------------------------------------------
# farming: an indefinite kill -> loot -> stay-alive loop
# --------------------------------------------------------------------------

# Food, best-first. `Xg` in the bundle gives how long each keeps you `wellFed`
# (ms); we eat the WORST food that still does the job so the good stuff is kept
# for when it matters. cookedMeat (480s) is worth more than double rawMeat
# (180s), which is why we cook before eating.
FOOD_ITEMS = [
    ("cookedMeat", 480), ("fish", 1200), ("cheese", 240),
    ("apple", 120), ("avocado", 120), ("iceCream", 120), ("rawMeat", 180),
]
# Raw food that becomes something better when you interact with it near a fire.
COOKABLE = {"rawMeat"}

# How close we must be to a ground item before `moveItem` will pick it up.
LOOT_REACH_PX = TILE * 1.2
# Give up on a single item after this long (it may be unreachable or owned).
LOOT_TIMEOUT_S = 6.0


# Ground containers that hold loot rather than being loot: a killed monster
# leaves a `corpse` (and a dead player a `playerBody`) whose `contents` are the
# actual drops. They weigh 0, equip nowhere, and taking the container itself
# does nothing -- you must take the items OUT of it.
LOOT_CONTAINERS = {"corpse", "playerBody"}


def loot_candidates(bot, snap):
    """Every takeable thing on the floor, as (ground_entry, item_to_take).

    Two shapes exist and this is the whole reason looting looked broken: a loose
    drop is taken directly, but a monster's drops sit INSIDE a `corpse` ground
    container, so we yield its contents instead of the corpse itself.

    The server reserves fresh drops for whoever earned them (`ownerId` +
    `ownerExpiresAt`); taking someone else's is refused, so we skip those rather
    than burn ticks on a rejected pickup. Items we already failed to reach are
    skipped too, so one stuck drop can't stall the farm forever."""
    skip = getattr(bot, "_farm_loot_skip", frozenset())
    for g in (snap.get("groundItems") or []):
        if g.get("ownerId") and g["ownerId"] != bot.me:
            continue
        it = g["item"]
        if it.get("itemId") in LOOT_CONTAINERS or it.get("contents"):
            for inner in (it.get("contents") or []):
                if inner and inner["instanceId"] not in skip:
                    yield g, inner
        elif it["instanceId"] not in skip:
            yield g, it


def nearest_loot(bot, snap, me):
    """The nearest (ground_entry, item) we're allowed to take, or None."""
    cands = list(loot_candidates(bot, snap))
    if not cands:
        return None
    return min(cands, key=lambda c: dist_px(c[0]["x"], c[0]["y"],
                                            me["x"], me["y"]))


def near_loot(bot, snap, me, within_px):
    """True if there's takeable loot within `within_px` -- i.e. worth grabbing
    now rather than chasing the next monster past it."""
    found = nearest_loot(bot, snap, me)
    return bool(found) and dist_px(found[0]["x"], found[0]["y"],
                                   me["x"], me["y"]) <= within_px


def pick_food(bot, emergency=False):
    """Choose what to eat, returning the held item (or None).

    Normally: the SHORTEST-lasting food we hold, so the good stuff is saved for
    when it matters (any food restores regen equally -- only the duration of the
    wellFed window differs, so a 2-minute apple does the same job right now as a
    20-minute sushi).

    In an emergency (hurt and starving): the LONGEST-lasting food, so we don't
    have to break off mid-retreat to eat again while something is hitting us.

    One pass over the inventory, not one per food type: `iter_items` walks every
    equipment slot and container recursively, and this runs on a 10 Hz loop."""
    wanted = dict(FOOD_ITEMS)
    held = {}
    for it in bot.iter_items():
        secs = wanted.get(it.get("itemId"))
        if secs is not None:
            held.setdefault(it["itemId"], (secs, it))
    if not held:
        return None
    best = max if emergency else min
    return best(held.values(), key=lambda p: p[0])[1]


class FarmConfig:
    """Thresholds for the farm loop. All fractions are of maxHp."""

    def __init__(self, loot=True, eat=True, cook=True, stack=True,
                 hunt_types=None, retreat_frac=0.35, resume_frac=0.85,
                 heal_to_frac=0.95, healer_name=None, roam_px=TILE * 12,
                 until_hp_frac=None, depth=0, entry_tile=None,
                 loot_px=TILE * 8):
        self.loot = loot
        self.eat = eat
        self.cook = cook
        self.stack = stack
        self.hunt_types = hunt_types
        self.retreat_frac = retreat_frac
        self.resume_frac = resume_frac
        self.heal_to_frac = heal_to_frac
        self.healer_name = healer_name
        self.roam_px = roam_px
        self.until_hp_frac = until_hp_frac
        # Loot this close is collected before chasing the next monster; farther
        # drops wait until nothing is worth fighting.
        self.loot_px = loot_px
        # Target floor (0 = surface). Negative means go underground, which
        # changes the danger model: monsters aggro on sight and there's no
        # healer down there, so `retreat_frac` becomes an escape trigger.
        self.depth = depth
        # Which surface hole to descend by, as a (tx,ty) tile; None = nearest.
        self.entry_tile = entry_tile


async def farm_cook_and_stack(bot, cfg):
    """Housekeeping between fights: cook raw meat, then consolidate stacks.

    Returns True if we sent something (so the caller yields this tick -- the
    server applies one inventory action at a time and we want to see the result
    in the next snapshot before deciding again)."""
    now = _now()
    if now - getattr(bot, "_farm_last_inv", 0.0) < 0.6:
        return False

    if cfg.cook:
        for raw in COOKABLE:
            it = bot.find_item(raw)
            if it:
                bot._farm_last_inv = now
                print(f"  cooking {raw} x{it.get('quantity', 1)}")
                await bot.use_item(it["instanceId"])
                return True

    if cfg.stack:
        merge = find_merge(bot)
        if merge:
            src, dst = merge
            bot._farm_last_inv = now
            print(f"  stacking {src['itemId']} "
                  f"x{src.get('quantity', 1)} onto x{dst.get('quantity', 1)}")
            await bot.move_item(src["instanceId"],
                                {"kind": "container",
                                 "containerInstanceId": dst["_container"],
                                 "slotIndex": dst["_slot"]})
            return True
    return False


def find_merge(bot):
    """Find two stacks of the same item that should be one, as
    (source, dest-with-location). Merging frees slots, which is the whole point:
    a backpack fills with split stacks long before it fills with distinct items.

    Only stackables qualify -- an item the server gave a quantity > 1 anywhere,
    or a known-stackable id. Equipment never stacks, so a second sword is not a
    merge candidate."""
    pack = bot.backpack()
    if not pack:
        return None
    contents = pack.get("contents") or []
    # Group the backpack's top-level slots by itemId, keeping slot indices so we
    # can address the destination precisely.
    by_id = {}
    for slot, it in enumerate(contents):
        if not it or it.get("contents") is not None:
            continue   # empty slot, or a nested container (never merge those)
        by_id.setdefault(it["itemId"], []).append((slot, it))

    for item_id, group in by_id.items():
        if len(group) < 2:
            continue
        if not _stackable(item_id, group):
            continue
        # Pour the smallest stack into the largest: fewest moves to empty a slot.
        group.sort(key=lambda p: p[1].get("quantity", 1))
        src_slot, src = group[0]
        dst_slot, dst = group[-1]
        if src_slot == dst_slot:
            continue
        dst = dict(dst, _container=pack["instanceId"], _slot=dst_slot)
        return src, dst
    return None


# Items the server keeps as counted stacks. Anything we've actually observed
# with quantity > 1 is stackable by definition; this list seeds the ones we
# expect to loot before we've seen a multi-stack of them.
STACKABLE_IDS = {
    "gold", "rawMeat", "cookedMeat", "cheese", "apple", "fish", "avocado",
    "healthPotion", "largeHealthPotion", "manaPotion", "largeManaPotion",
    "emberOre", "iceCream",
}


def _stackable(item_id, group):
    if item_id in STACKABLE_IDS:
        return True
    # Learned at runtime: the server itself is holding >1 in a slot.
    return any(it.get("quantity", 1) > 1 for _, it in group)


async def farm_loot_step(bot, snap, me):
    """Walk to the nearest lootable drop and take it. Returns True if we're busy
    looting (caller should not also try to fight this tick)."""
    found = nearest_loot(bot, snap, me)
    if not found:
        bot._farm_chase = None
        return False
    where, it = found

    free, cap = bot.pack_space()
    if cap and free == 0:
        # Full: say so once, keep fighting, stop trying to loot.
        if not getattr(bot, "_farm_warned_full", False):
            bot._farm_warned_full = True
            print(f"!! BACKPACK FULL ({cap}/{cap} slots) -- leaving loot on the "
                  "ground and carrying on. Sell/stash to make room.")
        return False
    bot._farm_warned_full = False

    # Track how long we've chased this one so an unreachable drop can't stall
    # the loop forever. Keyed on the ITEM, since several items can share one
    # corpse and we take them out one at a time.
    chased, since = getattr(bot, "_farm_chase", None) or (None, 0.0)
    if chased != it["instanceId"]:
        bot._farm_chase = (it["instanceId"], _now())
    elif _now() - since > LOOT_TIMEOUT_S:
        # Ban it, but keep the ban list bounded to items still on the floor --
        # otherwise a multi-hour run accumulates thousands of despawned ids and
        # tests every one of them, every tick.
        on_floor = {i["instanceId"] for _, i in loot_candidates(bot, snap)}
        skip = getattr(bot, "_farm_loot_skip", set()) & on_floor
        skip.add(it["instanceId"])
        bot._farm_loot_skip = skip
        bot._farm_chase = None
        print(f"  giving up on {it['itemId']} (unreachable)")
        return False

    if dist_px(me["x"], me["y"], where["x"], where["y"]) > LOOT_REACH_PX:
        await bot.move(*nav_step(bot, me, where["x"], where["y"]))
        return True

    await bot.move(0, 0)
    now = _now()
    if now - getattr(bot, "_farm_last_pickup", 0.0) >= 0.4:
        bot._farm_last_pickup = now
        src = " (corpse)" if where["item"].get("itemId") in LOOT_CONTAINERS else ""
        print(f"  looting {it['itemId']} x{it.get('quantity', 1)}{src}")
        await bot.take_item(it)
    return True


async def farm_eat_step(bot, me, cfg):
    """Eat if we're not `wellFed`. This is not a nicety: the server only
    regenerates HP while the wellFed status is up, so an unfed bot never heals
    between fights and bleeds down to a death spiral.

    Returns True if we ate (or tried to) this tick."""
    if not cfg.eat or bot.has_status("wellFed"):
        return False
    now = _now()
    if now - getattr(bot, "_farm_last_eat", 0.0) < 1.5:
        return False
    hurt = me["hp"] < me["maxHp"] * cfg.resume_frac
    food = pick_food(bot, emergency=hurt)
    if not food:
        if not getattr(bot, "_farm_warned_food", False):
            bot._farm_warned_food = True
            print("!! OUT OF FOOD -- not wellFed, so HP will NOT regenerate. "
                  "Farming continues but retreats will take a while.")
        return False
    bot._farm_warned_food = False
    bot._farm_last_eat = now
    print(f"  eating {food['itemId']} (x{bot.count_item(food['itemId'])} held)"
          " -- restoring regen")
    await bot.use_item(food["instanceId"])
    return True


async def farm_descend_step(bot, me, cfg):
    """Walk to the next hole down and take it, until we're on `cfg.depth`.

    Routes one floor at a time through the known teleport graph rather than
    trying to plan the whole descent: each floor's down-hole is reachable from
    where the previous one drops you, and taking them in order is what a player
    does. Returns True while still travelling (caller should return)."""
    z = getattr(bot, "z", 0)
    if z <= cfg.depth:
        return False
    tile = (nav._tile(me["x"]), nav._tile(me["y"]))
    # Prefer the specific hole the user named while we're still on the surface.
    tp = None
    if z == 0 and cfg.entry_tile:
        tp = next((t for t in nav.teleports(0)
                   if tuple(t["fromTile"]) == cfg.entry_tile), None)
    if tp is None:
        tp = nav.nearest_teleport(z, z - 1, tile)
    if tp is None:
        if not getattr(bot, "_farm_no_way_down", False):
            bot._farm_no_way_down = True
            print(f"!! no way down from z{z} -- farming here instead")
        return False
    farm_log(bot, "DESCEND",
             lambda: f"z{z} -> z{z-1} via {tp['mode']} @{tuple(tp['fromTile'])}")
    await take_teleport(bot, me, tp)
    return True


def can_disengage(me, snap, engaged_px=TILE * 3):
    """True if backing off would actually get us out of trouble.

    Running from something already swinging at you is strictly worse than
    killing it: you eat free hits, deal none, and regen is suppressed in combat
    anyway. So we only retreat when nothing is currently on top of us -- if a
    monster IS in our face, finishing it is the safer play, and the flee
    threshold applies only to *starting* new fights.

    This is what killed Sam on the first live run: at 23% HP he walked away from
    a rat that hits for 1, taking a free hit every tick for 20 tiles until he
    died with a bag full of unused apples."""
    return not any(m["hp"] > 0
                   and dist_px(m["x"], m["y"], me["x"], me["y"]) <= engaged_px
                   for m in snap["monsters"])


async def farm_escape_step(bot, me):
    """Flee UP one floor: the way out is an 'interact' ladder, and on every
    underground floor the up-ladder sits on the same tile as the hole we came
    down -- so the exit is always exactly where we landed.

    Returns True while still escaping (caller should return)."""
    z = getattr(bot, "z", 0)
    if z >= 0:
        return False
    tile = (nav._tile(me["x"]), nav._tile(me["y"]))
    up = nav.nearest_upward_teleport(z, tile)
    if not up:
        return False
    farm_log(bot, "ESCAPE",
             lambda: f"hurt on z{z} -- climbing to z{up['toZ']} "
                     f"@{tuple(up['fromTile'])}")
    await take_teleport(bot, me, up)
    return True


def retreat_step(bot, me, snap, cfg):
    """Back away toward safety. If we know a healer, retreat TO them (they're a
    safe spot and the heal is there); otherwise just put distance between us and
    the nearest monster."""
    if cfg.healer_name:
        healer = find_npc(snap, cfg.healer_name)
        if healer:
            if dist_px(me["x"], me["y"], healer["x"], healer["y"]) > TILE * 1.5:
                return nav_step(bot, me, healer["x"], healer["y"]), healer
            return (0, 0), healer
    monsters = [m for m in snap["monsters"] if m["hp"] > 0]
    if not monsters:
        return (0, 0), None
    near = min(monsters, key=lambda m: dist_px(m["x"], m["y"], me["x"], me["y"]))
    dx, dy = step_toward(me, near["x"], near["y"])
    return (-dx, -dy), None


def make_farm(cfg):
    """Farm indefinitely: kill -> loot -> cook/stack -> eat -> stay alive.

    A small state machine with hysteresis, so it can run unattended for hours:

      FIGHT    kill the nearest huntable monster
      LOOT     nothing hostile in reach -> sweep up the drops
      KEEP     no monsters, no loot -> cook raw meat, merge stacks, eat
      RETREAT  HP below retreat_frac -> disengage toward the healer
      HEAL     at the healer -> potion/dialogue back up to heal_to_frac

    The RETREAT/FIGHT split is hysteretic (retreat_frac vs resume_frac) so a bot
    hovering at the threshold doesn't oscillate between fleeing and swinging.
    Eating is what makes 'indefinitely' possible at all: HP only regenerates
    while wellFed."""
    async def intent(bot, snap):
        me = me_of(bot, snap)
        if not me:
            return
        set_nav_obstacles(bot, snap, me)

        if await respawn_if_dead(bot, me):
            return

        frac = me["hp"] / max(1, me["maxHp"])

        # Optional hard stop (kept from the old farm: grind to X% and exit).
        if cfg.until_hp_frac is not None and frac <= cfg.until_hp_frac:
            await bot.move(0, 0)
            print(f"reached {me['hp']}/{me['maxHp']} "
                  f"({frac*100:.0f}% <= {cfg.until_hp_frac*100:.0f}%) -- stopping")
            bot.done = True
            return

        # --- upkeep: eat FIRST, in every state --------------------------
        # Eating is not an idle-time luxury: `wellFed` is the only thing that
        # makes HP regenerate, so it has to happen while fighting too. (This
        # sat in the idle branch and never ran -- on a field that always has a
        # rat in view the fight branch returned first, so he starved and then
        # bled out with a full bag of apples.) It's throttled and costs one
        # message, so running it every tick is cheap.
        await farm_eat_step(bot, me, cfg)
        # Same reasoning for cooking and stacking: they're pure inventory moves
        # that don't need us to stand still, and merging stacks is what keeps
        # the pack from filling with slivers. Both are throttled internally.
        await farm_cook_and_stack(bot, cfg)

        # --- retreat / resume hysteresis --------------------------------
        if frac <= cfg.retreat_frac:
            bot.fleeing = True
        elif frac >= cfg.resume_frac:
            bot.fleeing = False

        if bot.fleeing:
            # Underground the ladder is a real exit -- taking it ends the fight
            # outright -- so it beats the can_disengage rule below: climb out
            # even with a bat on us, rather than trading blows on a floor with
            # no healer and more spawns inbound.
            if await farm_escape_step(bot, me):
                return

        # On the surface, fleeing only helps if we can actually break away; with
        # something in our face, killing it is safer than feeding it free hits
        # (see can_disengage). So a cornered bot drops through to the fight
        # branch instead of being chased down.
        if bot.fleeing and can_disengage(me, snap):
            (dx, dy), healer = retreat_step(bot, me, snap, cfg)
            at_healer = bool(healer) and (dx, dy) == (0, 0)
            farm_log(bot, "RETREAT",
                     lambda: f"hp={me['hp']}/{me['maxHp']} ({frac*100:.0f}%)"
                             + (" at healer" if at_healer else ""))
            await bot.move(dx, dy)
            if at_healer:
                await farm_heal_at(bot, me, healer, cfg)
            return

        # --- travel to the target floor ---------------------------------
        # Only when healthy: full HP is the price of admission for going down,
        # so we never descend on the way out of a fight we just barely survived.
        if cfg.depth < 0 and await farm_descend_step(bot, me, cfg):
            return

        # --- grab loot at our feet before moving on ----------------------
        # Loot used to sit behind the fight branch, so on a field that always
        # has another rat in view he never stopped to collect and left every
        # corpse behind. Drops close enough to take now win over a monster we'd
        # have to walk to; a monster already in melee still comes first.
        m = nearest_huntable(snap, me, cfg.hunt_types)
        engaged = m and dist_px(m["x"], m["y"], me["x"], me["y"]) < ab.MELEE_RANGE_PX
        if cfg.loot and not engaged and near_loot(bot, snap, me, cfg.loot_px):
            if await farm_loot_step(bot, snap, me):
                farm_log(bot, "LOOT")
                return

        # --- fight ------------------------------------------------------
        if m:
            d = dist_px(m["x"], m["y"], me["x"], me["y"])
            if d < ab.MELEE_RANGE_PX:
                await bot.move(0, 0)
                await bot.attack(m["id"])
                # FIGHT and CHASE are one state for logging: closing the last
                # few px flips between them several times a second, which would
                # defeat the print-on-change throttle.
                farm_log(bot, "FIGHT", lambda: f"{m['monsterType']} "
                                               f"{m['hp']}/{m['maxHp']} hp={me['hp']}")
            else:
                await bot.move(*nav_step(bot, me, m["x"], m["y"]))
                farm_log(bot, "FIGHT",
                         lambda: f"chasing {m['monsterType']} {d/TILE:.1f} tiles")
            return

        # --- nothing to fight: sweep up the rest of the loot -------------
        if cfg.loot and await farm_loot_step(bot, snap, me):
            farm_log(bot, "LOOT")
            return

        # Idle: no prey in sight. Roam so we find the next spawn instead of
        # standing on an empty field forever.
        await farm_roam_step(bot, me, cfg)
    return intent


async def farm_heal_at(bot, me, healer, cfg):
    """At the healer while retreating: drink if a potion helps, else ask for the
    heal dialogue. Both mechanisms are shared with the `heal` command."""
    if me["hp"] >= me["maxHp"] * cfg.heal_to_frac:
        return
    if await drink_potion(bot, me, prefix="  "):
        return
    now = _now()
    if now - getattr(bot, "_farm_last_talk", 0.0) >= 3.0:
        bot._farm_last_talk = now
        bot._heal_npc = healer["id"]
        print(f"  asking {healer.get('name')} for a heal "
              f"({me['hp']}/{me['maxHp']})")
        await bot.talk_to(healer["id"])


async def farm_roam_step(bot, me, cfg):
    """No prey visible: drift to a new spot so spawns come back into view.

    Picks a wander target, walks it, and re-picks on arrival or timeout. Without
    this the bot parks on a cleared field and farms nothing."""
    now = _now()
    goal = getattr(bot, "_farm_roam_goal", None)
    if (goal is None
            or now - getattr(bot, "_farm_roam_since", 0.0) > 20.0
            or dist_px(me["x"], me["y"], goal[0], goal[1]) <= TILE * 1.5):
        ang = random.uniform(0, 2 * math.pi)
        r = random.uniform(cfg.roam_px * 0.4, cfg.roam_px)
        goal = (me["x"] + math.cos(ang) * r, me["y"] + math.sin(ang) * r)
        bot._farm_roam_goal = goal
        bot._farm_roam_since = now
    farm_log(bot, "ROAM", lambda: "(no prey in sight)")
    await bot.move(*nav_step(bot, me, goal[0], goal[1]))


def farm_log(bot, state, detail=None, period=5.0):
    """Heartbeat: farming runs for hours, so print on a timer rather than at
    10 Hz. Always prints when `state` changes.

    `detail` is a callable, not a string: it's only rendered when we actually
    print, so the ~98% of ticks that are throttled cost no formatting at all."""
    now = _now()
    changed = state != getattr(bot, "_farm_state", None)
    if not (changed or now - getattr(bot, "_farm_last_log", 0.0) >= period):
        return
    bot._farm_state = state
    bot._farm_last_log = now
    free, cap = bot.pack_space()
    pack = f"  pack {cap-free}/{cap}" if cap else ""
    fed = "" if bot.has_status("wellFed") else "  HUNGRY"
    text = f"{state} {detail()}" if detail else state
    print(f"[farm] {text}{pack}  gold={bot.count_item('gold')}{fed}")


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
        return make_heal(force_healer=args.healer), make_heal_on_event()
    if args.cmd == "farm":
        hunt = {h.strip() for h in args.hunt.split(",") if h.strip()}
        cfg = FarmConfig(
            loot=not args.no_loot,
            eat=not args.no_eat,
            cook=not args.no_cook,
            stack=not args.no_stack,
            hunt_types=None if (not hunt or "*" in hunt) else hunt,
            retreat_frac=args.retreat_hp / 100.0,
            resume_frac=args.resume_hp / 100.0,
            heal_to_frac=args.heal_to / 100.0,
            healer_name=args.healer,
            roam_px=args.roam * TILE,
            until_hp_frac=(args.until_hp / 100.0
                           if args.until_hp is not None else None),
            depth=args.depth,
            entry_tile=_parse_tile(args.entry),
        )
        # Reuse `heal`'s option picker, in repeating mode: farming heals many
        # times over a long run, so a heal must not end the job.
        return make_farm(cfg), make_heal_on_event(one_shot=False)
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
        # Default hysteresis: keep fighting until 0.15 below the enter threshold,
        # clamped to [0, threshold]. Explicit --combat-exit overrides.
        combat_exit = (args.combat_exit if args.combat_exit is not None
                       else max(0.0, args.threshold - 0.15))
        cfg = PartyConfig(
            member_names=[m.lower() for m in members],
            rally_px=args.rally * TILE,
            threat_px=args.threat * TILE,
            combat_threshold=args.threshold,
            hunt_types=hunt_types,
            cohesion_slack=args.cohesion_slack,
            hunt_enter=args.hunt_enter,
            hunt_exit=args.hunt_exit,
            readiness_smooth=args.readiness_smooth,
            combat_exit=combat_exit,
        )
        # A leader has no "leader_name" to follow, so it anchors on itself: use
        # its own display name once known. We pass "" and make_swarm falls back
        # to `me` as the anchor when leader can't be resolved.
        if is_leader:
            # The leader is itself part of the party for cohesion scoring.
            return make_swarm_leader(cfg, args.focus_radius * TILE), None
        return make_swarm(leader_name, cfg, args.focus_radius * TILE,
                          is_leader=False,
                          intent_mode=getattr(args, "intent", "follow"),
                          formation=getattr(args, "formation", "none")), None
    if args.cmd == "move":
        return make_move(args.target), None
    if args.cmd == "send":
        return make_send(args.json), None
    sys.exit(f"unknown command {args.cmd}")


# --------------------------------------------------------------------------
# swarm launcher -- one command that spawns the whole hive
# --------------------------------------------------------------------------

def _resolve_display_name(accounts, account_user, character=None):
    """Log into `account_user` once and return the display name of the chosen
    character. Used so escorts get the exact in-world name to follow."""
    acct = pick_account(accounts, account_user)
    if acct is None:
        sys.exit(f"swarm: no account named {account_user!r} in creds")
    session, chars = ab.login(acct["username"], acct["password"])
    return pick_character(chars, character).get("name")


def run_swarm(args, accounts):
    """Orchestrate the whole hive from one command: spawn one child `avalon.py`
    process per bot (each its own account -- the server allows one character per
    ACCOUNT in-world). Two modes:

      * bot leader  (--leader ACCT): spawn ACCT as `lead`, plus every --escort as
        `escort "<leader display name>"`.
      * human leader (--follow NAME): spawn ONLY the escorts, all following the
        human-controlled character NAME. This is the 'I'm the leader' hive -- you
        move, the bots swarm you.

    Ctrl-C tears the whole tree down."""
    import subprocess
    import shlex

    escorts = [e.strip() for e in args.escort.split(",") if e.strip()]
    if not escorts:
        sys.exit("swarm: give at least one --escort <account>[:intent[:formation]]")

    # Escort membership names (for cohesion) = the escorts' display names plus
    # the leader's. Resolve each escort account to its character name so members/
    # readiness line up with what's actually in-world. A spec is
    # account[:intent[:formation]] -- omitted parts fall back to the --intent /
    # --formation defaults.
    esc_specs = []          # (account, intent, formation, display_name)
    for spec in escorts:
        parts = spec.split(":")
        acct = parts[0].strip()
        intent = (parts[1].strip() if len(parts) > 1 and parts[1].strip()
                  else args.intent)
        formation = (parts[2].strip() if len(parts) > 2 and parts[2].strip()
                     else args.formation)
        if intent not in INTENTS:
            sys.exit(f"swarm: unknown intent {intent!r}; choose from {INTENTS}")
        if formation not in FORMATIONS:
            sys.exit(f"swarm: unknown formation {formation!r}; choose from {FORMATIONS}")
        disp = _resolve_display_name(accounts, acct)
        esc_specs.append((acct, intent, formation, disp))

    if args.leader and args.follow:
        sys.exit("swarm: pass either --leader (bot leader) or --follow "
                 "(human leader), not both")
    if not args.leader and not args.follow:
        sys.exit("swarm: pass --leader <account> (bot leads) or --follow "
                 "<your character name> (you lead)")

    if args.leader:
        leader_name = _resolve_display_name(accounts, args.leader)
    else:
        leader_name = args.follow

    member_names = [d for *_, d in esc_specs] + [leader_name]
    members_arg = ",".join(member_names)

    # Shared swarm tuning passed to every child.
    common = [
        "--members", members_arg,
        "--hunt", args.hunt,
        "--rally", str(args.rally),
        "--threat", str(args.threat),
        "--threshold", str(args.threshold),
        "--focus-radius", str(args.focus_radius),
        "--cohesion-slack", str(args.cohesion_slack),
        "--hunt-enter", str(args.hunt_enter),
        "--hunt-exit", str(args.hunt_exit),
        "--readiness-smooth", str(args.readiness_smooth),
    ]
    if args.combat_exit is not None:
        common += ["--combat-exit", str(args.combat_exit)]

    py = sys.executable
    self_ = os.path.abspath(__file__)

    def child_cmd(account, sub_args):
        return [py, self_, "--creds", args.creds, "--account", account, *sub_args]

    jobs = []               # (label, argv)
    if args.leader:
        jobs.append((f"lead:{args.leader}",
                     child_cmd(args.leader, ["lead", *common])))
    for acct, intent, formation, _ in esc_specs:
        tag = f"{intent}/{formation}" if formation != "none" else intent
        jobs.append((f"escort:{acct}[{tag}]",
                     child_cmd(acct, ["escort", leader_name, "--intent", intent,
                                      "--formation", formation, *common])))

    mode = f"bot-leader {leader_name!r}" if args.leader else f"human-leader {leader_name!r}"
    print(f"swarm: {mode}; {len(jobs)} process(es):", file=sys.stderr)
    for label, argv in jobs:
        print(f"  {label}", file=sys.stderr)
    if args.dry_run:
        for label, argv in jobs:
            print("$ " + " ".join(shlex.quote(a) for a in argv))
        return

    procs = []
    try:
        for label, argv in jobs:
            procs.append((label, subprocess.Popen(argv)))
        # Wait for any child to exit; when one dies, keep the rest running (a bot
        # may just have been disconnected). Block until Ctrl-C.
        while True:
            alive = [p for _, p in procs if p.poll() is None]
            if not alive:
                print("swarm: all children exited", file=sys.stderr)
                break
            for label, p in procs:
                try:
                    p.wait(timeout=1.0)
                except subprocess.TimeoutExpired:
                    continue
    except KeyboardInterrupt:
        print("\nswarm: stopping all children", file=sys.stderr)
    finally:
        for label, p in procs:
            if p.poll() is None:
                p.terminate()
        for label, p in procs:
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()


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

    fa = sub.add_parser("farm",
                        help="farm indefinitely: kill, loot, cook, eat, "
                             "retreat + heal when hurt. Runs until Ctrl-C.")
    fa.add_argument("--until-hp", type=float, default=None, metavar="PCT",
                    help="stop and exit once HP drops to this %% (e.g. 50); "
                         "by default farming never stops on its own")
    fa.add_argument("--hunt", default="rat",
                    help="comma-separated monster types to kill; '*' means "
                         "anything (default 'rat')")
    fa.add_argument("--retreat-hp", type=float, default=35, metavar="PCT",
                    help="disengage and fall back below this %% HP (default 35)")
    fa.add_argument("--resume-hp", type=float, default=85, metavar="PCT",
                    help="resume fighting once back above this %% HP "
                         "(default 85; hysteresis against flip-flopping)")
    fa.add_argument("--heal-to", type=float, default=95, metavar="PCT",
                    help="heal up to this %% at the healer (default 95)")
    fa.add_argument("--healer", default="aldric", metavar="NAME",
                    help="NPC to retreat to and heal at (default 'aldric'); "
                         "empty string = just back away from the threat")
    fa.add_argument("--roam", type=int, default=12, metavar="TILES",
                    help="how far to wander looking for the next spawn "
                         "(default 12 tiles)")
    fa.add_argument("--no-loot", action="store_true",
                    help="don't pick drops up")
    fa.add_argument("--no-eat", action="store_true",
                    help="don't eat (WARNING: HP only regenerates while fed)")
    fa.add_argument("--no-cook", action="store_true",
                    help="don't cook raw meat into cooked")
    fa.add_argument("--no-stack", action="store_true",
                    help="don't merge split stacks in the backpack")
    fa.add_argument("--depth", type=int, default=0, metavar="Z",
                    help="floor to farm on: 0 = surface (default), negative "
                         "goes underground (e.g. -1). Descends via the known "
                         "holes and climbs back out the ladders when hurt.")
    fa.add_argument("--entry", default=None, metavar="X,Y",
                    help="which surface hole to descend by, as a tile "
                         "(e.g. 58,22); default picks the nearest")

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
        sp.add_argument("--readiness-smooth", type=float, default=0.4,
                        help="readiness EMA weight in (0,1]: smaller = stickier "
                             "(1.0 = raw, no smoothing; default 0.4)")
        sp.add_argument("--combat-exit", type=float, default=None,
                        help="keep fighting until smoothed readiness drops below "
                             "this (hysteresis; default = threshold-0.15)")

    ld = sub.add_parser("lead",
                        help="lead a party: wait up for a tight escort, then focus-fire")
    add_swarm_args(ld)

    e = sub.add_parser("escort",
                       help="follow a leader and focus-fire once the party is tight")
    e.add_argument("leader", help="name of the player to escort")
    e.add_argument("--intent", choices=INTENTS, default="follow",
                   help="engagement: follow (only join the LEADER's fight; "
                        "default), attack (hunt unprompted), defend (peel to a "
                        "monster attacking any member; never hunt).")
    e.add_argument("--formation", choices=FORMATIONS, default="none",
                   help="station-keeping (orthogonal to intent): none (trail the "
                        "leader; default) or magnetize (boids self-spacing).")
    add_swarm_args(e)

    sw = sub.add_parser("swarm",
                        help="ONE command that spawns the whole hive (leader + "
                             "escorts, or just escorts following a human leader)")
    sw.add_argument("--leader", metavar="ACCOUNT",
                    help="account to run as the BOT leader (spawns `lead`)")
    sw.add_argument("--follow", metavar="NAME",
                    help="human-leader mode: your in-world character name; spawns "
                         "ONLY escorts, all following you (no bot leader)")
    sw.add_argument("--escort", default="",
                    metavar="A[:INTENT[:FORMATION]],...",
                    help="comma-separated escort accounts, each optionally with a "
                         ":intent and :formation suffix, e.g. "
                         "'haiku:defend:magnetize,sonnet:attack,opus,fable'. "
                         "Omitted parts use --intent / --formation.")
    sw.add_argument("--intent", choices=INTENTS, default="follow",
                    help="default intent for escorts without a :intent (default follow)")
    sw.add_argument("--formation", choices=FORMATIONS, default="none",
                    help="default formation for escorts without a :formation "
                         "(default none)")
    sw.add_argument("--dry-run", action="store_true",
                    help="print the child commands instead of spawning them")
    add_swarm_args(sw)

    m = sub.add_parser("move", help="walk to 'x,y' tile, a location name, or a player")
    m.add_argument("target")

    s = sub.add_parser("send", help="send one raw JSON message and exit")
    s.add_argument("json")

    args = p.parse_args()
    accounts = load_accounts(args)

    # The swarm launcher is a pure orchestrator: it spawns child avalon.py
    # processes and never opens its own socket, so short-circuit the login path.
    if args.cmd == "swarm":
        run_swarm(args, accounts)
        return

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
