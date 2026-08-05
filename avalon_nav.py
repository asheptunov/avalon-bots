"""Grid navigation for Avalon bots: load the extracted collision maps and A*.

The maps come from extract_maps.py (avalon_maps.json): one grid per z-level,
each a list of ASCII rows where '#' is blocked and anything else is walkable.
That grid is bit-exact with what the game server enforces (validated in-game),
so A* over it yields real paths around walls -- no more corner-orbiting.

Coordinates: the server works in pixels; TILE=32. A tile (tx,ty) is walkable
iff grid[z].rows[ty][tx] != '#'. Movement is 8-directional (the client allows
diagonals), so we path on an 8-connected grid.
"""
import heapq
import json
import os

TILE = 32
HERE = os.path.dirname(os.path.abspath(__file__))
_MAPS = None


def load_maps(path=None):
    """Lazy-load avalon_maps.json -> {z:int -> {'w','h','rows'}}. Cached."""
    global _MAPS
    if _MAPS is not None:
        return _MAPS
    path = path or os.path.join(HERE, "avalon_maps.json")
    _MAPS = {}
    if not os.path.exists(path):
        return _MAPS                     # no maps -> callers fall back to greedy
    raw = json.load(open(path, encoding="utf-8"))
    for zk, zn in raw.items():
        _MAPS[int(zk)] = {
            "w": zn["widthTiles"], "h": zn["heightTiles"], "rows": zn["rows"]}
    return _MAPS


def have_map(z):
    return int(z) in load_maps()


def walkable(z, tx, ty):
    m = load_maps().get(int(z))
    if not m:
        return True                      # unknown map -> don't block movement
    if tx < 0 or ty < 0 or tx >= m["w"] or ty >= m["h"]:
        return False
    return m["rows"][ty][tx] != "#"


# 8-connected neighbours; diagonals cost ~sqrt(2).
_NEIGHBORS = [(-1, 0, 1.0), (1, 0, 1.0), (0, -1, 1.0), (0, 1, 1.0),
              (-1, -1, 1.41421356), (1, -1, 1.41421356),
              (-1, 1, 1.41421356), (1, 1, 1.41421356)]


def _nearest_walkable(z, tx, ty, radius=6):
    """If a tile is blocked (e.g. a monster's tile, or a target inside a wall),
    snap to the closest walkable tile within `radius` so A* still has a goal."""
    if walkable(z, tx, ty):
        return tx, ty
    best = None
    for r in range(1, radius + 1):
        for dx in range(-r, r + 1):
            for dy in range(-r, r + 1):
                if max(abs(dx), abs(dy)) != r:
                    continue
                if walkable(z, tx + dx, ty + dy):
                    d = dx * dx + dy * dy
                    if best is None or d < best[0]:
                        best = (d, tx + dx, ty + dy)
        if best:
            return best[1], best[2]
    return None


def find_path(z, start_tile, goal_tile, max_expand=20000):
    """A* on the 8-connected walkability grid. Returns a list of (tx,ty) tiles
    from just-after-start through goal, or [] if unreachable. Diagonals may not
    cut through a wall corner (both orthogonal neighbours must be open)."""
    if not have_map(z):
        return []
    sx, sy = start_tile
    goal = _nearest_walkable(z, *goal_tile)
    if goal is None:
        return []
    gx, gy = goal
    if (sx, sy) == (gx, gy):
        return []

    def h(x, y):
        dx, dy = abs(x - gx), abs(y - gy)
        return (dx + dy) + (1.41421356 - 2) * min(dx, dy)   # octile distance

    openq = [(h(sx, sy), 0.0, sx, sy)]
    came = {}
    gscore = {(sx, sy): 0.0}
    expanded = 0
    while openq:
        _, g, x, y = heapq.heappop(openq)
        if (x, y) == (gx, gy):
            path = [(x, y)]
            while (x, y) in came:
                x, y = came[(x, y)]
                path.append((x, y))
            path.reverse()
            return path[1:]              # drop the start tile
        expanded += 1
        if expanded > max_expand:
            return []
        for dx, dy, cost in _NEIGHBORS:
            nx, ny = x + dx, y + dy
            if not walkable(z, nx, ny):
                continue
            if dx and dy:                # no corner-cutting through walls
                if not (walkable(z, x + dx, y) and walkable(z, x, y + dy)):
                    continue
            ng = g + cost
            if ng < gscore.get((nx, ny), 1e18):
                gscore[(nx, ny)] = ng
                came[(nx, ny)] = (x, y)
                heapq.heappush(openq, (ng + h(nx, ny), ng, nx, ny))
    return []


