// Item facts, extracted from the game client: what a thing WEIGHS and how good
// it is. Both are things the server never tells us and the farm loop has to
// know, because "the pack is full" is a question about weight and "which of
// these do I throw away" is a question about worth.
//
// Until this existed the bot's only answer to a full pack was to walk to the
// depot. That is the right move when the pack is full of things worth keeping
// and the wrong one when it is full of shabby shirts: a cross-town round trip to
// bank 8oz of rags is most of a minute of not farming, and the bot did it over
// and over. Knowing what each item weighs and roughly what tier it is turns that
// into a decision -- drop the rags, keep killing, and save the trip for a haul
// that deserves one.
//
// Everything here is READ FROM THE BUNDLE, matched by structure and never by
// minified name, for the same reason maps.js is: the minifier renames every
// symbol on each deploy (`iy`, `_y` and `Ty` today are three other names next
// week), so a name-matched table breaks silently the first time the game ships.
// A structural anchor -- "the object literal whose first key is `dagger` and
// whose values are numbers" -- survives renaming, and there is exactly one of
// each in the bundle.
//
// The BAKED tables below are the fallback, generated from the live bundle at
// the time of writing, exactly like `maps.json`. Extraction is preferred at
// runtime; the baked copy is what keeps the bot working on the tick where the
// extraction regex meets a bundle it does not recognise. It fails loudly (a log
// line) rather than silently, because a stale weight table makes drop decisions
// that look arbitrary rather than broken.

// ---- baked fallbacks ------------------------------------------------------

/** Item weight in ounces, from the client's own table. */
export const ITEM_WEIGHT_OZ = {
  dagger: 8, gold: 0.1, crowbar: 30, woodenBow: 22, wraithbow: 20,
  zealotStaff: 30, iceStaff: 24, quiver: 0, shabbyShirt: 8, pocketWatch: 3,
  shortsword: 25, mace: 30, ironSword: 40, shield: 30, helmet: 15,
  leatherArmor: 30, chainmail: 55, leatherLegs: 20, leatherBoots: 14,
  rubyNecklace: 2, silverRing: 1, peridotRing: 1, novasRing: 1,
  quickstepBand: 1, crescentPendant: 2, cleaver: 30, cutlass: 22,
  thiefPants: 12, thiefHood: 6, thiefVest: 14, thiefBoots: 8, plateShield: 38,
  ratKingsCrown: 8, cheese: 2, apple: 1, fish: 2, iceCream: 2,
  smithingHammer: 22, emberOre: 12, tchallaClaws: 18, shuriPawboots: 12,
  avocado: 1, rawMeat: 3, cookedMeat: 2, healthPotion: 1,
  largeHealthPotion: 2, manaPotion: 1, largeManaPotion: 2, studdedArmor: 42,
  plateArmor: 72, steelHelmet: 22, ironShield: 34, iceShield: 40,
  plateLegs: 28, plateBoots: 24, spikeshellHelm: 30, magicianHat: 6,
  magicianRobe: 16, magicianPants: 9, magicianBoots: 4, ghostblade: 35,
  scaleArmor: 40, warspear: 32, ashscaleMace: 45, hellbow: 22,
  gildedAegis: 50, rubyStaff: 28, garnetNecklace: 2, jadeNecklace: 2,
  sapphireNecklace: 2, onyxNecklace: 2, torch: 12, backpack: 5,
  largeBackpack: 7, adventurersBackpack: 4, corpse: 0, playerBody: 0, depot: 0,
};

/**
 * The stat an item demands to equip it, e.g. `{str: 13}`.
 *
 * This is the closest thing the client has to a PRICE. There is no shop and no
 * gold value anywhere in the bundle, so "how good is this" has to be inferred,
 * and the requirement is the game's own statement of it: `shortsword` needs
 * str 11, `ironSword` str 13, `ghostblade` str 16, and that ordering is exactly
 * the ordering a player would give those three swords. Gear with no requirement
 * at all (`shabbyShirt`, `helmet`) is starting kit -- the junk this is for.
 */
