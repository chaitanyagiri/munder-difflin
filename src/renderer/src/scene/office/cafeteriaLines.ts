// Cafeteria small-talk — The Office edition.
//
// The cast ARE Dunder Mifflin (see cast.ts), so an agent's coffee break is an
// excuse for a one-liner in character. Two kinds of line:
//   • solo  — one quip shown above a single agent at a break spot
//   • pair  — a two-beat exchange between two agents at the same table
//
// The LINES THEMSELVES live in the locale files under `office.cafeteria.*`
// (they are user-visible UI, and the floor speaks the app's language) — this
// module deals only in i18n KEYS, exactly like the errand pools in
// OfficeFloor.tsx deal in `office.errand.*`. Callers t() the returned key.
// Lines are kept short so they fit the ThoughtBubble (≈MAX_WIDTH). Character
// keys match OfficeCharacterName; anyone without bespoke lines falls back to
// the shared GENERIC pool so the floor never feels empty. The boss is named
// via {{godName}}, so a renamed orchestrator is quoted correctly.

import type { OfficeCharacterName } from './cast';

/** Where an agent is lingering — picks a contextual line pool. */
export type BreakSpot = 'coffee' | 'vending' | 'snack' | 'table';

const pick = <T,>(arr: readonly T[], seed: number): T =>
  arr[((seed % arr.length) + arr.length) % arr.length];

