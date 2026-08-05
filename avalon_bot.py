"""
Minimal programmatic client for avalon.juanandresleon.com.

Protocol (reverse-engineered from the client bundle index-5zRK5L7e.js):
  - One WebSocket to wss://avalon.juanandresleon.com/
  - Client -> server: JSON text frames, EXCEPT `move` and `attack`, which are
    binary (opcodes 1 and 2).
  - Server -> client: JSON text frames for events, plus binary snapshot frames
    (opcode 1) at the tick rate (100 ms) carrying all entity state.

Auth: POST /api/auth/login -> sessionToken; GET /api/characters (Bearer token)
-> characterToken. Then send {"type":"join", sessionToken, characterToken}.

Requires: pip install websockets requests
"""

import asyncio
import json
import struct

HTTP = "https://avalon.juanandresleon.com"
WS = "wss://avalon.juanandresleon.com/"

# Client->server binary opcodes.
OP_MOVE = 1
OP_ATTACK = 2

# Server->client frame opcodes.
SRV_SNAPSHOT = 1
SRV_COMBAT_EVENT = 2
SRV_ENTITY_DIED = 3

MONSTER_TYPES = [
    "rat", "caveBat", "orc", "goblin", "ghost", "orcZealot", "orrinVale",
    "iceWizard", "wraith", "hellMage", "lizardman", "hellArchmage",
    "trainingDummy",
]
RARITIES = ["common", "uncommon", "rare", "epic", "legendary"]
GENDERS = ["male", "female"]

PK_TIER_MASK = 0x3F
PVP_FLAG_BIT = 0x40


class JoinRejected(Exception):
    """The server refused our join and will send nothing further.

    Most common cause: that character is already logged in somewhere else
    (an open browser tab). Only one connection per character is allowed --
    the *existing* session wins and the newcomer is refused.
    """


# --------------------------------------------------------------------------
# binary reader / writer (little-endian; strings are u16 length + utf-8)
# --------------------------------------------------------------------------

class Reader:
    def __init__(self, buf):
        self.b = buf
        self.o = 0

    def u8(self):
        v = self.b[self.o]
        self.o += 1
        return v

    def i8(self):
        v = struct.unpack_from("<b", self.b, self.o)[0]
        self.o += 1
        return v

    def u16(self):
        v = struct.unpack_from("<H", self.b, self.o)[0]
        self.o += 2
        return v

    def u32(self):
        v = struct.unpack_from("<I", self.b, self.o)[0]
        self.o += 4
        return v

    def f32(self):
        v = struct.unpack_from("<f", self.b, self.o)[0]
        self.o += 4
        return v

    def f64(self):
        v = struct.unpack_from("<d", self.b, self.o)[0]
        self.o += 8
        return v

    def string(self):
        n = self.u16()
        v = self.b[self.o:self.o + n].decode("utf-8")
        self.o += n
        return v


def encode_move(dx, dy):
    """dx/dy are -1, 0 or 1 -- a movement *intent*, not a step."""
    return struct.pack("<Bbb", OP_MOVE, dx, dy)


def encode_attack(target_id):
    raw = target_id.encode("utf-8")
    return struct.pack("<BH", OP_ATTACK, len(raw)) + raw


def read_item(r):
    """Nested item struct; containers recurse via the `contents` flag."""
    instance_id = r.string()
    item_id = r.string()
    rarity = r.u8()
    item = {
        "instanceId": instance_id,
        "itemId": item_id,
        "rarity": RARITIES[rarity] if rarity < len(RARITIES) else "common",
        "quantity": r.u16(),
    }
    if r.u8() == 1:
        item["lit"] = True
    if r.u8() == 1:
        n = r.u8()
        item["contents"] = [read_item(r) if r.u8() == 1 else None for _ in range(n)]
    return item


