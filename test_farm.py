"""Unit tests for the farm loop (loot / cook / stack / eat / retreat).

These drive the intent with synthetic snapshots and a fake bot that records
what was sent, so the whole state machine is exercised without a server.
"""

import asyncio
import unittest

import avalon
import avalon_bot as ab

TILE = avalon.TILE


def px(t):
    return (t + 0.5) * TILE


class FakeBot:
    """Stands in for AvalonBot: records sends, serves canned inventory."""

    def __init__(self, equipment=None, stats=None):
        self.me = "me"
        self.sent = []
        self.equipment = equipment or {}
        self.stats = stats or {"statusEffects": [{"kind": "wellFed",
                                                  "remainingMs": 60000}]}
        self.z = 0
        self.done = False
        self.fleeing = False
        self.state = {}

    # -- the AvalonBot surface the intent actually touches -----------------
    iter_items = ab.AvalonBot.iter_items
    find_item = ab.AvalonBot.find_item
    count_item = ab.AvalonBot.count_item
    backpack = ab.AvalonBot.backpack
    pack_space = ab.AvalonBot.pack_space
    has_status = ab.AvalonBot.has_status

    async def send(self, msg):
        self.sent.append(msg)

    async def move(self, dx, dy):
        self.sent.append({"type": "move", "dx": dx, "dy": dy})

    async def attack(self, tid):
        self.sent.append({"type": "attack", "targetId": tid})

    async def use_item(self, iid):
        self.sent.append({"type": "useItem", "instanceId": iid})

    async def talk_to(self, npc, opt=None):
        self.sent.append({"type": "talkTo", "npcId": npc, "optionId": opt})

    async def use_teleport(self):
        self.sent.append({"type": "useTeleport"})

    move_item = ab.AvalonBot.move_item
    take_item = ab.AvalonBot.take_item

    def kinds(self):
        return [m["type"] for m in self.sent]

    def of_type(self, t):
        return [m for m in self.sent if m["type"] == t]


def item(item_id, qty=1, iid=None, contents=None):
    it = {"itemId": item_id, "quantity": qty,
          "instanceId": iid or f"{item_id}-{qty}"}
    if contents is not None:
        it["contents"] = contents
    return it


def backpack(contents, cap=8):
    """An equipped backpack with `contents` padded out to `cap` slots."""
    slots = list(contents) + [None] * (cap - len(contents))
    return {"backpack": item("backpack", 1, "pack", contents=slots)}


def snapshot(players=(), monsters=(), npcs=(), ground=()):
    return {"z": 0, "players": list(players), "monsters": list(monsters),
            "npcs": list(npcs), "groundItems": list(ground), "groundRev": 1}


def me(tile=(10, 10), hp=100, max_hp=100):
    return {"id": "me", "name": "Sam Altman", "x": px(tile[0]), "y": px(tile[1]),
            "z": 0, "hp": hp, "maxHp": max_hp, "level": 5}


def rat(tile=(10, 10), hp=20, mid="rat1", mtype="rat"):
    return {"id": mid, "monsterType": mtype, "x": px(tile[0]), "y": px(tile[1]),
            "z": 0, "hp": hp, "maxHp": 20, "enraged": False}


def drop(tile=(10, 10), item_id="gold", qty=5, gid="g1", owner=None):
    return {"id": gid, "x": px(tile[0]), "y": px(tile[1]), "z": 0,
            "item": item(item_id, qty, f"i-{gid}"),
            "ownerId": owner, "ownerExpiresAt": 0}


def corpse(tile=(10, 10), contents=(), gid="c1", owner=None):
    """A killed monster's remains: a ground container whose `contents` are the
    real drops. This is how rats actually leave loot."""
    return {"id": gid, "x": px(tile[0]), "y": px(tile[1]), "z": 0,
            "item": item("corpse", 1, f"i-{gid}", contents=list(contents)),
            "ownerId": owner, "ownerExpiresAt": 0}


def run(intent, bot, snap):
    asyncio.run(intent(bot, snap))
    return bot


def cfg(**kw):
    kw.setdefault("healer_name", "aldric")
    return avalon.FarmConfig(**kw)


