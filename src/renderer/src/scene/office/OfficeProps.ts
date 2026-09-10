import type { Graphics } from 'pixi.js';

/** Small interactive props share the room's restrained materials and fine edges. */
export function paintNoticeBoard(g: Graphics, x: number, y: number, accent: number): void {
  g.roundRect(x + 0.7, y + 0.8, 30, 22, 0.6).fill({ color: 0x202322, alpha: 0.2 });
  g.roundRect(x, y, 30, 22, 0.5).fill(0x695c4a).stroke({ color: 0xb8a992, width: 0.35 });
  g.rect(x + 0.85, y + 0.85, 28.3, 20.3).fill(0xb7a17b);
  // Fine, deterministic cork flecks; no new textures or allocations per frame.
  for (let i = 0; i < 140; i++) {
    const px = x + 1.2 + ((i * 73) % 277) / 10;
    const py = y + 1.2 + ((i * 43) % 197) / 10;
    g.circle(px, py, i % 3 ? 0.12 : 0.23).fill({ color: i % 2 ? 0x69543c : 0xe0cfaa, alpha: 0.25 });
  }
  g.rect(x + 1, y + 1, 28, 1.8).fill({ color: accent, alpha: 0.7 });
  g.moveTo(x + 0.5, y + 21.5).lineTo(x + 29.5, y + 21.5).stroke({ color: 0x4c4438, width: 0.4 });
}

export function paintWallCalendar(g: Graphics): void {
  g.roundRect(0.5, 0.7, 14, 19, 0.6).fill({ color: 0x252628, alpha: 0.2 });
  g.roundRect(0, 0, 14, 19, 0.5).fill(0xf2f0e8).stroke({ color: 0xb9b7b0, width: 0.3 });
  g.rect(0.3, 0.4, 13.4, 3.3).fill(0x5d6d70);
  for (let col = 0; col < 7; col++) {
    g.roundRect(1.5 + col * 1.65, -0.8, 0.35, 2, 0.17).fill(0xc5c8c6);
    for (let row = 0; row < 5; row++) {
      g.rect(1.4 + col * 1.65, 5.7 + row * 2.1, 0.75, 0.65).fill({ color: 0x667073, alpha: col > 4 ? 0.4 : 0.8 });
    }
  }
  g.circle(6.75, 10.15, 0.95).stroke({ color: 0xa56651, width: 0.3 });
  g.rect(0.5, 17.8, 13, 0.2).fill(0xd5d1c5);
}
