#!/usr/bin/env python3
"""Generate a Dunder Mifflin (The Office) styled office.tmj — iconic zones:
Michael's corner office, conference room, the open bullpen with desk pods,
accounting nook, the annex, reception, kitchen/break area, warehouse corner.

Furniture is composed by copying multi-tile "stamps" out of the original
hand-authored map (original-office.tmj) so every sprite is known-good, then
re-placing them into a show-accurate layout. Walls/floor/collision are
regenerated. Run:  python3 tools/mapgen/build_map.py
"""
import json, os, copy

HERE = os.path.dirname(__file__)
ASSETS = os.path.abspath(os.path.join(HERE, '..', '..', 'src', 'renderer', 'src', 'assets'))
MAPS = os.path.join(ASSETS, 'maps')
SRC = os.path.join(HERE, 'original-office.tmj')   # pristine copy of the original
OUT = os.path.join(MAPS, 'office.tmj')

FLIP_V = 0x40000000
GID_MASK = 0x1FFFFFFF
CHAIR_GIDS = {289, 305}                      # walkable furniture (the seat)

NEW_W, NEW_H = 34, 22
TS = 16

# ── source map ────────────────────────────────────────────────────────────────
with open(SRC) as _f:
    src = json.load(_f)
SW = src['width']
SLAYERS = {l['name']: l['data'] for l in src['layers'] if 'data' in l}
FURN = ['furniture-below', 'furniture-above']

def copy_stamp(x0, y0, w, h, seat=None, layers=None):
    """Pull furniture tiles from src rect → portable stamp."""
    tiles = []
    for layer in (layers or FURN):
        d = SLAYERS[layer]
        for dr in range(h):
            for dc in range(w):
                raw = d[(y0 + dr) * SW + (x0 + dc)]
                if raw:
                    tiles.append((layer, dc, dr, raw))
    return {'w': w, 'h': h, 'seat': seat, 'tiles': tiles}

# Stamp library (rects in the ORIGINAL 28x21 map).
# Every agent desk is the same forward-facing workstation (monitor north, the
# agent seated facing it) — laid out on a uniform grid.
PC      = copy_stamp(19, 4, 3, 4, seat=(1, 2))   # workstation, agent faces UP
EXEC    = copy_stamp(3, 5, 3, 4, seat=(1, 0))    # boss desk, faces DOWN (desk to south)
CONF    = copy_stamp(3, 15, 7, 4)                 # long conference table
KITCHEN = copy_stamp(10, 1, 6, 3)                 # fridge / counter / windows
COPIER  = copy_stamp(16, 15, 3, 4)                # photocopier
BOXES   = copy_stamp(19, 17, 2, 3)                # warehouse box stack
COFFEE  = copy_stamp(10, 1, 2, 2, layers=['furniture-above'])  # water/coffee station
PLANT2  = copy_stamp(3, 1, 1, 2)                  # barrel/plant
WINDOW  = copy_stamp(5, 1, 2, 2)                  # window w/ curtains (furniture-above)
COOLER  = copy_stamp(25, 1, 2, 3)                 # water cooler / clock

# ── blank new layers ──────────────────────────────────────────────────────────
def blank():
    return [0] * (NEW_W * NEW_H)

floor   = blank()
walls   = blank()
fb      = blank()   # furniture-below
fa      = blank()
coll    = blank()

def idx(x, y):
    return y * NEW_W + x

def setw(layer, x, y, gid):
    if 0 <= x < NEW_W and 0 <= y < NEW_H:
        layer[idx(x, y)] = gid

# ── floor (green checker, matches original) ───────────────────────────────────
for y in range(3, NEW_H - 1):
    for x in range(1, NEW_W - 1):
        base = 799 if y % 2 == 0 else 783
        setw(floor, x, y, base + (0 if x % 2 == 1 else 1))