class TestFight(unittest.TestCase):
    def test_attacks_rat_in_melee_range(self):
        bot = FakeBot(backpack([]))
        snap = snapshot([me()], [rat((10, 10))])
        run(avalon.make_farm(cfg()), bot, snap)
        self.assertEqual(bot.of_type("attack")[0]["targetId"], "rat1")

    def test_chases_distant_rat(self):
        bot = FakeBot(backpack([]))
        snap = snapshot([me((10, 10))], [rat((16, 10))])
        run(avalon.make_farm(cfg()), bot, snap)
        self.assertFalse(bot.of_type("attack"))
        self.assertTrue(bot.of_type("move"))

    def test_hunt_filter_ignores_non_prey(self):
        """--hunt rat must not pick a fight with the 16k-HP training dummy."""
        bot = FakeBot(backpack([]))
        snap = snapshot([me()], [rat((10, 10), mid="d", mtype="trainingDummy")])
        run(avalon.make_farm(cfg(hunt_types={"rat"})), bot, snap)
        self.assertFalse(bot.of_type("attack"))

    def test_dead_bot_respawns(self):
        bot = FakeBot(backpack([]))
        snap = snapshot([me(hp=0)], [rat()])
        run(avalon.make_farm(cfg()), bot, snap)
        self.assertIn("respawn", bot.kinds())


class TestLoot(unittest.TestCase):
    def test_loots_drop_in_reach(self):
        bot = FakeBot(backpack([]))
        snap = snapshot([me((10, 10))], [], ground=[drop((10, 10))])
        run(avalon.make_farm(cfg()), bot, snap)
        mv = bot.of_type("moveItem")
        self.assertEqual(len(mv), 1)
        self.assertEqual(mv[0]["instanceId"], "i-g1")
        self.assertEqual(mv[0]["to"]["containerInstanceId"], "pack")

    def test_walks_to_distant_drop(self):
        bot = FakeBot(backpack([]))
        snap = snapshot([me((10, 10))], [], ground=[drop((15, 10))])
        run(avalon.make_farm(cfg()), bot, snap)
        self.assertFalse(bot.of_type("moveItem"))
        self.assertTrue(bot.of_type("move"))

    def test_skips_loot_owned_by_someone_else(self):
        bot = FakeBot(backpack([]))
        snap = snapshot([me((10, 10))], [],
                        ground=[drop((10, 10), owner="someone-else")])
        run(avalon.make_farm(cfg()), bot, snap)
        self.assertFalse(bot.of_type("moveItem"))

    def test_takes_own_reserved_loot(self):
        bot = FakeBot(backpack([]))
        snap = snapshot([me((10, 10))], [], ground=[drop((10, 10), owner="me")])
        run(avalon.make_farm(cfg()), bot, snap)
        self.assertTrue(bot.of_type("moveItem"))

    def test_fighting_takes_priority_over_looting(self):
        bot = FakeBot(backpack([]))
        snap = snapshot([me((10, 10))], [rat((10, 10))],
                        ground=[drop((10, 10))])
        run(avalon.make_farm(cfg()), bot, snap)
        self.assertTrue(bot.of_type("attack"))
        self.assertFalse(bot.of_type("moveItem"))

    def test_full_backpack_warns_once_and_keeps_going(self):
        full = backpack([item("junk", 1, f"j{i}") for i in range(8)], cap=8)
        bot = FakeBot(full)
        snap = snapshot([me((10, 10))], [], ground=[drop((10, 10))])
        intent = avalon.make_farm(cfg(cook=False, stack=False))
        run(intent, bot, snap)
        self.assertFalse(bot.of_type("moveItem"))
        self.assertTrue(bot._farm_warned_full)
        self.assertFalse(bot.done)   # keeps farming, does not exit

    def test_loots_out_of_a_corpse(self):
        """The bug from the live run: rats leave a `corpse` container and the
        drops are INSIDE it, so taking the corpse itself loots nothing."""
        bot = FakeBot(backpack([]))
        snap = snapshot([me((10, 10))], [],
                        ground=[corpse((10, 10),
                                       contents=[item("gold", 7, "loot-gold")])])
        run(avalon.make_farm(cfg()), bot, snap)
        mv = bot.of_type("moveItem")
        self.assertEqual(len(mv), 1)
        self.assertEqual(mv[0]["instanceId"], "loot-gold")   # not "i-c1"

    def test_empty_corpse_is_not_a_loot_target(self):
        bot = FakeBot(backpack([]))
        snap = snapshot([me((10, 10))], [], ground=[corpse((10, 10))])
        run(avalon.make_farm(cfg(cook=False, stack=False)), bot, snap)
        self.assertFalse(bot.of_type("moveItem"))

    def test_walks_to_a_distant_corpse(self):
        bot = FakeBot(backpack([]))
        snap = snapshot([me((10, 10))], [],
                        ground=[corpse((16, 10),
                                       contents=[item("gold", 7, "loot-gold")])])
        run(avalon.make_farm(cfg()), bot, snap)
        self.assertFalse(bot.of_type("moveItem"))
        self.assertTrue(bot.of_type("move"))

    def test_takes_multiple_items_from_one_corpse(self):
        """Several drops share a corpse; we take them one per tick."""
        bot = FakeBot(backpack([]))
        body = corpse((10, 10), contents=[item("gold", 7, "l1"),
                                          item("rawMeat", 2, "l2")])
        intent = avalon.make_farm(cfg(cook=False, stack=False))
        run(intent, bot, snapshot([me((10, 10))], [], ground=[body]))
        first = bot.of_type("moveItem")[0]["instanceId"]
        # Simulate the server removing the taken item from the corpse.
        body["item"]["contents"] = [c for c in body["item"]["contents"]
                                    if c["instanceId"] != first]
        bot.sent.clear()
        bot._farm_last_pickup = 0.0
        run(intent, bot, snapshot([me((10, 10))], [], ground=[body]))
        second = bot.of_type("moveItem")[0]["instanceId"]
        self.assertNotEqual(first, second)
        self.assertEqual({first, second}, {"l1", "l2"})

    def test_skips_a_corpse_owned_by_someone_else(self):
        bot = FakeBot(backpack([]))
        snap = snapshot([me((10, 10))], [],
                        ground=[corpse((10, 10), owner="rival",
                                       contents=[item("gold", 7, "l1")])])
        run(avalon.make_farm(cfg(cook=False, stack=False)), bot, snap)
        self.assertFalse(bot.of_type("moveItem"))

    def test_no_loot_flag_disables_pickup(self):
        bot = FakeBot(backpack([]))
        snap = snapshot([me((10, 10))], [], ground=[drop((10, 10))])
        run(avalon.make_farm(cfg(loot=False)), bot, snap)
        self.assertFalse(bot.of_type("moveItem"))


