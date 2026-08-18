// Design tokens — single source of truth. Mirrors tokens.css for non-styled consumers (Pixi).
// Any change here must also update tokens.css.

export const colors = {
  cream: {
    50: 0xf7f9fa,
    100: 0xeef2f5,
    200: 0xe2e8ed,
    300: 0xcbd5dd
  },
  paper: {
    100: 0xfcfdfd,
    200: 0xe8edf1
  },
  ink: {
    900: 0x14283d,
    700: 0x2f465b,
    500: 0x5b6f80,
    300: 0x8fa0ae,
    100: 0xcfd8df
  },
  // v0.3.4 recalibration: same hues, professional saturation (mirrors tokens.css)
  accent: {
    coral: 0xb95d57,
    coralLight: 0xf1d8d5,
    mint: 0x477f68,
    mintLight: 0xd8e7df,
    sky: 0x3e7892,
    skyLight: 0xd6e5eb,
    lemon: 0xd8a72e,
    lemonLight: 0xf3e6be,
    lilac: 0x6d739b,
    lilacLight: 0xdfe1ec,
    peach: 0xa86e4b,
    peachLight: 0xedded4
  },
  status: {
    idle: 0xa199ab,
    thinking: 0x4f9faf,
    working: 0xdcab3c,
    blocked: 0xd96a62,
    success: 0x5ca97a,
    ghost: 0xd9d3de
  },
  world: {
    grassLight: 0xd4eab0,
    grassDark: 0xb5d589,
    woodLight: 0xe5c896,
    woodDark: 0xc9a66b,
    path: 0xe8d8b0,
    wall: 0x8b6f47
  }
} as const;

export const space = {
  0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32, 7: 48, 8: 64
} as const;

export const type = {
  display: '"Press Start 2P", monospace',
  ui: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace'
} as const;

export const tileSize = 32; // px — the world is built from 32×32 tiles

export type AccentColorName =
  | 'coral' | 'mint' | 'sky' | 'lemon' | 'lilac' | 'peach';

export const accentByName: Record<AccentColorName, number> = {
  coral: colors.accent.coral,
  mint:  colors.accent.mint,
  sky:   colors.accent.sky,
  lemon: colors.accent.lemon,
  lilac: colors.accent.lilac,
  peach: colors.accent.peach
};

export const accentLightByName: Record<AccentColorName, number> = {
  coral: colors.accent.coralLight,
  mint:  colors.accent.mintLight,
  sky:   colors.accent.skyLight,
  lemon: colors.accent.lemonLight,
  lilac: colors.accent.lilacLight,
  peach: colors.accent.peachLight
};

// Convert 0xRRGGBB to "#RRGGBB"
export function hex(c: number): string {
  return '#' + c.toString(16).padStart(6, '0').toUpperCase();
}
