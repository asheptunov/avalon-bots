#!/usr/bin/env python3
"""Extract the static collision maps from the Avalon client bundle.

The web client hardcodes every zone as an ASCII grid (`ui=[{z,widthTiles,
heightTiles,rows:[...]},...]` in the minified JS): each `rows` entry is one map
row, where '#' marks a blocked/wall tile and any other char is walkable floor.
That IS the collision map the client pathfinds over -- there's no separate asset
to download and no server round-trip. We pull it straight out of the bundle and
write a compact JSON our bot loads for A* navigation.

Usage:
    python extract_maps.py [bundle.js] [out.json]
Defaults: fetch the live bundle, write avalon_maps.json next to this file.
"""
import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
INDEX_URL = "https://avalon.juanandresleon.com/"
BUNDLE_HINT = "/assets/index-"


def fetch(url):
    with urllib.request.urlopen(url, timeout=20) as r:
        return r.read().decode("utf-8", "replace")


def live_bundle_path():
    """The bundle path index.html currently points at, e.g.
    '/assets/index-B5ZZen4-.js'. The filename hash changes on every deploy, so
    it doubles as a version stamp for the maps we extract from it."""
    idx = fetch(INDEX_URL)
    m = re.search(r'src="(/assets/index-[^"]+\.js)"', idx)
    if not m:
        raise RuntimeError("could not find main JS bundle in index.html")
    return m.group(1)


def get_bundle_text(arg):
    if arg and os.path.exists(arg):
        return open(arg, encoding="utf-8", errors="replace").read()
    return fetch(INDEX_URL.rstrip("/") + live_bundle_path())


def match_bracket(s, open_at, opener="[", closer="]"):
    depth = 0
    for j in range(open_at, len(s)):
        if s[j] == opener:
            depth += 1
        elif s[j] == closer:
            depth -= 1
            if depth == 0:
                return j + 1
    raise ValueError("unbalanced bracket")


def parse_rows(arr_literal):
    """arr_literal is the [...] for a rows array of plain double-quoted strings
    (ASCII map chars, no escapes). Split without regex to avoid pathological
    backtracking on 100+ long lines."""
    inner = arr_literal[arr_literal.index("[") + 1: arr_literal.rindex("]")]
    rows = []
    i = 0
    n = len(inner)
    while i < n:
        if inner[i] == '"':
            j = inner.index('"', i + 1)
            rows.append(inner[i + 1:j])
            i = j + 1
        else:
            i += 1
    return rows


# Surface (z=0) holes are hardcoded in the client (the `pa` list, all mode:"walk"
# -> z=-1) rather than living in a `teleports` array like the underground floors.
# Their coords are literal in the bundle (oa,ia,... = {tx,ty}); resolved here.
# Each descends to z=-1 at the same tile (client sets toTile=fromTile for holes).
SURFACE_HOLES = [(58, 22), (20, 78), (101, 8), (103, 101), (82, 99), (62, 99)]


def _parse_teleports(lit):
    """Parse a `[{tileX:..,tileY:..,toTileX:..,toTileY:..,toZ:..,oneWay:!0/!1,
    mode:"walk"/"interact"},...]` array literal into a list of dicts."""
    out = []
    for tm in re.finditer(
            r'\{tileX:(-?\d+),tileY:(-?\d+),toTileX:(-?\d+),toTileY:(-?\d+),'
            r'toZ:(-?\d+),oneWay:!(\d),mode:"(walk|interact)"\}', lit):
        out.append({
            "fromTile": [int(tm.group(1)), int(tm.group(2))],
            "toTile": [int(tm.group(3)), int(tm.group(4))],
            "toZ": int(tm.group(5)),
            "oneWay": tm.group(6) == "0",      # !0 == true, !1 == false
            "mode": tm.group(7),               # walk = hole, interact = ladder
        })
    return out