class TestCookAndStack(unittest.TestCase):
    def test_cooks_raw_meat(self):
        bot = FakeBot(backpack([item("rawMeat", 3, "raw1")]))
        snap = snapshot([me()], [])
        run(avalon.make_farm(cfg()), bot, snap)
        self.assertEqual(bot.of_type("useItem")[0]["instanceId"], "raw1")

    def test_no_cook_flag_leaves_meat_raw(self):
        bot = FakeBot(backpack([item("rawMeat", 3, "raw1")]))
        snap = snapshot([me()], [])
        run(avalon.make_farm(cfg(cook=False, stack=False)), bot, snap)
        self.assertFalse([m for m in bot.of_type("useItem")
                          if m["instanceId"] == "raw1"])

    def test_merges_split_stacks_smallest_into_largest(self):
        bot = FakeBot(backpack([item("gold", 10, "g-a"), item("gold", 3, "g-b")]))
        snap = snapshot([me()], [])
        run(avalon.make_farm(cfg(cook=False)), bot, snap)
        mv = bot.of_type("moveItem")
        self.assertEqual(len(mv), 1)
        self.assertEqual(mv[0]["instanceId"], "g-b")     # smaller stack moves
        self.assertEqual(mv[0]["to"]["slotIndex"], 0)    # into the bigger one

    def test_does_not_merge_non_stackables(self):
        bot = FakeBot(backpack([item("dagger", 1, "d1"), item("dagger", 1, "d2")]))
        snap = snapshot([me()], [])
        run(avalon.make_farm(cfg(cook=False)), bot, snap)
        self.assertFalse(bot.of_type("moveItem"))

    def test_learns_stackability_from_observed_quantity(self):
        """An unknown item the server holds as qty>1 is stackable by proof."""
        bot = FakeBot(backpack([item("widget", 4, "w1"), item("widget", 2, "w2")]))
        snap = snapshot([me()], [])
        run(avalon.make_farm(cfg(cook=False)), bot, snap)
        self.assertEqual(bot.of_type("moveItem")[0]["instanceId"], "w2")

    def test_cook_precedes_stacking(self):
        bot = FakeBot(backpack([item("rawMeat", 1, "raw1"),
                                item("gold", 5, "g-a"), item("gold", 1, "g-b")]))
        snap = snapshot([me()], [])
        run(avalon.make_farm(cfg()), bot, snap)
        self.assertTrue(bot.of_type("useItem"))
        self.assertFalse(bot.of_type("moveItem"))


