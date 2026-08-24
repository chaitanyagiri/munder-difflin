// 16×16 pixel icons. 2 colors max. Integer paths only.
// Add to library by extending `paths` below.

import { CSSProperties } from 'react';

export type IconName =
  | 'gear' | 'plus' | 'x' | 'check' | 'arrow-right' | 'pause' | 'play'
  | 'bell' | 'folder' | 'terminal' | 'code' | 'web' | 'mcp' | 'sparkle'
  | 'expand' | 'minimize' | 'clock' | 'mic' | 'ledger' | 'info' | 'sidebar'
  | 'image' | 'edit' | 'git';

interface IconDef {
  ink: string;     // primary color path d
  accent?: string; // optional accent color path d
  accentColor: string; // CSS var name
}

const paths: Record<IconName, IconDef> = {
  // 16x16 each, designed on pixel grid
  // Cog with four teeth (N/S/E/W) + a square hub hole. The hole is a second
  // subpath cut out via fill-rule: evenodd (set on the <path> below).
  gear: {
    accentColor: 'var(--cth-ink-300)',
    ink:   'M6 1h4v3h2v2h3v4h-3v2h-2v3h-4v-3h-2v-2h-3v-4h3v-2h2v-3zM6 6h4v4h-4z'
  },
  plus: {
    accentColor: 'var(--cth-mint)',
    ink:   'M7 2h2v5h5v2H9v5H7V9H2V7h5V2z'
  },
  x: {
    accentColor: 'var(--cth-coral)',
    ink:   'M3 3h2v2h2v2h2V5h2V3h2v2h-2v2h-2v2h2v2h2v2h-2v-2h-2V9H7v2H5v2H3v-2h2v-2h2V7H5V5H3V3z'
  },
  check: {
    accentColor: 'var(--cth-mint)',
    ink:   'M13 4h2v2h-2v2h-2v2H9v2H7v2H5v-2H3v-2H1V8h2v2h2v2h2v-2h2V8h2V6h2V4z'
  },
  'arrow-right': {
    accentColor: 'var(--cth-sky)',
    ink:   'M8 3h2v2h2v2h2v2h-2v2h-2v2H8v-2h2V9H2V7h8V5H8V3z'
  },
  // Notebook + pen. Two earlier tries were solid pixel-art pencils and both read
  // as a blob at 16px; this sits next to `code` and `terminal` in the same row,
  // so it is drawn the way they are — hairline outlines, one colour, two whole
  // objects with a clear gap between them rather than one overlapping the other.
  // Notepad with the pen laid ACROSS its top-right corner, not parked beside it.
  // The pen breaks the pad's outline where it crosses, and that broken edge is
  // the whole trick — two shapes sharing one ink colour only read as "over" if
  // the lower one visibly stops. Same hairline weight as code/terminal/git.
  edit: {
    accentColor: 'var(--cth-lilac)',
    ink:   'M13 1h2v1h-2zM1 2h10v1h-10zM12 2h2v1h-2zM1 3h1v1h-1zM11 3h2v1h-2zM1 4h1v1h-1zM10 4h2v1h-2zM1 5h1v1h-1zM9 5h2v1h-2zM1 6h1v1h-1zM3 6h5v1h-5zM9 6h1v1h-1zM1 7h1v1h-1zM10 7h1v1h-1zM1 8h1v1h-1zM10 8h1v1h-1zM1 9h1v1h-1zM3 9h5v1h-5zM10 9h1v1h-1zM1 10h1v1h-1zM10 10h1v1h-1zM1 11h1v1h-1zM10 11h1v1h-1zM1 12h1v1h-1zM3 12h5v1h-5zM10 12h1v1h-1zM1 13h1v1h-1zM10 13h1v1h-1zM1 14h1v1h-1zM10 14h1v1h-1zM1 15h10v1h-10z'
  },
  pause: {
    accentColor: 'var(--cth-lemon)',
    ink:   'M4 3h3v10H4V3zm5 0h3v10H9V3z'
  },
  play: {
    accentColor: 'var(--cth-mint)',
    ink:   'M4 3h2v2h2v2h2v2H8v2H6v2H4V3z'
  },
  bell: {
    accentColor: 'var(--cth-peach)',
    ink:   'M7 1h2v1h1v1h1v6h1v2H3V9h1V3h1V2h1V1h1zm0 12h2v2H7v-2z'
  },
  folder: {
    accentColor: 'var(--cth-lemon)',
    ink:   'M1 3h6v1h8v9H1V3zm1 1v8h12V5H6V4H2z'
  },
  // Picture frame with a stepped mountain and a sun. The frame's two subpaths
  // cut a hole via evenodd (same trick as `terminal`); the mountain rows sit
  // inside that hole, so each adds a third crossing and fills again.
  image: {
    accentColor: 'var(--cth-lemon)',
    accent: 'M4 5h2v2H4V5z',
    ink:   'M1 2h14v12H1V2zm1 1v10h12V3H2zM8 6h2v1H8zM7 7h4v1H7zM6 8h6v1H6zM5 9h8v1H5zM4 10h9v2H4z'
  },
  terminal: {
    accentColor: 'var(--cth-mint)',
    ink:   'M1 2h14v12H1V2zm1 1v10h12V3H2zm1 2h1v1h1v1h1v1H5v1H4v1H3V9h1V8h1V7H4V6H3V5zm5 5h4v1H8v-1z'
  },
  // The branch graph, which is what git's own mark is: a trunk with two commit
  // nodes and one branch arcing off into a third. Drawn at the same hairline
  // weight as `code` and `terminal` so a row of them reads as one set — a
  // solid-filled mark next to those two looks like a different icon family.
  git: {
    accentColor: 'var(--cth-coral)',
    ink:   'M5 1h3v1h-3zM4 2h1v1h-1zM8 2h1v1h-1zM4 3h1v1h-1zM8 3h1v1h-1zM5 4h3v1h-3zM6 5h1v1h-1zM6 6h1v1h-1zM9 6h3v1h-3zM6 7h1v1h-1zM8 7h1v1h-1zM12 7h1v1h-1zM6 8h3v1h-3zM12 8h1v1h-1zM6 9h1v1h-1zM9 9h3v1h-3zM6 10h1v1h-1zM5 11h3v1h-3zM4 12h1v1h-1zM8 12h1v1h-1zM4 13h1v1h-1zM8 13h1v1h-1zM5 14h3v1h-3z'
  },
  code: {
    accentColor: 'var(--cth-sky)',
    ink:   'M5 3h1v1H5v1H4v1H3v1H2v1h1v1h1v1h1v1h1v1H5v-1H4v-1H3v-1H2v-1H1V7h1V6h1V5h1V4h1V3zm5 0h1v1h1v1h1v1h1v1h1v1h-1v1h-1v1h-1v1h-1v1h-1v-1h1v-1h1v-1h1V9h1V7h-1V6h-1V5h-1V4h-1V3z'
  },
  web: {
    accentColor: 'var(--cth-lilac)',
    ink:   'M7 1h2v1h2v1h1v1h1v2h1v2h-1v2h-1v1h-1v1H9v1H7v-1H5v-1H4v-1H3V9H2V7h1V5h1V4h1V3h2V2h0V1zm0 2v1H5v1H4v1H3v2h2V8h0V7h2V6h0V5h2V4h0V3H7zm2 1h1v1h1v1h1v2h-1v1H9V8h1V7h0V6h0V5h-1V4z'
  },
  mcp: {
    accentColor: 'var(--cth-lilac)',
    ink:   'M8 1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h-1v1h-1v1h-1v1h-1v1h-1v1H8v1H7v-1H6v-1H5v-1H4v-1H3v-1H2V9H1V8h1V7h1V6h1V5h1V4h1V3h1V2h1V1zm0 2v1H7v1H6v1H5v1H4v1H3v1h1v1h1v1h1v1h1v1h1v1h1v-1h1v-1h1v-1h1v-1h1V9h1V8h-1V7h-1V6h-1V5h-1V4h-1V3h-1V2H8z'
  },
  sparkle: {
    accentColor: 'var(--cth-lemon)',
    ink:   'M8 1h1v3h3v1H9v3H8V5H5V4h3V1zm-4 8h1v2h2v1H5v2H4v-2H2v-1h2V9zm8-1h1v2h2v1h-2v2h-1v-2H10v-1h2V8z'
  },
  expand: {
    accentColor: 'var(--cth-sky)',
    ink:   'M1 1h6v2H3v4H1V1zm14 0v6h-2V3H9V1h6zM1 9h2v4h4v2H1V9zm14 0v6H9v-2h4V9h2z'
  },
  minimize: {
    accentColor: 'var(--cth-sky)',
    ink:   'M5 1h2v6H1V5h4V1zm4 0h2v4h4v2H9V1zM1 9h6v6H5v-4H1V9zm8 0h6v2h-4v4H9V9z'
  },
  // Wall clock at five o'clock — closing time. Ring as an evenodd cutout,
  // hands as a second subpath (minute hand up, hour hand toward 5).
  clock: {
    accentColor: 'var(--cth-lemon)',
    ink:   'M5 1h6v1h2v2h1v2h1v4h-1v2h-1v2h-2v1H5v-1H3v-2H2V8H1V6h1V4h1V2h2V1zm0 2H4v1H3v2H2v4h1v2h1v1h1v1h6v-1h1v-1h1v-2h1V6h-1V4h-1V3h-1V2H5v1zm2 1h2v4h2v1h1v1h-1v1h-1v-1H9v1H7V4z'
  },
  // Ruled page — the trigger-history ledger. Frame as an evenodd cutout, three
  // written lines inside it (the last one short, like a part-filled entry).
  ledger: {
    accentColor: 'var(--cth-lemon)',
    ink:   'M2 1h12v14H2V1zM3 2v12h10V2H3zM5 4h6v1H5zM5 7h6v1H5zM5 10h4v1H5z'
  },
  // Microphone: a solid capsule head, an open cradle, a stem, and a base.
  mic: {
    accentColor: 'var(--cth-coral)',
    ink:   'M6 2h4v7H6V2z M4 9h1v2H4z M11 9h1v2h-1z M4 11h8v1H4z M7 12h2v2H7z M5 14h6v1H5z'
  },
  // Filled disc with the 'i' knocked OUT of it — the dot and stem are separate
  // subpaths cut by fill-rule: evenodd, same trick as the gear's hub hole. A
  // knocked-out glyph stays legible at 16px where a 1px-stroked outline would
  // shimmer against the pixel grid.
  info: {
    accentColor: 'var(--cth-sky)',
    ink:   'M5 1h6v1h2v1h1v2h1v6h-1v2h-1v1h-2v1H5v-1H3v-1H2v-2H1V5h1V3h1V2h2V1z M7 4h2v2H7z M7 7h2v5H7z'
  },
  // Panel outline with the left column filled — the standard sidebar-toggle
  // glyph. Three subpaths under fill-rule: evenodd — frame, hollow interior,
  // then the left column, which lands on an ODD crossing count and so fills back
  // in. Deliberately NOT `minimize`/`expand`: those sit in the same toolbar
  // meaning "exit fullscreen", and two size-ish arrows side by side read as the
  // same control twice.
  sidebar: {
    accentColor: 'var(--cth-ink-300)',
    ink:   'M1 3h14v10H1z M2 4h12v8H2z M2 4h4v8H2z'
  }
};

export interface IconProps {
  name: IconName;
  size?: number; // integer scale: 1 = 16px, 2 = 32px, ...
  style?: CSSProperties;
}

export function Icon({ name, size = 1, style }: IconProps) {
  const def = paths[name];
  const dim = 16 * size;
  return (
    <svg
      viewBox="0 0 16 16"
      width={dim}
      height={dim}
      shapeRendering="crispEdges"
      style={{ display: 'inline-block', ...style }}
      aria-hidden
    >
      {def.accent && <path d={def.accent} fill={def.accentColor} fillRule="evenodd" />}
      {/* currentColor, not a hardcoded `--cth-ink-900`. `body` already sets that
          same token as its color, so this is a no-op for every icon sitting on a
          normal surface — but on an INVERTED surface it is the difference between
          an icon and a blank space. A primary PixelButton fills itself with
          `--cth-ink-900` and an icon painted the same token vanished into it (the
          arrow on Send, in both themes). Inheriting means an icon is always the
          colour of the text it sits beside, which is what every call site meant. */}
      <path d={def.ink} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}
