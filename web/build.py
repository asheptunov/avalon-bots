#!/usr/bin/env python3
"""Bundle web/src/*.js + avalon_maps.json into one Tampermonkey userscript.

No node/npm: the sources are small ES modules with a known, acyclic import
graph, so we concatenate them in dependency order and strip the import/export
keywords. That keeps the toolchain to "python build.py" and the output to a
single file you can paste into Tampermonkey.

The maps are embedded as a JSON literal (~94 KB) because a userscript can't read
a local file and the game's CSP would block fetching one.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, "avalon-farm.user.js")

# Dependency order: each module may only use the ones above it.
MODULES = ["protocol.js", "hook.js", "bot.js", "nav.js", "farm.js", "ui.js", "main.js"]

HEADER = """\
// ==UserScript==
// @name         Avalon Farm Bot
// @namespace    https://github.com/avalon-bot
// @version      {version}
// @description  Drives your on-screen Avalon character: kill / loot / cook / eat / heal.
// @author       you
// @match        https://avalon.juanandresleon.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
"""

VERSION = "0.1.0"

# `export` only ever prefixes a declaration here, so dropping the keyword leaves
# valid top-level code. Imports are dropped entirely: after concatenation every
# binding is already in the same scope.
#
# `export default` is deliberately NOT handled: stripping only the `export`
# would leave a bare `default class ...`, a syntax error. It's rejected loudly
# below instead. The post-build check in main() is the real backstop -- it fails
# the build on ANY surviving import/export, including forms not anticipated here.
IMPORT_RE = re.compile(r"^\s*import\s+[^;]*?;\s*$", re.M | re.S)
DECL = r"(?:async\s+)?(?:class|function|const|let|var)"
EXPORT_RE = re.compile(rf"^export\s+(?={DECL}\b)", re.M)


def strip_module_syntax(src, name):
    src = IMPORT_RE.sub("", src)
    src = EXPORT_RE.sub("", src)
    if re.search(r"^\s*export\s*\{", src, re.M):
        sys.exit(f"{name}: `export {{...}}` lists aren't supported by this bundler; "
                 "use `export` on the declaration itself.")
    if re.search(r"^\s*export\s+default\b", src, re.M):
        sys.exit(f"{name}: `export default` isn't supported by this bundler; "
                 "use a named export.")
    return src.strip()


def exported_names(src):
    """Top-level export names, for rebuilding a namespace object after flattening."""
    return re.findall(rf"^export\s+{DECL}\s+([A-Za-z_$][\w$]*)", src, re.M)


def main():
    maps_path = os.path.join(ROOT, "avalon_maps.json")
    if not os.path.exists(maps_path):
        sys.exit(f"missing {maps_path} -- run extract_maps.py first")
    with open(maps_path, encoding="utf-8") as f:
        maps = json.load(f)

    parts = [HEADER.format(version=VERSION), "\n(function () {\n'use strict';\n"]
    parts.append("const EMBEDDED_MAPS = " + json.dumps(maps, separators=(",", ":")) + ";\n")

    # nav.js is referenced as a namespace (`nav.findPath`). Collect its exported
    # names so we can rebuild that object after flattening.
    nav_names = []
    bodies = []
    for name in MODULES:
        path = os.path.join(SRC, name)
        with open(path, encoding="utf-8") as f:
            raw = f.read()
        if name == "nav.js":
            nav_names = exported_names(raw)
        bodies.append((name, strip_module_syntax(raw, name)))

    for name, body in bodies:
        parts.append(f"\n// ===== {name} " + "=" * (58 - len(name)) + "\n")
        parts.append(body + "\n")
        if name == "nav.js":
            if not nav_names:
                sys.exit("nav.js: found no exports to build the `nav` namespace")
            fields = ", ".join(nav_names)
            parts.append(f"\nconst nav = {{ {fields} }};\n")

    parts.append("\n})();\n")
    out = "".join(parts)

    # Backstop: a userscript is NOT a module, so any surviving import/export is a
    # syntax error -- and one that only shows up when Tampermonkey refuses to run
    # the script, long after a build that printed success. Fail here instead, so
    # every gap in the regexes above (a new `export` form, a missed keyword) is a
    # loud build failure rather than a silent broken install.
    for i, line in enumerate(out.splitlines(), 1):
        if re.match(r"\s*(?:import|export)\b", line):
            sys.exit(f"{OUT}:{i}: module syntax survived bundling -- "
                     f"strip_module_syntax needs to handle it:\n  {line.strip()}")

    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(out)

    kb = os.path.getsize(OUT) / 1024
    print(f"wrote {OUT} ({kb:.0f} KB, maps bundle={maps.get('bundle')})")


if __name__ == "__main__":
    main()