def extract(js):
    # The zone table is an array of {z,widthTiles,heightTiles,rows,teleports}.
    # Its variable name has changed across bundle builds (was `const ui=`), so
    # anchor on the array shape itself: the first `[{z:<int>,widthTiles:`.
    m = re.search(r"\[\{z:-?\d+,widthTiles:", js)
    if not m:
        sys.exit("zone table not found in bundle (layout changed?)")
    start = m.start()
    end = match_bracket(js, start)
    lit = js[start:end]

    zones = {}
    for zm in re.finditer(
            r"\{z:(-?\d+),widthTiles:(\d+),heightTiles:(\d+),rows:", lit):
        z = int(zm.group(1))
        w = int(zm.group(2))
        h = int(zm.group(3))
        rows_open = lit.index("[", zm.end())
        rows_end = match_bracket(lit, rows_open)
        rows = parse_rows(lit[rows_open:rows_end])
        if len(rows) != h:
            print(f"  warn: z={z} parsed {len(rows)} rows, header says {h}",
                  file=sys.stderr)
        # Teleports for this zone (if any) follow the rows array before the next
        # zone. Slice from rows_end to the next `{z:` (or the array end).
        nxt = lit.find("{z:", zm.end())
        seg = lit[rows_end: nxt if nxt >= 0 else len(lit)]
        tp = []
        tm = re.search(r"teleports:\[", seg)
        if tm:
            tp_open = seg.index("[", tm.start())
            tp_end = match_bracket(seg, tp_open)
            tp = _parse_teleports(seg[tp_open:tp_end])
        zones[z] = {"widthTiles": w, "heightTiles": h, "rows": rows,
                    "teleports": tp}
    return zones


def extract_z0(bundle_path):
    """z=0 (surface) is procedurally generated in the client, not stored as
    ASCII rows -- so we run the client's OWN generator headless via Node (see
    extract_z0.js) to get a bit-exact grid instead of re-porting seeded noise."""
    import subprocess
    script = os.path.join(HERE, "extract_z0.js")
    if not os.path.exists(script):
        print("  warn: extract_z0.js missing; skipping z=0", file=sys.stderr)
        return None
    try:
        out = subprocess.run(["node", script, bundle_path],
                             capture_output=True, text=True, timeout=60)
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        print(f"  warn: node z=0 extract failed ({e}); skipping z=0", file=sys.stderr)
        return None
    if out.returncode != 0:
        print(f"  warn: z=0 extract exit {out.returncode}: {out.stderr.strip()}",
              file=sys.stderr)
        return None
    zn = json.loads(out.stdout)
    return zn


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else None
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "avalon_maps.json")
    js = get_bundle_text(src)

    # The Node z=0 extractor needs the bundle as a file; persist it if we fetched.
    bundle_path = src if (src and os.path.exists(src)) else os.path.join(HERE, "_bundle.js")
    if bundle_path != src:
        open(bundle_path, "w", encoding="utf-8").write(js)

    zones = extract(js)                       # underground z=-1..-6 (ASCII+teleports)
    z0 = extract_z0(bundle_path)              # surface z=0 (procedural -> Node)
    if z0:
        # Surface holes (all walk-over -> z=-1) are hardcoded, not in a teleports
        # array; synthesize them so escorts can descend from the surface.
        z0_tp = [{"fromTile": [tx, ty], "toTile": [tx, ty], "toZ": -1,
                  "oneWay": False, "mode": "walk"} for (tx, ty) in SURFACE_HOLES]
        zones[0] = {"widthTiles": z0["widthTiles"],
                    "heightTiles": z0["heightTiles"], "rows": z0["rows"],
                    "teleports": z0_tp}

    # Stamp which bundle these maps came from. The filename hash changes on
    # every deploy, so this is what lets the bot notice its maps are stale
    # instead of silently pathing through a tree that moved.
    try:
        zones["bundle"] = src if (src and os.path.exists(src)) else live_bundle_path()
    except Exception as e:                     # offline: keep the maps usable
        print(f"  warn: could not stamp bundle version: {e}", file=sys.stderr)

    with open(out, "w", encoding="utf-8") as f:
        json.dump(zones, f)
    zones.pop("bundle", None)
    for z in sorted(zones, key=int):
        zn = zones[z]
        blocked = sum(row.count("#") for row in zn["rows"])
        tot = zn["widthTiles"] * zn["heightTiles"]
        ntp = len(zn.get("teleports", []))
        print(f"z={z}: {zn['widthTiles']}x{zn['heightTiles']}  "
              f"blocked={blocked}/{tot} ({100*blocked/tot:.0f}%)  teleports={ntp}")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
