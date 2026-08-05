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

def step_toward(me, tx_px, ty_px):
    """Return (dx,dy) each in {-1,0,1} pointing from me toward a px target."""
    dx = (tx_px > me["x"]) - (tx_px < me["x"])
    dy = (ty_px > me["y"]) - (ty_px < me["y"])
    return dx, dy

def dist_px(ax, ay, bx, by):
    return math.hypot(ax - bx, ay - by)

def resolve_target(spec, snap):
    """A target spec -> (x_px, y_px). Accepts 'x,y' tiles, a location name,
    or a player name (resolved against the current snapshot)."""
    if "," in spec:
        xs, ys = spec.split(",", 1)
        return (float(xs) + 0.5) * TILE, (float(ys) + 0.5) * TILE
    if spec.lower() in LOCATIONS:
        tx, ty = LOCATIONS[spec.lower()]
        return (tx + 0.5) * TILE, (ty + 0.5) * TILE
    p = next((p for p in snap["players"] if p["name"].lower() == spec.lower()), None)
    if p:
        return p["x"], p["y"]
    return None


# --------------------------------------------------------------------------
# intents -- each is an on_snapshot coroutine plus optional one-shot action
# --------------------------------------------------------------------------

async def intent_where(bot, snap):
    for p in snap["players"]:
        tag = "  <- you" if p["id"] == bot.me else ""
        print(f"{p['name']:>16}  tile=({p['x']/TILE:5.0f},{p['y']/TILE:5.0f})  "
              f"hp={p['hp']}/{p['maxHp']}  lvl={p['level']}{tag}")
    living = [m for m in snap["monsters"] if m["hp"] > 0]
    print(f"\n{len(living)} monsters, {len(snap['npcs'])} npcs nearby")
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


async def intent_heal(bot, snap):
    """Heal to full. Prefer drinking a health potion from the backpack; if none
    are held, walk to a healer NPC (Brother Aldric) and take their heal option.

    The backpack lives in the `equipment` message, not the snapshot, so this
    reads bot.equipment (populated by avalon_bot's run loop)."""
    me = me_of(bot, snap)
    if not me:
        return
    if me["hp"] >= me["maxHp"]:
        print(f"already full ({me['hp']}/{me['maxHp']})")
        bot.done = True
        return

    # 1) Drink potions while one would actually help. A potion only counts if
    #    the missing HP is at least, say, half its heal value -- otherwise the
    #    overheal is wasted, so we stop and let natural regen finish the last
    #    sliver rather than spamming useItem (which the server just ignores).
    now = _now()
    missing = me["maxHp"] - me["hp"]
    last_drink = getattr(bot, "_heal_last_drink", 0.0)
    useful = [(bot.find_item(pid), amt) for pid, amt in HEAL_POTIONS
              if bot.find_item(pid) and missing >= amt * 0.5]
    if useful:
        potion, amt = useful[0]
        if now - last_drink < 0.8:      # server has a short potion cooldown
            return
        print(f"hp {me['hp']}/{me['maxHp']} -- drinking {potion['itemId']} "
              f"(+{amt}, x{bot.count_item(potion['itemId'])} held)")
        await bot.use_item(potion["instanceId"])
        bot._heal_last_drink = now
        return
    if last_drink:
        # Drank at least one and now the rest would overheal (or we're out).
        held = sum(bot.count_item(pid) for pid, _ in HEAL_POTIONS)
        tail = "out of health potions" if not held else "close enough (regen will finish)"
        print(f"hp {me['hp']}/{me['maxHp']} -- {tail}")
        bot.done = True
        return

    # 2) No potion: head to a healer NPC and use their dialogue.
    healer = next((n for n in snap["npcs"]
                   if n.get("name", "").lower() in HEALER_NAMES
                   or n.get("npcType", "").lower() in HEALER_NAMES), None)
    if not healer:
        print(f"hp {me['hp']}/{me['maxHp']} -- no health potion held and no "
              "healer NPC nearby. Move to Brother Aldric, then run `heal` again.")
        bot.done = True
        return

    if dist_px(me["x"], me["y"], healer["x"], healer["y"]) > TILE * 1.5:
        # Walk to the healer first.
        await bot.move(*step_toward(me, healer["x"], healer["y"]))
        return

    # In range: stop and open/advance the dialogue. The heal option id is
    # dynamic, so we open the dialogue and let on_event pick the heal option.
    await bot.move(0, 0)
    if not getattr(bot, "_heal_talk_sent", False):
        bot._heal_talk_sent = True
        bot._heal_npc = healer["id"]
        print(f"hp {me['hp']}/{me['maxHp']} -- talking to {healer.get('name')}")
        await bot.talk_to(healer["id"])


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
        t = next((p for p in snap["players"]
                  if p["name"].lower() == target_name.lower()), None)

        if t:
            bot._follow_last = (t["x"], t["y"], _now())
            tx, ty = t["x"], t["y"]
        else:
            last = getattr(bot, "_follow_last", None)
            if not last or _now() - last[2] > LOST_GRACE_S:
                # Never seen them, or lost too long ago -- hold position.
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
            await bot.move(*step_toward(me, tx, ty))
    return intent


async def intent_farm(bot, snap):
    # Reuse the flee-aware combat AI already in avalon_bot.
    await ab.example_ai(bot, snap)


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
        await intent(b, snap)
        if getattr(b, "done", False):
            await b.ws.close()

    async def wrapped_event(b, msg):
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
        return intent_heal, heal_on_event
    if args.cmd == "farm":
        return intent_farm, None
    if args.cmd == "follow":
        return make_follow(args.target, args.keep * TILE), None
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
    sub.add_parser("heal", help="use a healing item (needs configuration)")
    sub.add_parser("farm", help="fight nearby monsters until Ctrl-C")

    f = sub.add_parser("follow", help="follow a player until Ctrl-C")
    f.add_argument("target")
    f.add_argument("--keep", type=int, default=2, help="tiles to keep behind (default 2)")

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