class TestEating(unittest.TestCase):
    HUNGRY = {"statusEffects": []}

    def test_eats_when_not_wellfed(self):
        bot = FakeBot(backpack([item("cookedMeat", 2, "cm1")]), self.HUNGRY)
        snap = snapshot([me()], [])
        run(avalon.make_farm(cfg(cook=False, stack=False)), bot, snap)
        self.assertEqual(bot.of_type("useItem")[0]["instanceId"], "cm1")

    def test_does_not_eat_when_already_fed(self):
        bot = FakeBot(backpack([item("cookedMeat", 2, "cm1")]))
        snap = snapshot([me()], [])
        run(avalon.make_farm(cfg(cook=False, stack=False)), bot, snap)
        self.assertFalse(bot.of_type("useItem"))

    def test_saves_good_food_when_healthy(self):
        """Healthy: burn the short apple, keep the long-lasting sushi."""
        bot = FakeBot(backpack([item("fish", 1, "f1"), item("apple", 1, "a1")]),
                      self.HUNGRY)
        self.assertEqual(avalon.pick_food(bot, emergency=False)["itemId"], "apple")

    def test_emergency_takes_the_longest_lasting_food(self):
        """Hurt: eat the sushi so we don't break off to eat again mid-retreat."""
        bot = FakeBot(backpack([item("fish", 1, "f1"), item("apple", 1, "a1")]),
                      self.HUNGRY)
        self.assertEqual(avalon.pick_food(bot, emergency=True)["itemId"], "fish")

    def test_warns_when_out_of_food(self):
        bot = FakeBot(backpack([]), self.HUNGRY)
        snap = snapshot([me()], [])
        run(avalon.make_farm(cfg(cook=False, stack=False)), bot, snap)
        self.assertTrue(bot._farm_warned_food)

    def test_eats_while_retreating(self):
        """Regen is the healing mechanism, so eating matters most when hurt."""
        bot = FakeBot(backpack([item("cookedMeat", 2, "cm1")]), self.HUNGRY)
        snap = snapshot([me(hp=20)], [rat((12, 10))])
        run(avalon.make_farm(cfg()), bot, snap)
        self.assertTrue(bot.of_type("useItem"))


