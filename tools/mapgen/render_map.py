#!/usr/bin/env python3
"""Offline rasterizer for office.tmj — mirrors TiledMapRenderer so we can
visually verify the map without launching Electron. Usage:
    python3 render_map.py [map.tmj] [out.png] [--labels]
"""
import json, sys, os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(__file__)
ASSETS = os.path.abspath(os.path.join(HERE, '..', '..', 'src', 'renderer', 'src', 'assets'))

FLIP_H = 0x80000000
FLIP_V = 0x40000000
FLIP_D = 0x20000000
GID_MASK = 0x1FFFFFFF

# firstgid -> (image path, columns, tilew, tileh)
# NOTE: these firstgid/cols values MUST stay in sync with
# src/renderer/src/scene/office/themeRegistry.ts.
TILESETS = [
    (1,    'tilesets/office-tileset.png',        16, 16, 16),
    (513,  'tilesets/a5-office-floors-walls.png',16, 16, 16),
    (1025, 'tilesets/interiors.png',             16, 16, 16),
]
TILE_LAYERS = ['floor', 'walls', 'furniture-below', 'furniture-above']
SCALE = 3

def load_sheets():
    out = []
    for firstgid, path, cols, tw, th in TILESETS:
        img = Image.open(os.path.join(ASSETS, path)).convert('RGBA')
        out.append((firstgid, img, cols, tw, th))
    return out

def resolve(gid, sheets):
    for firstgid, img, cols, tw, th in reversed(sheets):
        if gid >= firstgid:
            local = gid - firstgid
            sx = (local % cols) * tw
            sy = (local // cols) * th
            return img.crop((sx, sy, sx+tw, sy+th)), tw, th
    return None, 16, 16

def render(mappath, outpath, labels=False):
    m = json.load(open(mappath))
    W, H, TS = m['width'], m['height'], m['tilewidth']
    sheets = load_sheets()
    canvas = Image.new('RGBA', (W*TS, H*TS), (20, 18, 30, 255))
    layers = {l['name']: l for l in m['layers']}
    for name in TILE_LAYERS:
        l = layers.get(name)
        if not l or 'data' not in l:
            continue
        data = l['data']
        for y in range(H):
            for x in range(W):
                raw = data[y*W + x]
                if raw == 0:
                    continue
                fh = bool(raw & FLIP_H); fv = bool(raw & FLIP_V); fd = bool(raw & FLIP_D)
                gid = raw & GID_MASK
                tile, tw, th = resolve(gid, sheets)
                if tile is None:
                    continue
                if fd:
                    tile = tile.transpose(Image.TRANSPOSE)
                if fh:
                    tile = tile.transpose(Image.FLIP_LEFT_RIGHT)
                if fv:
                    tile = tile.transpose(Image.FLIP_TOP_BOTTOM)
                canvas.alpha_composite(tile, (x*TS, y*TS))

    canvas = canvas.resize((W*TS*SCALE, H*TS*SCALE), Image.NEAREST)
    draw = ImageDraw.Draw(canvas)

    # collision overlay (faint red): only drawn when --labels is set
    col = layers.get('collision')
    if col and 'data' in col and labels:
        for y in range(H):
            for x in range(W):
                if col['data'][y*W+x] & GID_MASK:
                    draw.rectangle([x*TS*SCALE, y*TS*SCALE, (x+1)*TS*SCALE-1, (y+1)*TS*SCALE-1],
                                   outline=(255,0,0,60))

    if labels:
        try:
            font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 11)
        except Exception:
            font = ImageFont.load_default()
        for l in m['layers']:
            if l['type'] != 'objectgroup':
                continue
            isspawn = l['name'] == 'spawn-points'
            for o in l['objects']:
                px = int(o['x']/TS)*TS*SCALE
                py = int(o['y']/TS)*TS*SCALE
                color = (0,255,180) if isspawn else (255,200,0)
                draw.rectangle([px+2, py+2, px+TS*SCALE-2, py+TS*SCALE-2], outline=color, width=2)
                draw.text((px+3, py+3), o.get('name','?'), fill=color, font=font)

    canvas.convert('RGB').save(outpath)
    print('wrote', outpath, canvas.size)

if __name__ == '__main__':
    mp = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ASSETS, 'maps/office.tmj')
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, 'preview.png')
    render(mp, out, labels='--labels' in sys.argv)