export const ITEM_REQS = {
  dagger: { dex: 11 }, shortsword: { str: 11 }, mace: { str: 12 },
  ironSword: { str: 13 }, ghostblade: { str: 16 }, woodenBow: { dex: 12 },
  wraithbow: { dex: 15 }, tchallaClaws: { dex: 16 }, zealotStaff: { int: 15 },
  iceStaff: { int: 12 }, chainmail: { str: 12 }, plateArmor: { str: 16 },
  plateLegs: { str: 14 }, plateBoots: { str: 13 }, spikeshellHelm: { str: 13 },
  magicianHat: { int: 12 }, magicianRobe: { int: 14 },
  magicianPants: { int: 12 }, magicianBoots: { int: 11 },
  steelHelmet: { str: 12 }, ironShield: { str: 10 }, plateShield: { str: 12 },
  iceShield: { str: 13 }, studdedArmor: { dex: 12 }, scaleArmor: { dex: 14 },
  warspear: { str: 12, dex: 14 }, ashscaleMace: { str: 15 },
  hellbow: { dex: 17 }, gildedAegis: { str: 15 }, rubyStaff: { int: 18 },
};

/**
 * Which equipment slot an item goes in, or null for anything you cannot wear.
 *
 * This is what makes the tier test safe to apply. "No equip requirement" is a
 * good proxy for "low-tier gear" and a terrible one for everything else: it is
 * equally true of `emberOre`, which is crafting material worth carrying home,
 * and of `ratKingsCrown`, which is a trophy. Both would have been thrown on the
 * floor by a rule that only read the requirement table.
 *
 * So the junk test asks this table FIRST -- only a wearable thing is eligible
 * to be judged by what it takes to wear it. A `null` slot means the item's worth
 * is expressed some other way, and we leave it alone.
 */
export const ITEM_SLOT = {
  dagger: 'hand', gold: null, crowbar: 'hand', woodenBow: 'hand',
  wraithbow: 'hand', zealotStaff: 'hand', iceStaff: 'hand', quiver: 'hand',
  shabbyShirt: 'chest', pocketWatch: 'accessory', shortsword: 'hand',
  mace: 'hand', ironSword: 'hand', shield: 'hand', helmet: 'head',
  leatherArmor: 'chest', chainmail: 'chest', leatherLegs: 'legs',
  leatherBoots: 'feet', rubyNecklace: 'necklace', silverRing: 'ring',
  peridotRing: 'ring', novasRing: 'ring', quickstepBand: 'ring',
  crescentPendant: 'necklace', cleaver: 'hand', cutlass: 'hand',
  thiefPants: 'legs', thiefHood: 'head', thiefVest: 'chest',
  thiefBoots: 'feet', plateShield: 'hand', ratKingsCrown: null, cheese: null,
  apple: null, fish: null, iceCream: null, emberOre: null,
  smithingHammer: 'hand', tchallaClaws: 'hand', shuriPawboots: 'feet',
  avocado: null, rawMeat: null, cookedMeat: null, healthPotion: null,
  largeHealthPotion: null, manaPotion: null, largeManaPotion: null,
  studdedArmor: 'chest', plateArmor: 'chest', steelHelmet: 'head',
  ironShield: 'hand', iceShield: 'hand', plateLegs: 'legs',
  plateBoots: 'feet', spikeshellHelm: 'head', magicianHat: 'head',
  magicianRobe: 'chest', magicianPants: 'legs', magicianBoots: 'feet',
  ghostblade: 'hand', scaleArmor: 'chest', warspear: 'hand',
  ashscaleMace: 'hand', hellbow: 'hand', gildedAegis: 'hand',
  rubyStaff: 'hand', garnetNecklace: 'necklace', jadeNecklace: 'necklace',
  sapphireNecklace: 'necklace', onyxNecklace: 'necklace', torch: 'hand',
  backpack: 'backpack', largeBackpack: 'backpack',
  adventurersBackpack: 'backpack', corpse: null, playerBody: null, depot: null,
};