class TestRetreatAndHeal(unittest.TestCase):
    # NB: these place the monster well away from the player. A monster in melee
    # deliberately overrides the retreat (see can_disengage) -- fleeing from
    # something already swinging just feeds it free hits.

    def test_retreats_below_threshold(self):
        bot = FakeBot(backpack([]))
        snap = snapshot([me((10, 10), hp=20)], [rat((25, 10))])
        run(avalon.make_farm(cfg()), bot, snap)
        self.assertTrue(bot.fleeing)
        self.assertFalse(bot.of_type("attack"))

    def test_hysteresis_keeps_fleeing_between_thresholds(self):
        """Above retreat but below resume: must NOT re-engage yet."""
        bot = FakeBot(backpack([]))
        intent = avalon.make_farm(cfg())
        run(intent, bot, snapshot([me((10, 10), hp=20)], [rat((25, 10))]))
        self.assertTrue(bot.fleeing)
        bot.sent.clear()
        run(intent, bot, snapshot([me((10, 10), hp=60)], [rat((25, 10))]))
        self.assertTrue(bot.fleeing)
        self.assertFalse(bot.of_type("attack"))

    def test_resumes_fighting_once_healed(self):
        bot = FakeBot(backpack([]))
        intent = avalon.make_farm(cfg())
        run(intent, bot, snapshot([me(hp=20)], [rat((10, 10))]))
        bot.sent.clear()
        run(intent, bot, snapshot([me(hp=95)], [rat((10, 10))]))
        self.assertFalse(bot.fleeing)
        self.assertTrue(bot.of_type("attack"))

    def test_retreats_toward_the_healer(self):
        aldric = {"id": "n1", "npcType": "healer", "name": "Brother Aldric",
                  "x": px(20), "y": px(10), "z": 0}
        bot = FakeBot(backpack([]))
        snap = snapshot([me((10, 10), hp=20)], [rat((2, 10))], npcs=[aldric])
        run(avalon.make_farm(cfg()), bot, snap)
        mv = bot.of_type("move")[-1]
        self.assertEqual(mv["dx"], 1)   # toward Aldric (east), not away

    def test_talks_to_healer_when_adjacent(self):
        aldric = {"id": "n1", "npcType": "healer", "name": "Brother Aldric",
                  "x": px(10), "y": px(10), "z": 0}
        bot = FakeBot(backpack([]))
        snap = snapshot([me((10, 10), hp=20)], [], npcs=[aldric])
        run(avalon.make_farm(cfg()), bot, snap)
        self.assertEqual(bot.of_type("talkTo")[0]["npcId"], "n1")

    def test_drinks_potion_when_hurt_at_healer(self):
        aldric = {"id": "n1", "npcType": "healer", "name": "Brother Aldric",
                  "x": px(10), "y": px(10), "z": 0}
        bot = FakeBot(backpack([item("healthPotion", 2, "hp1")]))
        snap = snapshot([me((10, 10), hp=20)], [], npcs=[aldric])
        run(avalon.make_farm(cfg()), bot, snap)
        self.assertEqual(bot.of_type("useItem")[0]["instanceId"], "hp1")

    def test_heal_dialogue_does_not_end_the_farm(self):
        """`heal` is one-shot; farming must survive its own heals."""
        bot = FakeBot(backpack([]))
        bot._heal_npc = "n1"
        dialogue = {"type": "dialogue", "npcId": "n1",
                    "options": [{"id": "o1", "label": "Heal me"}]}
        asyncio.run(avalon.make_heal_on_event(one_shot=False)(bot, dialogue))
        self.assertFalse(bot.done)
        self.assertIn("endDialogue", bot.kinds())

    def test_heal_command_still_exits_after_healing(self):
        """The one-shot default must not regress now that farm shares this."""
        bot = FakeBot(backpack([]))
        bot._heal_npc = "n1"
        dialogue = {"type": "dialogue", "npcId": "n1",
                    "options": [{"id": "o1", "label": "Heal me"}]}
        asyncio.run(avalon.make_heal_on_event()(bot, dialogue))
        self.assertTrue(bot.done)

    def test_until_hp_still_stops(self):
        bot = FakeBot(backpack([]))
        snap = snapshot([me(hp=40)], [rat()])
        run(avalon.make_farm(cfg(until_hp_frac=0.5)), bot, snap)
        self.assertTrue(bot.done)