def decode_snapshot(buf, known_ground_rev=-1, known_z=None):
    """Decode a server snapshot frame into plain dicts."""
    r = Reader(buf)
    r.u8()  # opcode, already known to be SRV_SNAPSHOT
    z = r.i8()
    out = {"z": z, "players": [], "monsters": [], "npcs": [], "groundItems": None}

    for _ in range(r.u16()):
        pid, name = r.string(), r.string()
        x, y = r.f32(), r.f32()
        hp, max_hp, level = r.u16(), r.u16(), r.u16()
        g = r.u8()
        gender = GENDERS[g] if g < len(GENDERS) else "male"
        light = r.u16()
        flags = r.u8()
        out["players"].append({
            "id": pid, "name": name, "x": x, "y": y, "z": z,
            "hp": hp, "maxHp": max_hp, "level": level, "gender": gender,
            "lightRadiusPx": light,
            "pkTier": flags & PK_TIER_MASK,
            "pvpFlagOn": bool(flags & PVP_FLAG_BIT),
        })

    for _ in range(r.u16()):
        mid = r.string()
        t = r.u8()
        out["monsters"].append({
            "id": mid,
            "monsterType": MONSTER_TYPES[t] if t < len(MONSTER_TYPES) else "unknown",
            "x": r.f32(), "y": r.f32(), "z": z,
            "hp": r.u16(), "maxHp": r.u16(), "enraged": r.u8() == 1,
        })

    for _ in range(r.u8()):
        out["npcs"].append({
            "id": r.string(), "npcType": r.string(), "name": r.string(),
            "x": r.f32(), "y": r.f32(), "z": z,
        })

    # Ground items are only re-sent when the revision changes.
    ground_rev = r.u32()
    out["groundRev"] = ground_rev
    if ground_rev == known_ground_rev and z == known_z:
        return out

    items = []
    for _ in range(r.u16()):
        gid, x, y = r.string(), r.f32(), r.f32()
        owner, expires = r.string(), r.f64()
        items.append({
            "id": gid, "x": x, "y": y, "z": z, "item": read_item(r),
            "ownerId": owner or None, "ownerExpiresAt": expires,
        })
    out["groundItems"] = items
    return out


def decode_combat_event(buf):
    r = Reader(buf)
    r.u8()
    ev = {
        "attackerId": r.string(), "targetId": r.string(),
        "damage": r.u16(), "targetHpAfter": r.u16(), "targetMaxHp": r.u16(),
    }
    f = r.u8()
    ev.update(crit=bool(f & 1), spell=bool(f & 2),
              blocked=bool(f & 4), frost=bool(f & 8))
    return ev


# --------------------------------------------------------------------------
# auth
# --------------------------------------------------------------------------

def login(username, password):
    """Returns (sessionToken, [characters]). Registers via /api/auth/register."""
    import requests

    r = requests.post(f"{HTTP}/api/auth/login",
                      json={"username": username, "password": password})
    r.raise_for_status()
    data = r.json()
    session = data["sessionToken"]
    chars = data.get("characters") or []
    if not chars:
        c = requests.get(f"{HTTP}/api/characters",
                         headers={"Authorization": f"Bearer {session}"})
        chars = c.json().get("characters", [])
    return session, chars


# --------------------------------------------------------------------------
# bot
# --------------------------------------------------------------------------

class AvalonBot:
    def __init__(self, session_token, character_token):
        self.session_token = session_token
        self.character_token = character_token
        self.ws = None
        self.me = None          # id of our player
        self.state = {}         # latest decoded snapshot
        self.ground_rev = -1
        self.z = None
        self.fleeing = False    # set by the AI when HP gets low
        self.equipment = {}     # slot -> item dict (from `welcome`/`equipmentUpdate`)
        self.stats = {}         # authoritative stats from `welcome`/`playerStats`

    async def send(self, msg):
        """JSON for everything except move/attack, which are binary."""
        t = msg.get("type")
        if t == "move":
            await self.ws.send(encode_move(msg["dx"], msg["dy"]))
        elif t == "attack":
            await self.ws.send(encode_attack(msg["targetId"]))
        else:
            await self.ws.send(json.dumps(msg))

    # convenience wrappers -- the full verb list is in the module docstring
    async def move(self, dx, dy):
        await self.send({"type": "move", "dx": dx, "dy": dy})

    async def attack(self, target_id):
        await self.send({"type": "attack", "targetId": target_id})

    async def chat(self, text):
        await self.send({"type": "chat", "text": text})

    async def harvest(self, node_id):
        await self.send({"type": "harvest", "nodeId": node_id})

    async def use_item(self, instance_id):
        await self.send({"type": "useItem", "instanceId": instance_id})

    async def talk_to(self, npc_id, option_id=None):
        """Open a dialogue (no option_id) or pick an option (with one)."""
        msg = {"type": "talkTo", "npcId": npc_id}
        if option_id is not None:
            msg["optionId"] = option_id
        await self.send(msg)

    # ---- inventory helpers (backpack lives in equipment, not the snapshot) ---

    def iter_items(self):
        """Yield every item held, recursing into containers -- mirrors the
        client's `z()`: walk equipment slots and any `contents` arrays."""
        def walk(items):
            for it in items:
                if not it:
                    continue
                yield it
                if it.get("contents"):
                    yield from walk(it["contents"])
        yield from walk(self.equipment.values())

    def find_item(self, item_id):
        """First held item with this itemId (like the client's `B()`), or None."""
        return next((it for it in self.iter_items()
                     if it.get("itemId") == item_id), None)

    def count_item(self, item_id):
        return sum(it.get("quantity", 0) for it in self.iter_items()
                   if it.get("itemId") == item_id)

    async def run(self, on_snapshot=None, on_event=None):
        import websockets

        async with websockets.connect(WS, max_size=None, open_timeout=10) as ws:
            self.ws = ws
            await self.send({
                "type": "join",
                "sessionToken": self.session_token,
                "characterToken": self.character_token,
            })
            async for raw in ws:
                if isinstance(raw, str):
                    msg = json.loads(raw)
                    kind = msg.get("type")
                    if kind == "welcome":
                        self.me = msg["id"]
                        self.equipment = msg.get("equipment") or {}
                        self.stats = msg.get("stats") or {}
                        print(f"joined as {msg['name']} ({self.me}) "
                              f"at ({msg['x']:.0f},{msg['y']:.0f}) "
                              f"tick={msg['tickRateMs']}ms")
                    elif kind == "equipmentUpdate":
                        self.equipment = msg.get("equipment") or {}
                    elif kind == "playerStats":
                        self.stats = msg.get("stats") or {}
                    elif kind == "joinRejected":
                        # The server leaves the socket open but sends nothing
                        # further, so this must raise or the bot hangs forever.
                        raise JoinRejected(msg.get("reason", "join rejected"))
                    if on_event:
                        await on_event(self, msg)
                    continue

                op = raw[0]
                if op == SRV_SNAPSHOT:
                    snap = decode_snapshot(raw, self.ground_rev, self.z)
                    self.ground_rev, self.z = snap["groundRev"], snap["z"]
                    self.state = snap
                    if on_snapshot:
                        await on_snapshot(self, snap)
                elif op == SRV_COMBAT_EVENT:
                    ev = decode_combat_event(raw)
                    if ev["targetId"] == self.me or ev["attackerId"] == self.me:
                        print("combat:", ev)