/** `office.cafeteria.<pool>.0 … .<n-1>` — the i18n keys of one line pool. */
const keyRange = (prefix: string, n: number): readonly string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}.${i}`);

// ─── solo lines, by spot (keys into office.cafeteria.*) ──────────────────────

const COFFEE = keyRange('office.cafeteria.coffee', 6);
const VENDING = keyRange('office.cafeteria.vending', 6);
const SNACK = keyRange('office.cafeteria.snack', 5);
const TABLE = keyRange('office.cafeteria.table', 6);

const SPOT_POOL: Record<BreakSpot, readonly string[]> = {
  coffee: COFFEE, vending: VENDING, snack: SNACK, table: TABLE,
};

// ─── character flavour — overrides the generic pool when present ─────────────

const BY_CHARACTER: Partial<Record<OfficeCharacterName, readonly string[]>> = {
  michael: keyRange('office.cafeteria.byCharacter.michael', 4),
  dwight: keyRange('office.cafeteria.byCharacter.dwight', 5),
  jim: keyRange('office.cafeteria.byCharacter.jim', 4),
  pam: keyRange('office.cafeteria.byCharacter.pam', 3),
  kevin: keyRange('office.cafeteria.byCharacter.kevin', 4),
  angela: keyRange('office.cafeteria.byCharacter.angela', 3),
  oscar: keyRange('office.cafeteria.byCharacter.oscar', 3),
  stanley: keyRange('office.cafeteria.byCharacter.stanley', 4),
  phyllis: keyRange('office.cafeteria.byCharacter.phyllis', 2),
  andy: keyRange('office.cafeteria.byCharacter.andy', 3),
  kelly: keyRange('office.cafeteria.byCharacter.kelly', 3),
  ryan: keyRange('office.cafeteria.byCharacter.ryan', 3),
  toby: keyRange('office.cafeteria.byCharacter.toby', 3),
  creed: keyRange('office.cafeteria.byCharacter.creed', 3),
  meredith: keyRange('office.cafeteria.byCharacter.meredith', 2),
};

/** A solo break-room line (as an i18n key — t() it). Character flavour ~60% of
 *  the time, else the line fits the spot the agent is standing at. `seed` keeps
 *  it deterministic per call site (avoids Math.random, which Pixi/Electron
 *  CSP-safe code prefers). */
export function pickSoloLine(character: OfficeCharacterName, spot: BreakSpot, seed: number): string {
  const flavour = BY_CHARACTER[character];
  if (flavour && seed % 5 < 3) return pick(flavour, Math.floor(seed / 5));
  return pick(SPOT_POOL[spot], seed);
}

// ─── paired exchanges (two agents at one table) ──────────────────────────────
//
// Each exchange is a list of beats that ALTERNATE between the two agents:
// beat[0] = the speaker who sat down, beat[1] = their table-mate, beat[2] =
// speaker again, and so on. The director plays them out one beat at a time.
// Beats are i18n keys; the locale lines are trimmed to fit the thought cloud.

type Exchange = readonly string[];

// Generic banter — works between any two agents (they're all Dunder Mifflin).
const EXCHANGES: readonly Exchange[] = [
  keyRange('office.cafeteria.exchanges.0', 3),
  keyRange('office.cafeteria.exchanges.1', 3),
  keyRange('office.cafeteria.exchanges.2', 3),
  keyRange('office.cafeteria.exchanges.3', 2),
  keyRange('office.cafeteria.exchanges.4', 3),
  keyRange('office.cafeteria.exchanges.5', 3),
  keyRange('office.cafeteria.exchanges.6', 3),
  keyRange('office.cafeteria.exchanges.7', 2),
  keyRange('office.cafeteria.exchanges.8', 3),
  keyRange('office.cafeteria.exchanges.9', 3),
  keyRange('office.cafeteria.exchanges.10', 2),
  keyRange('office.cafeteria.exchanges.11', 3),
  keyRange('office.cafeteria.exchanges.12', 4),
  keyRange('office.cafeteria.exchanges.13', 3),
  keyRange('office.cafeteria.exchanges.14', 3),
  keyRange('office.cafeteria.exchanges.15', 3),
  keyRange('office.cafeteria.exchanges.16', 3),
  keyRange('office.cafeteria.exchanges.17', 4),
  keyRange('office.cafeteria.exchanges.18', 4),
  keyRange('office.cafeteria.exchanges.19', 3),
  keyRange('office.cafeteria.exchanges.20', 3),
  keyRange('office.cafeteria.exchanges.21', 4),
  keyRange('office.cafeteria.exchanges.22', 4),
  keyRange('office.cafeteria.exchanges.23', 3),
  keyRange('office.cafeteria.exchanges.24', 4),
  keyRange('office.cafeteria.exchanges.25', 4),
  keyRange('office.cafeteria.exchanges.26', 3),
  keyRange('office.cafeteria.exchanges.27', 4),
  keyRange('office.cafeteria.exchanges.28', 2),
  keyRange('office.cafeteria.exchanges.29', 4),
  keyRange('office.cafeteria.exchanges.30', 4),
  keyRange('office.cafeteria.exchanges.31', 2),
  keyRange('office.cafeteria.exchanges.32', 3),
  keyRange('office.cafeteria.exchanges.33', 3),
  keyRange('office.cafeteria.exchanges.34', 3),
  keyRange('office.cafeteria.exchanges.35', 3),
  keyRange('office.cafeteria.exchanges.36', 3),
  keyRange('office.cafeteria.exchanges.37', 3),
  keyRange('office.cafeteria.exchanges.38', 3),
  keyRange('office.cafeteria.exchanges.39', 3),
  keyRange('office.cafeteria.exchanges.40', 3),
  keyRange('office.cafeteria.exchanges.41', 2),
  keyRange('office.cafeteria.exchanges.42', 4),
  keyRange('office.cafeteria.exchanges.43', 3),
  keyRange('office.cafeteria.exchanges.44', 4),
  keyRange('office.cafeteria.exchanges.45', 4),
  keyRange('office.cafeteria.exchanges.46', 3),
  keyRange('office.cafeteria.exchanges.47', 2),
  keyRange('office.cafeteria.exchanges.48', 2),
  keyRange('office.cafeteria.exchanges.49', 2),
];

// ─── "that's what she said" ──────────────────────────────────────────────────
//
// The office's favourite bit. Generic (added to the shared pool below) so ANY
// two agents at a table can run them: whoever sits down first delivers the
// innocent setup (beat 0) and their table-mate lands the punchline (beat 1).
const TWSS_EXCHANGES: readonly Exchange[] = [
  keyRange('office.cafeteria.twss.0', 2),
  keyRange('office.cafeteria.twss.1', 2),
  keyRange('office.cafeteria.twss.2', 2),
  keyRange('office.cafeteria.twss.3', 2),
  keyRange('office.cafeteria.twss.4', 2),
  keyRange('office.cafeteria.twss.5', 2),
  keyRange('office.cafeteria.twss.6', 2),
  keyRange('office.cafeteria.twss.7', 2),
  keyRange('office.cafeteria.twss.8', 2),
  keyRange('office.cafeteria.twss.9', 2),
  keyRange('office.cafeteria.twss.10', 3),
  keyRange('office.cafeteria.twss.11', 4),
  keyRange('office.cafeteria.twss.12', 2),
  keyRange('office.cafeteria.twss.13', 4),
  keyRange('office.cafeteria.twss.14', 2),
  keyRange('office.cafeteria.twss.15', 2),
  keyRange('office.cafeteria.twss.16', 4),
  keyRange('office.cafeteria.twss.17', 2),
  keyRange('office.cafeteria.twss.18', 2),
  keyRange('office.cafeteria.twss.19', 4),
  keyRange('office.cafeteria.twss.20', 4),
  keyRange('office.cafeteria.twss.21', 3),
  keyRange('office.cafeteria.twss.22', 3),
  keyRange('office.cafeteria.twss.23', 3),
  keyRange('office.cafeteria.twss.24', 3),
  keyRange('office.cafeteria.twss.25', 2),
  keyRange('office.cafeteria.twss.26', 4),
  keyRange('office.cafeteria.twss.27', 4),
  keyRange('office.cafeteria.twss.28', 4),
  keyRange('office.cafeteria.twss.29', 4),
  keyRange('office.cafeteria.twss.30', 4),
  keyRange('office.cafeteria.twss.31', 4),
  keyRange('office.cafeteria.twss.32', 3),
  keyRange('office.cafeteria.twss.33', 4),
  keyRange('office.cafeteria.twss.34', 4),
  keyRange('office.cafeteria.twss.35', 4),
  keyRange('office.cafeteria.twss.36', 3),
  keyRange('office.cafeteria.twss.37', 4),
  keyRange('office.cafeteria.twss.38', 4),
  keyRange('office.cafeteria.twss.39', 4),
  keyRange('office.cafeteria.twss.40', 3),
  keyRange('office.cafeteria.twss.41', 3),
  keyRange('office.cafeteria.twss.42', 3),
  keyRange('office.cafeteria.twss.43', 3),
  keyRange('office.cafeteria.twss.44', 4),
  keyRange('office.cafeteria.twss.45', 4),
  keyRange('office.cafeteria.twss.46', 4),
  keyRange('office.cafeteria.twss.47', 5),
  keyRange('office.cafeteria.twss.48', 6),
  keyRange('office.cafeteria.twss.49', 5),
];

// Everything any table-mate pair can draw from.
const PAIR_POOL: readonly Exchange[] = [...EXCHANGES, ...TWSS_EXCHANGES];

// Keyed off the SPEAKER so, when the right character sits down first, they get
// to open with their signature bit.
const KEYED_EXCHANGES: Partial<Record<OfficeCharacterName, Exchange>> = {
  michael: keyRange('office.cafeteria.keyed.michael', 2),
  dwight: keyRange('office.cafeteria.keyed.dwight', 2),
  kevin: keyRange('office.cafeteria.keyed.kevin', 2),
  kelly: keyRange('office.cafeteria.keyed.kelly', 2),
  oscar: keyRange('office.cafeteria.keyed.oscar', 2),
  angela: keyRange('office.cafeteria.keyed.angela', 2),
  creed: keyRange('office.cafeteria.keyed.creed', 2),
  stanley: keyRange('office.cafeteria.keyed.stanley', 3),
  andy: keyRange('office.cafeteria.keyed.andy', 3),
  jim: keyRange('office.cafeteria.keyed.jim', 3),
};

/** A multi-beat exchange for two agents sharing a table, as i18n keys — t()
 *  each beat. Beats alternate: index 0 = `speaker`, 1 = the table-mate, … */
export function pickExchange(speaker: OfficeCharacterName, seed: number): Exchange {
  const keyed = KEYED_EXCHANGES[speaker];
  if (keyed && seed % 4 === 0) return keyed;
  return pick(PAIR_POOL, seed);
}