def _tile(px):
    # The server labels a position by round(px/TILE) (verified: px 2067 -> tile
    # 65). Flooring (px//TILE) disagrees by a tile when straddling a boundary, so
    # we'd plan from the wrong tile and issue a move that clips an adjacent wall,
    # netting zero. round() keeps our tile identity in lockstep with the server.
    return int(round(px / TILE))


def path_step(bot, me, z, goal_px, repath_tiles=3):
    """Return a (dx,dy) in {-1,0,1} that follows an A* path from the bot's tile
    to the goal, caching the path on `bot` and recomputing only when the goal
    moves, we consume the path, or we drift off it. Falls back to a greedy step
    toward the goal when there's no map for this z (so behaviour degrades safely
    on unknown zones). This is the drop-in replacement for the old blind mover.

    goal_px is (x_px, y_px). Diagonal steps are allowed (the client permits them)."""
    gx, gy = _tile(goal_px[0]), _tile(goal_px[1])
    sx, sy = _tile(me["x"]), _tile(me["y"])

    if not have_map(z):
        # No collision data -> greedy sign step (legacy behaviour).
        dx = (goal_px[0] > me["x"]) - (goal_px[0] < me["x"])
        dy = (goal_px[1] > me["y"]) - (goal_px[1] < me["y"])
        return dx, dy

    if (sx, sy) == (gx, gy):
        return 0, 0

    cache = getattr(bot, "_path", None)
    need = (cache is None
            or cache.get("goal") != (gx, gy)
            or not cache.get("tiles"))
    if not need:
        # Off-path? (we got shoved, or a step didn't land) -> repath.
        nxt = cache["tiles"][0]
        if max(abs(sx - nxt[0]), abs(sy - nxt[1])) > repath_tiles:
            need = True

    if need:
        tiles = find_path(z, (sx, sy), (gx, gy))
        cache = {"goal": (gx, gy), "tiles": tiles}
        bot._path = cache

    tiles = cache["tiles"]
    if not tiles:
        return 0, 0                      # unreachable -> hold

    # Advance past the current tile: drop leading tiles until the head is a tile
    # we have NOT yet reached. We only drop the exact current tile (not "nearby")
    # so the head is always the immediate next step -- never a far tile that a
    # sign-step would diagonal into a wall corner toward.
    while tiles and tiles[0] == (sx, sy):
        tiles.pop(0)
    if not tiles:
        return 0, 0

    nx, ny = tiles[0]
    # If the head isn't 8-adjacent (we slid off the path), repath next tick.
    if max(abs(nx - sx), abs(ny - sy)) > 1:
        bot._path = None

    # Steer toward the CENTRE of the next tile in pixel space, not a raw tile
    # sign. When the bot straddles a tile boundary next to a wall corner, a raw
    # sign-step can clip the wall and net zero movement; aiming at the target
    # centre pulls it onto the tile lane first, so it clears the corner. We still
    # emit dx,dy in {-1,0,1} (the only move the protocol has) but computed from
    # sub-tile position -> centre.
    tcx, tcy = nx * TILE, ny * TILE      # server tiles are round(px/TILE)-based
    eps = TILE * 0.2
    dx = (tcx - me["x"] > eps) - (tcx - me["x"] < -eps)
    dy = (tcy - me["y"] > eps) - (tcy - me["y"] < -eps)
    return _safe_step(z, sx, sy, dx, dy)


def _safe_step(z, sx, sy, dx, dy):
    """Never command a move that walks straight into a wall. If the intended
    neighbour is blocked (or a diagonal that clips a wall corner), fall back to
    whichever single-axis component is walkable."""
    if dx == 0 and dy == 0:
        return 0, 0
    if walkable(z, sx + dx, sy + dy) and not (
            dx and dy and not (walkable(z, sx + dx, sy) and walkable(z, sx, sy + dy))):
        return dx, dy
    if dx and walkable(z, sx + dx, sy):
        return dx, 0
    if dy and walkable(z, sx, sy + dy):
        return 0, dy
    return 0, 0