// Live tables, swapped in by `loadItems`. Kept as module state (rather than
// threaded through every call) to match how nav.js holds the collision maps:
// the callers are deep in the farm loop and there is exactly one game.
let weights = ITEM_WEIGHT_OZ;
let reqs = ITEM_REQS;
let slots = ITEM_SLOT;

// ---- extraction -----------------------------------------------------------

/**
 * Parse one flat `{key:number, ...}` object literal at `at`.
 *
 * Hand-rolled rather than `JSON.parse` because these are minified JS literals,
 * not JSON: keys are bare and numbers come through as `.1` rather than `0.1`.
 */
function parseNumberTable(js, at) {
  const end = js.indexOf('}', at);
  if (end < 0) return null;
  const out = {};
  for (const m of js.slice(at, end).matchAll(/([A-Za-z_$][\w$]*):(-?\d*\.?\d+)/g)) {
    out[m[1]] = Number(m[2]);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The item weight table, or null when the bundle no longer contains one we
 * recognise.
 *
 * Anchored on `dagger:` followed by a bare number and then more `key:number`
 * pairs -- the weight table is the only flat number map in the bundle that
 * starts at `dagger`, and `gold:.1` right after it is a fingerprint no other
 * table shares. Deliberately NOT anchored on `iy=`, which is this week's name.
 */
export function extractWeights(js) {
  const m = /\{dagger:\d+(?:\.\d+)?,gold:\.?\d/.exec(js);
  return m ? parseNumberTable(js, m.index) : null;
}

/**
 * The equip-requirement table, or null.
 *
 * TWO tables in the bundle open with `dagger:{dex:N}` and telling them apart is
 * the whole difficulty here. The other one is the stat BONUS an item grants
 * (`dagger:{dex:2}`, `shortsword:{str:1}`) -- same shape, same first key,
 * completely different meaning, and reading it as the requirement inverts the
 * ranking: `shortsword` and `plateArmor` both score 1-2 there, so the tier test
 * would call plate armour junk.
 *
 * The anchor is therefore the SECOND key. Requirements are indexed by weapon
 * (`dagger`, then `shortsword`); bonuses run through accessories
 * (`crescentPendant` next). Requirement values are also all >= 10, where bonuses
 * are single digits -- asserted here as a second condition so a bundle that
 * reorders the keys fails to match rather than matching the wrong table.
 */
export function extractReqs(js) {
  const m = /\{dagger:\{(?:str|dex|int):\d\d+\},shortsword:\{(?:str|dex|int):\d\d+\}/
    .exec(js);
  if (!m) return null;
  // Bounded by the first `}}`: the table is one nesting level deep throughout.
  const end = js.indexOf('}}', m.index);
  if (end < 0) return null;
  const out = {};
  const re = /([A-Za-z_$][\w$]*):\{([^}]*)\}/g;
  for (const e of js.slice(m.index, end + 2).matchAll(re)) {
    const stats = {};
    for (const s of e[2].matchAll(/([A-Za-z_$][\w$]*):(\d+)/g)) stats[s[1]] = +s[2];
    if (Object.keys(stats).length) out[e[1]] = stats;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The equip-slot table, or null.
 *
 * Anchored on `dagger:"hand",gold:null` -- the null is the fingerprint. Several
 * tables in the bundle map itemIds to strings (display names, sprite paths,
 * weapon classes); this is the only one whose values include `null`, because it
 * is the only one that has to say "this is not equipment at all".
 */
export function extractSlots(js) {
  const m = /\{dagger:"[a-z]+",gold:null/.exec(js);
  if (!m) return null;
  const end = js.indexOf('}', m.index);
  if (end < 0) return null;
  const out = {};
  const re = /([A-Za-z_$][\w$]*):(?:"([a-z]+)"|null)/g;
  for (const e of js.slice(m.index, end).matchAll(re)) out[e[1]] = e[2] ?? null;
  return Object.keys(out).length ? out : null;
}

/**
 * Install tables extracted from a live bundle, falling back to the baked ones
 * per table.
 *
 * Returns what actually happened so the caller can log it -- a silent fallback
 * to a stale weight table is how "why did it throw away my sword" starts.
 */
export function loadItems(js) {
  const w = js ? extractWeights(js) : null;
  const r = js ? extractReqs(js) : null;
  const s = js ? extractSlots(js) : null;
  weights = w || ITEM_WEIGHT_OZ;
  reqs = r || ITEM_REQS;
  slots = s || ITEM_SLOT;
  return { weights: !!w, reqs: !!r, slots: !!s };
}

/** Reset to the baked tables. Exists for tests. */
export function resetItems() {
  weights = ITEM_WEIGHT_OZ;
  reqs = ITEM_REQS;
  slots = ITEM_SLOT;
}

/** The equipment slot `itemId` goes in, or null if it is not equipment. */
export function equipSlot(itemId) {
  return slots[itemId] ?? null;
}

// ---- what the farm loop asks ----------------------------------------------

/**
 * What one unit of `itemId` weighs, in ounces.
 *
 * Unknown items weigh 0, NOT some guessed average. An item the table has never
 * heard of is one the game just added, and pretending it is heavy would have us
 * throwing away the new thing precisely because it is new.
 */
export function weightOz(itemId, quantity = 1) {
  return (weights[itemId] ?? 0) * (quantity || 1);
}

/**
 * How good `itemId` is, as a single number. Higher is better.
 *
 * The highest stat requirement, because that is the game's own ranking and it
 * needs no table of ours to maintain. Requirement-less gear scores 0, which is
 * what puts starting kit at the bottom of the drop order without naming any of
 * it.
 */
export function itemTier(itemId) {
  const r = reqs[itemId];
  if (!r) return 0;
  let best = 0;
  for (const v of Object.values(r)) if (v > best) best = v;
  return best;
}

// Equipment that is never junk despite having no stat requirement, because its
// worth is not the wearing of it.
//
// A `backpack` is the storage the depot trip depends on -- depot.js goes out of
// its way to stow empty ones, and throwing them on the floor would undo that. A
// `torch` is the only light source underground, and the one in the pack is the
// spare you want when the equipped one is the thing that ran out.
const NEVER_JUNK = new Set([
  'backpack', 'largeBackpack', 'adventurersBackpack', 'torch', 'quiver',
]);

/**
 * True if `itemId` may be thrown on the ground to make room.
 *
 * Deliberately narrow, and narrow in a specific way: junk is WEARABLE gear that
 * the game asks nothing to wear -- starting kit and the drops beneath any
 * character who can reach a cave -- that is heavy enough to be worth the slot it
 * frees.
 *
 * The equippable gate is what keeps this honest. "No stat requirement" reads as
 * "low tier" only for equipment; applied to everything it also catches
 * `emberOre` (crafting material), `ratKingsCrown` (a trophy) and `gold`, none of
 * which the requirement table has any opinion about and all of which are worth
 * carrying home. Asking `equipSlot` first means the tier test is only ever
 * applied to the items it can actually speak to. Everything else -- non-gear,
 * anything the game gates behind a stat, anything on NEVER_JUNK, and anything
 * the table has never heard of -- stays in the bag and rides to the depot.
 *
 * `minOz` is what stops this from being a nuisance: dropping a 3oz pocket watch
 * buys nothing against a 250oz cap and costs a slot's worth of moveItem, so the
 * floor is set where discarding actually changes the answer.
 */
export function isJunk(itemId, minOz = 8) {
  if (NEVER_JUNK.has(itemId)) return false;
  if (!(itemId in weights)) return false;        // unknown: never guess
  if (!equipSlot(itemId)) return false;          // not gear: not ours to judge
  if (itemTier(itemId) > 0) return false;        // the game gates it: keep it
  return weightOz(itemId) >= minOz;
}

/**
 * Sort key for "what do I throw away first". LOWER is discarded sooner.
 *
 * Tier first, weight second and inverted: among equally worthless things the
 * heaviest goes first, because weight is the limit we are actually trying to
 * fix. That ordering is the whole point -- discarding the lightest junk first
 * would need five drops to buy what one plate-weight drop buys.
 */
export function junkRank(itemId) {
  return [itemTier(itemId), -weightOz(itemId)];
}