# ── outer shell ───────────────────────────────────────────────────────────────
TOP_CAP, TOP_FACE, TOP_BASE = 522, 554, 570
L, R = 530, 533
for x in range(1, NEW_W - 1):
    setw(walls, x, 0, TOP_CAP); setw(walls, x, 1, TOP_FACE); setw(walls, x, 2, TOP_BASE)
setw(walls, 0, 0, 514); setw(walls, NEW_W - 1, 0, 517)
for y in range(1, NEW_H - 1):
    setw(walls, 0, y, L); setw(walls, NEW_W - 1, y, R)
# bottom
for x in range(1, NEW_W - 1):
    setw(walls, x, NEW_H - 1, 579)
setw(walls, 0, NEW_H - 1, 578); setw(walls, NEW_W - 1, NEW_H - 1, 581)

# ── interior wall helpers ─────────────────────────────────────────────────────
def vwall(col, r0, r1, doors=()):           # thin vertical wall
    for r in range(r0, r1 + 1):
        if r in doors:
            continue
        setw(walls, col, r, 611 if r == r0 else 643)

def hwall(row, c0, c1, doors=()):           # 3-row south-facing wall (room above)
    for c in range(c0, c1 + 1):
        if c in doors:
            continue
        setw(walls, c, row, TOP_CAP)
        setw(walls, c, row + 1, TOP_FACE)
        setw(walls, c, row + 2, TOP_BASE)

# ── place a furniture stamp; returns the seat tile (gx,gy) if any ─────────────
PLACED_SEATS = []
def place(stamp, gx, gy):
    for (layer, dc, dr, raw) in stamp['tiles']:
        tgt = fb if layer == 'furniture-below' else fa
        setw(tgt, gx + dc, gy + dr, raw)
    if stamp['seat'] is not None:
        s = (gx + stamp['seat'][0], gy + stamp['seat'][1])
        PLACED_SEATS.append(s)
        return s
    return None

# ══ ROOMS ════════════════════════════════════════════════════════════════════
# Michael's office (top-left). Interior cols 1-6 rows 3-7.
vwall(7, 3, 10, doors=(5,))
hwall(8, 1, 7, doors=(5,))                       # south door into the floor
michael = place(EXEC, 2, 4)                     # boss desk, faces room (down)
place(PLANT2, 1, 3)
place(WINDOW, 2, 1)

# Conference room (top-center). Interior cols 9-17 rows 3-7.
vwall(8, 3, 10, doors=(5,))
vwall(18, 3, 10, doors=(6,))
hwall(8, 8, 18, doors=(13,))
place(CONF, 10, 3)
place(WINDOW, 10, 1); place(WINDOW, 14, 1)

# Annex (top-right). Interior cols 26-32 rows 3-8. Ryan / Kelly / Toby.
# Door is on the SOUTH wall so the front-bay desks can't block its approach.
vwall(25, 3, 11)
hwall(9, 25, 32, doors=(26,))
annex = [place(PC, 26, 3), place(PC, 29, 3)]     # desks up top, aisle below
place(COOLER, 31, 1)

# ══ OPEN FLOOR FURNITURE ═════════════════════════════════════════════════════
# Bullpen — a uniform grid of identical forward-facing desks. Each desk is 3
# tiles wide with a 1-tile aisle between columns and a wide aisle between the
# two rows, so every workstation is evenly spaced and reachable.
GRID_COLS = [2, 6, 10, 14, 18, 22]   # seat x (desks span x-1..x+1, aisles between)
GRID_ROWS = [13, 18]                 # seat y (monitor above, chair below)
grid = []
for sr in GRID_ROWS:
    for sc in GRID_COLS:
        grid.append(place(PC, sc - 1, sr - 2))

# Back-office pair in the front bay (between conference and annex).
bay = [place(PC, 19, 5), place(PC, 22, 5)]

# Kitchen / break area (bottom-right, open against the wall).
place(KITCHEN, 26, 17)

