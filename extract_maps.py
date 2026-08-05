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


def get_bundle_text(arg):
    if arg and os.path.exists(arg):
        return open(arg, encoding="utf-8", errors="replace").read()
    idx = fetch(INDEX_URL)
    m = re.search(r'src="(/assets/index-[^"]+\.js)"', idx)
    if not m:
        sys.exit("could not find main JS bundle in index.html")
    return fetch(INDEX_URL.rstrip("/") + m.group(1))


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


def extract(js):
    i = js.find("const ui=[{z:")
    if i < 0:
        sys.exit("zone table `ui` not found in bundle")
    start = js.index("[", i)
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
        zones[z] = {"widthTiles": w, "heightTiles": h, "rows": rows}
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

    zones = extract(js)                       # underground z=-1..-6 (ASCII rows)
    z0 = extract_z0(bundle_path)              # surface z=0 (procedural -> Node)
    if z0:
        zones[0] = {"widthTiles": z0["widthTiles"],
                    "heightTiles": z0["heightTiles"], "rows": z0["rows"]}

    with open(out, "w", encoding="utf-8") as f:
        json.dump(zones, f)
    for z in sorted(zones, key=int):
        zn = zones[z]
        blocked = sum(row.count("#") for row in zn["rows"])
        tot = zn["widthTiles"] * zn["heightTiles"]
        print(f"z={z}: {zn['widthTiles']}x{zn['heightTiles']}  "
              f"blocked={blocked}/{tot} ({100*blocked/tot:.0f}%)")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
