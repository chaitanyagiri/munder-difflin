#!/usr/bin/env python3
"""Validate the generated office map before it becomes a renderer asset.

This is intentionally dependency-free: it can run in CI or locally immediately
after ``build_map.py``.  The checks protect the contract shared by the map
generator, Pixi renderer and office pathfinding:

* named tile layers have the declared grid shape;
* every named station is unique, in bounds and walkable;
* every station is reachable from the public entrance; and
* named zones stay inside the playable map.
"""

from __future__ import annotations

import argparse
import json
from collections import deque
from pathlib import Path
from typing import Any


TILE_ID_MASK = 0x1FFFFFFF
REQUIRED_TILE_LAYERS = (
    "floor",
    "walls",
    "furniture-below",
    "furniture-above",
    "collision",
)
SPAWN_LAYER = "spawn-points"
ZONES_LAYER = "zones"
ENTRANCE = "entrance"


class MapContractError(ValueError):
    """The generated map no longer satisfies the office renderer contract."""


def _layers_by_name(data: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {layer.get("name", ""): layer for layer in data.get("layers", [])}


def _point_to_tile(obj: dict[str, Any], tile_size: int) -> tuple[int, int]:
    return (int(obj.get("x", 0) // tile_size), int(obj.get("y", 0) // tile_size))


def _reachable(collision: list[int], width: int, height: int, start: tuple[int, int]) -> set[tuple[int, int]]:
    def walkable(x: int, y: int) -> bool:
        return 0 <= x < width and 0 <= y < height and (collision[y * width + x] & TILE_ID_MASK) == 0

    if not walkable(*start):
        return set()

    visited = {start}
    queue = deque([start])
    while queue:
        x, y = queue.popleft()
        for next_tile in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if next_tile not in visited and walkable(*next_tile):
                visited.add(next_tile)
                queue.append(next_tile)
    return visited


def validate_map(data: dict[str, Any]) -> dict[str, int]:
    """Raise ``MapContractError`` for invalid data; return useful map metrics."""
    width = data.get("width")
    height = data.get("height")
    tile_size = data.get("tilewidth")
    if not all(isinstance(value, int) and value > 0 for value in (width, height, tile_size)):
        raise MapContractError("map width, height and tilewidth must be positive integers")

    layers = _layers_by_name(data)
    expected_cells = width * height
    for name in REQUIRED_TILE_LAYERS:
        layer = layers.get(name)
        if not layer or layer.get("type") != "tilelayer":
            raise MapContractError(f"missing required tile layer: {name}")
        if layer.get("width") != width or layer.get("height") != height:
            raise MapContractError(f"tile layer {name} dimensions do not match map")
        if len(layer.get("data", [])) != expected_cells:
            raise MapContractError(f"tile layer {name} has {len(layer.get('data', []))} cells; expected {expected_cells}")

    spawn_layer = layers.get(SPAWN_LAYER)
    if not spawn_layer or spawn_layer.get("type") != "objectgroup":
        raise MapContractError(f"missing required object layer: {SPAWN_LAYER}")
    spawns = spawn_layer.get("objects", [])
    names = [obj.get("name") for obj in spawns]
    if not names or any(not isinstance(name, str) or not name for name in names):
        raise MapContractError("every spawn point needs a non-empty name")
    duplicates = sorted({name for name in names if names.count(name) > 1})
    if duplicates:
        raise MapContractError("duplicate spawn names: " + ", ".join(duplicates))
    if ENTRANCE not in names:
        raise MapContractError(f"missing required spawn point: {ENTRANCE}")

    collision = layers["collision"]["data"]
    spawn_tiles = {obj["name"]: _point_to_tile(obj, tile_size) for obj in spawns}
    for name, (x, y) in spawn_tiles.items():
        if not (0 <= x < width and 0 <= y < height):
            raise MapContractError(f"spawn {name} is outside the map at ({x}, {y})")
        if collision[y * width + x] & TILE_ID_MASK:
            raise MapContractError(f"spawn {name} is blocked by collision at ({x}, {y})")

    reachable = _reachable(collision, width, height, spawn_tiles[ENTRANCE])
    unreachable = sorted(name for name, tile in spawn_tiles.items() if tile not in reachable)
    if unreachable:
        raise MapContractError("unreachable spawn points from entrance: " + ", ".join(unreachable))

    zones_layer = layers.get(ZONES_LAYER)
    if not zones_layer or zones_layer.get("type") != "objectgroup":
        raise MapContractError(f"missing required object layer: {ZONES_LAYER}")
    for zone in zones_layer.get("objects", []):
        name = zone.get("name", "<unnamed>")
        x, y = _point_to_tile(zone, tile_size)
        zone_width = int(zone.get("width", 0) // tile_size)
        zone_height = int(zone.get("height", 0) // tile_size)
        if zone_width <= 0 or zone_height <= 0:
            raise MapContractError(f"zone {name} must have positive dimensions")
        if x < 0 or y < 0 or x + zone_width > width or y + zone_height > height:
            raise MapContractError(f"zone {name} extends outside the map")

    return {"width": width, "height": height, "spawns": len(spawns), "reachable_tiles": len(reachable)}


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate the generated Munder Difflin office map")
    parser.add_argument("map", type=Path, help="path to office.tmj")
    args = parser.parse_args()
    try:
        metrics = validate_map(json.loads(args.map.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError, MapContractError) as error:
        print(f"MAP CONTRACT FAILED: {error}")
        return 1
    print("MAP CONTRACT PASSED: " + ", ".join(f"{key}={value}" for key, value in metrics.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