class TestLiveRunRegressions(unittest.TestCase):
    """Three bugs that together killed Sam on the first live run: he starved
    with a bag of apples, fled from a rat that hits for 1, and never looted."""

    HUNGRY = {"statusEffects": []}

    def test_eats_while_fighting(self):
        """The killer bug: eating sat in the idle branch, but the rat field
        always has a rat in view, so the fight branch returned first and he
        never ate -- and without wellFed, HP never regenerates."""
        bot = FakeBot(backpack([item("apple", 7, "a1")]), self.HUNGRY)
        snap = snapshot([me((10, 10))], [rat((10, 10))])
        run(avalon.make_farm(cfg()), bot, snap)
        self.assertTrue([m for m in bot.of_type("useItem")
                         if m["instanceId"] == "a1"], "should eat mid-fight")
        self.assertTrue(bot.of_type("attack"), "and still fight")

    def test_eats_while_chasing(self):
        bot = FakeBot(backpack([item("apple", 7, "a1")]), self.HUNGRY)
        snap = snapshot([me((10, 10))], [rat((16, 10))])
        run(avalon.make_farm(cfg()), bot, snap)
        self.assertTrue(bot.of_type("useItem"))

    def test_cornered_bot_fights_instead_of_feeding_free_hits(self):
        """Hurt with a rat in melee: fleeing just eats free hits, so fight."""
        bot = FakeBot(backpack([]))
        snap = snapshot([me((10, 10), hp=20)], [rat((10, 10))])
        run(avalon.make_farm(cfg()), bot, snap)
        self.assertTrue(bot.of_type("attack"))

    def test_still_retreats_when_it_can_actually_break_away(self):
        """Hurt with nothing adjacent: retreating is genuinely safe."""
        bot = FakeBot(backpack([]))
        snap = snapshot([me((10, 10), hp=20)], [rat((25, 10))])
        run(avalon.make_farm(cfg()), bot, snap)
        self.assertFalse(bot.of_type("attack"))
        self.assertEqual(bot._farm_state, "RETREAT")

    def test_stacks_while_fighting(self):
        """Stacking sat in the idle branch too, so a pack full of split
        slivers never got merged on a field that always has prey."""
        bot = FakeBot(backpack([item("gold", 9, "g-a"), item("gold", 2, "g-b")]))
        snap = snapshot([me((10, 10))], [rat((16, 10))])
        run(avalon.make_farm(cfg(cook=False)), bot, snap)
        self.assertEqual(bot.of_type("moveItem")[0]["instanceId"], "g-b")

    def test_cooks_while_fighting(self):
        bot = FakeBot(backpack([item("rawMeat", 2, "raw1")]))
        snap = snapshot([me((10, 10))], [rat((16, 10))])
        run(avalon.make_farm(cfg()), bot, snap)
        self.assertEqual(bot.of_type("useItem")[0]["instanceId"], "raw1")

    def test_loots_nearby_corpse_before_chasing_the_next_rat(self):
        """He left every corpse behind because loot sat behind the fight
        branch and there was always another rat to chase."""
        bot = FakeBot(backpack([]))
        snap = snapshot([me((10, 10))],
                        [rat((20, 10))],          # next rat, 10 tiles away
                        ground=[corpse((10, 10),
                                       contents=[item("gold", 3, "l1")])])
        run(avalon.make_farm(cfg()), bot, snap)
        self.assertEqual(bot.of_type("moveItem")[0]["instanceId"], "l1")

    def test_melee_target_still_beats_looting(self):
        """Don't stop mid-swing to pick things up."""
        bot = FakeBot(backpack([]))
        snap = snapshot([me((10, 10))], [rat((10, 10))],
                        ground=[corpse((10, 10),
                                       contents=[item("gold", 3, "l1")])])
        run(avalon.make_farm(cfg()), bot, snap)
        self.assertTrue(bot.of_type("attack"))
        self.assertFalse(bot.of_type("moveItem"))

    def test_distant_loot_does_not_distract_from_a_close_monster(self):
        bot = FakeBot(backpack([]))
        snap = snapshot([me((10, 10))], [rat((12, 10))],
                        ground=[corpse((40, 40),
                                       contents=[item("gold", 3, "l1")])])
        run(avalon.make_farm(cfg()), bot, snap)
        self.assertFalse(bot.of_type("moveItem"))


