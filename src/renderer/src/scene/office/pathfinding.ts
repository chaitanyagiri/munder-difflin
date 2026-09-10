// BFS pathfinding on a tile walkability grid.
// Ported verbatim from shahar061/the-office (office/engine/pathfinding.ts).

export interface Walkable {
  width: number;
  height: number;
  isWalkable(x: number, y: number): boolean;
}

interface Point {
  x: number;
  y: number;
}

const DIRECTIONS: Point[] = [
  { x: 0, y: -1 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
];

/**
 * Is the straight line between two tile centres clear?
 *
 * Used to collapse the BFS staircase into long straight runs. Sampling at sub-tile
 * resolution catches every tile the segment crosses; the extra flank test rejects lines
 * that would slip diagonally between two blocked tiles, which BFS itself can never do.
 */
export function lineOfSight(map: Walkable, a: Point, b: Point): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const steps = Math.max(Math.abs(dx), Math.abs(dy)) * 4;
  if (steps === 0) return true;

  let prevX = a.x;
  let prevY = a.y;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const cx = Math.round(a.x + dx * t);
    const cy = Math.round(a.y + dy * t);
    if (cx === prevX && cy === prevY) continue;
    if (!map.isWalkable(cx, cy)) return false;
    // A diagonal step must have both flanking tiles open, or the avatar would
    // visibly cut through the corner where two walls meet.
    if (cx !== prevX && cy !== prevY) {
      if (!map.isWalkable(prevX, cy) || !map.isWalkable(cx, prevY)) return false;
    }
    prevX = cx;
    prevY = cy;
  }
  return true;
}

/**
 * String-pull a BFS path: keep only the waypoints where the route actually has to bend.
 *
 * BFS moves in 4 directions, so a diagonal route comes back as a staircase of single-tile
 * steps. Walking that literally is what made agents shuffle sideways across the floor and
 * re-trigger their turn animation at every tile. Collapsing it to the longest visible runs
 * yields true diagonal movement without letting the path clip furniture.
 */
export function smoothPath(map: Walkable, start: Point, path: Point[]): Point[] {
  if (path.length < 2) return path;

  const out: Point[] = [];
  let anchor = start;
  let i = 0;
  while (i < path.length) {
    // Furthest node still visible from the anchor. j never falls below i, because
    // path[i] is one step from the anchor and therefore always visible.
    let j = path.length - 1;
    while (j > i && !lineOfSight(map, anchor, path[j])) j--;
    out.push(path[j]);
    anchor = path[j];
    i = j + 1;
  }
  return out;
}

export function findPath(map: Walkable, start: Point, goal: Point): Point[] | null {
  if (start.x === goal.x && start.y === goal.y) return [];
  if (!map.isWalkable(goal.x, goal.y)) return null;

  const key = (p: Point) => `${p.x},${p.y}`;
  const visited = new Set<string>();
  const parent = new Map<string, Point>();
  // Read with a head index rather than Array.shift(). Measured on a 200x200 exhaustive
  // search this is ~15% faster, not the order-of-magnitude the textbook O(n) cost of
  // shift() implies -- V8 memmoves packed arrays cheaply. Kept because it is free, but
  // the real cost in this file was never the queue; it was the unsmoothed path.
  const queue: Point[] = [start];
  let head = 0;
  visited.add(key(start));

  while (head < queue.length) {
    const current = queue[head++];

    for (const dir of DIRECTIONS) {
      const next: Point = { x: current.x + dir.x, y: current.y + dir.y };
      const nextKey = key(next);

      if (visited.has(nextKey) || !map.isWalkable(next.x, next.y)) continue;

      visited.add(nextKey);
      parent.set(nextKey, current);

      if (next.x === goal.x && next.y === goal.y) {
        return smoothPath(map, start, reconstructPath(parent, start, goal));
      }

      queue.push(next);
    }
  }

  return null;
}

function reconstructPath(parent: Map<string, Point>, start: Point, goal: Point): Point[] {
  const path: Point[] = [];
  let current = goal;
  const key = (p: Point) => `${p.x},${p.y}`;

  while (!(current.x === start.x && current.y === start.y)) {
    path.unshift(current);
    current = parent.get(key(current))!;
  }

  return path;
}