# Warehouse corner decor (bottom-right).
place(COPIER, 30, 11)
place(BOXES, 31, 18)

# Decor / breathing room in the open floor.
place(COFFEE, 25, 13)      # coffee station by the kitchen walkway

# ══ COLLISION ════════════════════════════════════════════════════════════════
for y in range(NEW_H):
    for x in range(NEW_W):
        solid = False
        if walls[idx(x, y)]:
            solid = True
        for fl in (fb, fa):
            g = fl[idx(x, y)] & GID_MASK
            if g and g not in CHAIR_GIDS:
                solid = True
        if solid:
            setw(coll, x, y, 1)
# bottom entrance door (aligned with the central aisle at col 16)
for x in (16,):
    setw(coll, x, NEW_H - 1, 0)
    setw(walls, x, NEW_H - 1, 0)
# force seat tiles walkable
for (sx, sy) in PLACED_SEATS:
    setw(coll, sx, sy, 0)

# ── spawn points (claim order set in OfficeFloor) ─────────────────────────────
def pt(name, tile):
    return {'id': 0, 'name': name, 'type': '', 'x': tile[0] * TS, 'y': tile[1] * TS,
            'width': 0, 'height': 0, 'rotation': 0, 'visible': True, 'point': True}

SEATS = {
    'desk-ceo': michael,
    # bullpen grid — front row then back row, left → right
    'pc-1': grid[0], 'pc-2': grid[1], 'pc-3': grid[2],
    'pc-4': grid[3], 'pc-5': grid[4], 'pc-6': grid[5],
    'desk-team-lead': grid[6], 'desk-backend-engineer': grid[7],
    'desk-product-manager': grid[8], 'desk-data-engineer': grid[9],
    'desk-project-manager': grid[10], 'desk-market-researcher': grid[11],
    # front-bay back office + annex
    'desk-agent-organizer': bay[0], 'warroom-seat': bay[1],
    'desk-chief-architect': annex[0], 'desk-ui-ux-expert': annex[1],
}
spawn_objs = [pt(n, t) for n, t in SEATS.items()]
spawn_objs.append(pt('entrance', (16, 20)))

zones = [
    {'id': 0, 'name': 'boardroom', 'type': '', 'x': 9 * TS, 'y': 3 * TS,
     'width': 9 * TS, 'height': 5 * TS, 'rotation': 0, 'visible': True},
    {'id': 0, 'name': 'open-work-area', 'type': '', 'x': 1 * TS, 'y': 11 * TS,
     'width': 23 * TS, 'height': 9 * TS, 'rotation': 0, 'visible': True},
]

# ── assemble & write ──────────────────────────────────────────────────────────
def tilelayer(name, data, lid):
    return {'data': data, 'height': NEW_H, 'id': lid, 'name': name, 'opacity': 1,
            'type': 'tilelayer', 'visible': True, 'width': NEW_W, 'x': 0, 'y': 0}

def objlayer(name, objs, lid):
    return {'draworder': 'topdown', 'id': lid, 'name': name, 'objects': objs,
            'opacity': 1, 'type': 'objectgroup', 'visible': True, 'x': 0, 'y': 0}

out = copy.deepcopy(src)
out['width'] = NEW_W
out['height'] = NEW_H
out['layers'] = [
    tilelayer('floor', floor, 1),
    tilelayer('walls', walls, 2),
    tilelayer('furniture-below', fb, 3),
    tilelayer('furniture-above', fa, 4),
    tilelayer('collision', coll, 5),
    objlayer('spawn-points', spawn_objs, 6),
    objlayer('zones', zones, 7),
]
out['nextlayerid'] = 8
out['nextobjectid'] = 1

with open(OUT, 'w') as _f:
    json.dump(out, _f, indent=1)
print('wrote', OUT, f'{NEW_W}x{NEW_H}, {len(PLACED_SEATS)} seats')
