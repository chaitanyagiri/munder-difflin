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

export function findPath(map: Walkable, start: Point, goal: Point): Point[] | null {
  if (start.x === goal.x && start.y === goal.y) return [];
  if (!map.isWalkable(goal.x, goal.y)) return null;

  const key = (p: Point) => `${p.x},${p.y}`;
  const visited = new Set<string>();
  const parent = new Map<string, Point>();
  const queue: Point[] = [start];
  visited.add(key(start));

  while (queue.length > 0) {
    const current = queue.shift()!;

    for (const dir of DIRECTIONS) {
      const next: Point = { x: current.x + dir.x, y: current.y + dir.y };
      const nextKey = key(next);

      if (visited.has(nextKey) || !map.isWalkable(next.x, next.y)) continue;

      visited.add(nextKey);
      parent.set(nextKey, current);

      if (next.x === goal.x && next.y === goal.y) {
        return reconstructPath(parent, start, goal);
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

export interface PathStep {
  /** New position after spending the movement budget. */
  x: number;
  y: number;
  /** Waypoints fully reached this frame — splice this many off the front. */
  consumed: number;
  /** Budget left unspent because the path ran out. */
  leftover: number;
}

/**
 * Walk `budget` pixels along a path, crossing as many waypoints as the budget
 * covers.
 *
 * The crossing part is the point. Advancing one waypoint per frame and dropping
 * the rest of the budget makes a character's speed depend on the frame rate: it
 * loses a frame of movement every time it reaches a tile, which at 120 fps is
 * 2.5% of the frames and invisible, and at 20 fps is one frame in seven and reads
 * as a limp. Spending the whole budget every frame makes distance travelled a
 * function of elapsed time only, which is what lets the floor's frame rate be
 * capped without the walk cycle changing character.
 *
 * `toPixel` converts a path waypoint to the pixel point the sprite aims at, and
 * is called only for the waypoints actually examined (usually one).
 */
export function advanceAlongPath<T>(
  x: number,
  y: number,
  path: readonly T[],
  toPixel: (waypoint: T) => { x: number; y: number },
  budget: number
): PathStep {
  let remaining = Math.max(0, budget);
  let consumed = 0;
  for (const waypoint of path) {
    const target = toPixel(waypoint);
    const dx = target.x - x;
    const dy = target.y - y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= remaining) {
      // Reached it. Land exactly on the waypoint and carry the rest onward, so
      // a corner costs the distance to it and never a whole frame.
      x = target.x;
      y = target.y;
      remaining -= dist;
      consumed++;
      continue;
    }
    x += (dx / dist) * remaining;
    y += (dy / dist) * remaining;
    remaining = 0;
    break;
  }
  return { x, y, consumed, leftover: remaining };
}
