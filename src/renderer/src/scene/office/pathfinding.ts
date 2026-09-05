// 基于瓦片可行走网格的 BFS 寻路。
// 从 shahar061/the-office 逐字移植（office/engine/pathfinding.ts）。

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
