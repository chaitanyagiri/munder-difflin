'use strict';

/**
 * Office pathfinding: string-pulled routes and an O(1) BFS queue.
 *
 * Two defects motivated this. First, BFS moves in four directions, so any diagonal route
 * came back as a staircase of single-tile steps; agents walked it literally, changing
 * facing at every tile, which read as a sideways shuffle across the floor. Second, the
 * frontier was popped with `Array.shift()` — O(n) per pop, so an exhaustive search of the
 * 48x24 office was quadratic in tile count, and every agent repaths on every wander hop.
 *
 * Smoothing a path is only safe if it cannot invent a shortcut, so most of what is pinned
 * here is the negative: the collapsed route must never enter a blocked tile and must never
 * slip diagonally between two walls that touch at a corner.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { findPath, smoothPath, lineOfSight } = loadTs('src/renderer/src/scene/office/pathfinding.ts');

/** Build a Walkable from an ASCII map: '#' blocked, anything else open. */
function grid(rows) {
  const cells = rows.map((r) => r.split(''));
  return {
    width: cells[0].length,
    height: cells.length,
    isWalkable(x, y) {
      if (x < 0 || y < 0 || y >= cells.length || x >= cells[0].length) return false;
      return cells[y][x] !== '#';
    },
  };
}

/** Every tile a route touches, sampled finely enough to catch a clipped corner. */
function tilesAlong(map, start, path) {
  const seen = [];
  let a = start;
  for (const b of path) {
    const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) * 8 || 1;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      seen.push({ x: Math.round(a.x + (b.x - a.x) * t), y: Math.round(a.y + (b.y - a.y) * t) });
    }
    a = b;
  }
  return seen;
}

test('an open diagonal collapses to a single waypoint instead of a staircase', () => {
  const map = grid(['......', '......', '......', '......', '......', '......']);
  const path = findPath(map, { x: 0, y: 0 }, { x: 5, y: 5 });

  assert.ok(path, 'expected a path across open floor');
  assert.equal(path.length, 1, `staircase not collapsed: ${JSON.stringify(path)}`);
  assert.deepEqual(path[path.length - 1], { x: 5, y: 5 });
});

test('a smoothed route never crosses a blocked tile', () => {
  const map = grid([
    '..........',
    '..#####...',
    '..#...#...',
    '..#...#...',
    '..#####...',
    '..........',
  ]);
  const start = { x: 0, y: 5 };
  const path = findPath(map, start, { x: 9, y: 0 });

  assert.ok(path, 'expected a route around the block');
  for (const tile of tilesAlong(map, start, path)) {
    assert.ok(map.isWalkable(tile.x, tile.y), `route passes through blocked tile ${tile.x},${tile.y}`);
  }
});

test('smoothing refuses to slip diagonally between two touching walls', () => {
  // The only opening is the corner shared by (1,1) and (2,2). A naive line test says
  // "clear" because it samples tile centres; an avatar taking it walks through the seam.
  const map = grid(['...', '.#.', '..#']);
  assert.equal(lineOfSight(map, { x: 0, y: 2 }, { x: 2, y: 0 }), false);
});

test('a straight clear line is visible; one through a wall is not', () => {
  const map = grid(['.....', '..#..', '.....']);
  assert.equal(lineOfSight(map, { x: 0, y: 0 }, { x: 4, y: 0 }), true);
  assert.equal(lineOfSight(map, { x: 2, y: 0 }, { x: 2, y: 2 }), false);
});

test('unreachable and same-tile goals are still distinguished', () => {
  const map = grid(['..#..', '..#..', '..#..']);
  assert.equal(findPath(map, { x: 0, y: 0 }, { x: 4, y: 0 }), null, 'walled-off goal must be null');
  assert.deepEqual(findPath(map, { x: 1, y: 1 }, { x: 1, y: 1 }), [], 'same tile is an empty path');
  assert.equal(findPath(map, { x: 0, y: 0 }, { x: 2, y: 1 }), null, 'goal inside a wall must be null');
});

test('smoothPath keeps the goal and always makes progress', () => {
  // A spiral forces many genuine bends; the result must still end at the goal and
  // never grow, or the string-pull has a non-terminating case.
  const map = grid([
    '..........',
    '.########.',
    '.#......#.',
    '.#.####.#.',
    '.#.#..#.#.',
    '.#.#.##.#.',
    '.#.#....#.',
    '.#.######.',
    '.#........',
    '..........',
  ]);
  const start = { x: 0, y: 0 };
  const goal = { x: 4, y: 4 };
  const raw = findPath(map, start, goal);

  assert.ok(raw, 'expected a route through the spiral');
  assert.deepEqual(raw[raw.length - 1], goal);
  for (const tile of tilesAlong(map, start, raw)) {
    assert.ok(map.isWalkable(tile.x, tile.y), `spiral route clips ${tile.x},${tile.y}`);
  }
  // Idempotent: re-pulling an already-pulled route changes nothing.
  assert.deepEqual(smoothPath(map, start, raw), raw);
});

test('an exhaustive search of a large map terminates and reports no route', () => {
  // Not a performance assertion. Measured head-to-head, the head-index queue beats
  // Array.shift() by ~15% on this map (V8 memmoves packed arrays cheaply), which is far
  // too small to pin in a test without it flaking. What is worth pinning is that a search
  // which has to drain the entire frontier still terminates and answers null.
  const size = 200;
  // A solid row seals off the last one. The goal must itself be OPEN, or findPath
  // rejects it up front and the search never runs.
  const rows = Array.from({ length: size }, (_, y) => (y === size - 2 ? '#'.repeat(size) : '.'.repeat(size)));
  const map = grid(rows);

  // Reachable region is 200*198 tiles and the goal is not in it, so BFS must exhaust it.
  assert.equal(findPath(map, { x: 0, y: 0 }, { x: 5, y: size - 1 }), null);
});