# --------------------------------------------------------------------------
# example: attack the nearest monster, otherwise wander east
# --------------------------------------------------------------------------

FLEE_HP_FRACTION = 0.35   # run away below this
RESUME_HP_FRACTION = 0.8  # resume fighting once healed back up
MELEE_RANGE_PX = 40


async def example_ai(bot, snap):
    me = next((p for p in snap["players"] if p["id"] == bot.me), None)
    if not me:
        return

    hp_frac = me["hp"] / max(1, me["maxHp"])
    if hp_frac < FLEE_HP_FRACTION:
        bot.fleeing = True
    elif hp_frac >= RESUME_HP_FRACTION:
        bot.fleeing = False

    monsters = [m for m in snap["monsters"] if m["hp"] > 0]
    if not monsters:
        await bot.move(0, 0)
        return

    nearest = min(monsters, key=lambda m: (m["x"] - me["x"]) ** 2 + (m["y"] - me["y"]) ** 2)
    dx = (nearest["x"] > me["x"]) - (nearest["x"] < me["x"])
    dy = (nearest["y"] > me["y"]) - (nearest["y"] < me["y"])

    if bot.fleeing:
        # Walk directly away from the nearest threat and let HP regen.
        await bot.move(-dx, -dy)
        return

    dist = ((nearest["x"] - me["x"]) ** 2 + (nearest["y"] - me["y"]) ** 2) ** 0.5
    if dist < MELEE_RANGE_PX:
        # `move` is a held intent, so stop before swinging.
        await bot.move(0, 0)
        await bot.attack(nearest["id"])
    else:
        await bot.move(dx, dy)


async def main():
    """usage: python avalon_bot.py <username> <password> [character-name]"""
    import sys

    session, chars = login(sys.argv[1], sys.argv[2])
    print("characters:", [c.get("name") for c in chars])
    if not chars:
        raise SystemExit("no characters on this account")

    wanted = sys.argv[3].lower() if len(sys.argv) > 3 else None
    if wanted:
        chosen = next((c for c in chars if c.get("name", "").lower() == wanted), None)
        if chosen is None:
            raise SystemExit(f"no character named {sys.argv[3]!r}")
    else:
        chosen = chars[0]

    print(f"playing as {chosen.get('name')}")
    token = chosen.get("characterToken") or chosen.get("token")
    try:
        await AvalonBot(session, token).run(on_snapshot=example_ai)
    except JoinRejected as e:
        raise SystemExit(
            f"join rejected: {e}\n"
            "That character is already in the world -- close the browser tab "
            "playing it, or pass a different character name as argv[3]."
        )


if __name__ == "__main__":
    asyncio.run(main())
