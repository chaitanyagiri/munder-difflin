/** Artwork landmarks measured in the authored 1560 × 1008 image. Keeping
 * them here lets the simulation retain its existing 544 × 352 navigation grid. */
const X = 544 / 1560;
const Y = 352 / 1008;
export interface ScreenRect { x: number; y: number; w: number; h: number; }
const screens: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
  [27, 3, 1259, 128, 51, 26], [30, 3, 1402, 127, 51, 27],
  [20, 5, 924, 219, 49, 23], [23, 5, 1062, 218, 51, 24],
  [2, 11, 70, 518, 50, 23], [6, 11, 258, 519, 49, 24],
  [10, 11, 446, 519, 49, 24], [14, 11, 637, 519, 48, 24],
  [18, 11, 824, 518, 48, 23], [22, 11, 1011, 519, 49, 24],
  [2, 16, 69, 746, 50, 24], [6, 16, 257, 747, 50, 24],
  [10, 16, 445, 747, 50, 24], [14, 16, 635, 748, 50, 23],
  [18, 16, 824, 746, 49, 24], [22, 16, 1011, 747, 49, 24],
];

export function officeScreenRect(tile: { x: number; y: number }): ScreenRect | undefined {
  const s = screens.find(([x, y]) => x === tile.x && y === tile.y);
  if (!s) return undefined;
  return { x: s[2] * X - tile.x * 16, y: s[3] * Y - tile.y * 16, w: s[4] * X, h: s[5] * Y };
}

export function officeSeatOffset(seat: { x: number; y: number }): { x: number; y: number } {
  const s = officeScreenRect({ x: seat.x, y: seat.y - 2 });
  if (s) return { x: s.x + s.w / 2 - 8, y: s.y + s.h - 12 };
  return seat.x === 3 && seat.y === 4 ? { x: -7, y: -6 } : { x: 0, y: 0 };
}