class TestDepth(unittest.TestCase):
    """Descending to an underground floor and escaping back up.

    The safety property these pin down: every down-hole has a matching
    up-ladder on the SAME tile, so the way out is always where he landed.
    """

    HOLE = (58, 22)     # the z=0 hole -> z=-1 (a 'walk' hole)

    def test_surface_hole_has_a_return_ladder_on_the_same_tile(self):
        import avalon_nav as nav
        down = next(t for t in nav.teleports(0)
                    if tuple(t["fromTile"]) == self.HOLE)
        self.assertEqual(down["toZ"], -1)
        self.assertEqual(down["mode"], "walk")
        up = nav.nearest_upward_teleport(-1, self.HOLE)
        self.assertEqual(tuple(up["fromTile"]), self.HOLE)
        self.assertEqual(up["toZ"], 0)
        self.assertEqual(up["mode"], "interact")

    def test_every_underground_floor_has_a_way_up(self):
        """No floor we can reach may be a one-way trip."""
        import avalon_nav as nav
        for z in (-1, -2, -3, -4, -5, -6):
            self.assertIsNotNone(nav.nearest_upward_teleport(z, (50, 50)),
                                 f"z={z} has no up-teleport")

    def test_walks_toward_the_named_entry_hole(self):
        bot = FakeBot(backpack([]))
        bot.z = 0
        snap = snapshot([me((50, 30))], [])
        run(avalon.make_farm(cfg(depth=-1, entry_tile=self.HOLE)), bot, snap)
        self.assertTrue(bot.of_type("move"))
        self.assertEqual(bot._farm_state, "DESCEND")

    def test_stops_descending_once_on_target_floor(self):
        bot = FakeBot(backpack([]))
        bot.z = -1
        snap = snapshot([me((58, 22))], [rat((58, 22), mtype="caveBat")])
        run(avalon.make_farm(cfg(depth=-1, hunt_types=None)), bot, snap)
        self.assertTrue(bot.of_type("attack"))   # farms, doesn't keep diving

    def test_hurt_underground_climbs_out_instead_of_fleeing_sideways(self):
        bot = FakeBot(backpack([]))
        bot.z = -1
        snap = snapshot([me((58, 22), hp=20)],
                        [rat((59, 22), mtype="caveBat")])
        run(avalon.make_farm(cfg(depth=-1)), bot, snap)
        self.assertEqual(bot._farm_state, "ESCAPE")

    def test_escape_uses_the_ladder_when_standing_on_it(self):
        bot = FakeBot(backpack([]))
        bot.z = -1
        snap = snapshot([me(self.HOLE, hp=20)], [])
        run(avalon.make_farm(cfg(depth=-1)), bot, snap)
        self.assertIn("useTeleport", bot.kinds())

    def test_on_the_surface_hurt_still_goes_to_the_healer(self):
        """Escape is an underground-only behaviour."""
        aldric = {"id": "n1", "npcType": "healer", "name": "Brother Aldric",
                  "x": px(20), "y": px(10), "z": 0}
        bot = FakeBot(backpack([]))
        bot.z = 0
        snap = snapshot([me((10, 10), hp=20)], [], npcs=[aldric])
        run(avalon.make_farm(cfg(depth=-1)), bot, snap)
        self.assertEqual(bot._farm_state, "RETREAT")

    def test_does_not_descend_while_fleeing(self):
        """Never dive on the way out of a fight we barely survived."""
        bot = FakeBot(backpack([]))
        bot.z = 0
        snap = snapshot([me((50, 30), hp=20)], [])
        run(avalon.make_farm(cfg(depth=-1, entry_tile=self.HOLE,
                                 healer_name=None)), bot, snap)
        self.assertNotEqual(bot._farm_state, "DESCEND")


class TestRoaming(unittest.TestCase):
    def test_roams_when_nothing_to_do(self):
        bot = FakeBot(backpack([]))
        snap = snapshot([me()], [])
        run(avalon.make_farm(cfg(cook=False, stack=False)), bot, snap)
        self.assertTrue(bot.of_type("move"))
        self.assertIsNotNone(bot._farm_roam_goal)

    def test_roam_goal_is_stable_between_ticks(self):
        bot = FakeBot(backpack([]))
        intent = avalon.make_farm(cfg(cook=False, stack=False))
        run(intent, bot, snapshot([me()], []))
        first = bot._farm_roam_goal
        run(intent, bot, snapshot([me()], []))
        self.assertEqual(first, bot._farm_roam_goal)


class TestGroundItemCaching(unittest.TestCase):
    """The server only re-sends groundItems when the revision changes; a None
    means 'unchanged', not 'the floor is empty'."""

    def test_none_means_unchanged_not_empty(self):
        bot = ab.AvalonBot("s", "c")
        bot.ground_items = [drop()]
        snap = {"groundItems": None}
        if snap["groundItems"] is None:
            snap["groundItems"] = bot.ground_items
        self.assertEqual(len(snap["groundItems"]), 1)

    def test_pack_space_counts_free_slots(self):
        bot = FakeBot(backpack([item("gold", 1, "g")], cap=8))
        self.assertEqual(bot.pack_space(), (7, 8))

    def test_pack_space_with_no_backpack(self):
        self.assertEqual(FakeBot({}).pack_space(), (0, 0))


if __name__ == "__main__":
    unittest.main(verbosity=2)
