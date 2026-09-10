/**
 * Ask the INSTALLED CLIs which models they actually have.
 *
 * The catalog is two layers today: the list baked into the build, and
 * docs/model-catalog.json fetched from main. Both are written by hand, so both
 * drift — a model shipped by a CLI vendor this morning is not in either until
 * somebody edits a file, and a model the user's account cannot reach is offered
 * anyway. Measured on 2026-09-07, the shipped catalog listed 4 of the 10 models
 * `codex` actually had, and none of the Gemini 3.8 or 3.6 families `agy` did.
 *
 * This adds a third layer, on top and per provider: what the CLI on THIS machine
 * reports. It is the only layer that can be right about a private preview, an
 * account tier, or a CLI the user pinned to an old version.
 *
 * Two rules shape everything here:
 *
 *  - **Only ask a CLI that can be asked.** `codex` keeps a models cache it
 *    refreshes itself, and `agy models` is a documented subcommand. `claude`
 *    and `gemini` have no enumeration at all — `claude --model` takes an alias
 *    or a full name and offers no list — so they are absent by design rather
 *    than guessed at. A provider with no detector keeps the curated list, which
 *    is a better answer than an empty picker.
 *  - **Report the id the CLI will accept, not the prettiest one.** This is not
 *    cosmetic: `agy models` prints `slug<TAB>display name`, but `agy --model`
 *    rejects the slug and wants the display name — verified against the CLI's
 *    own error, which answers with an "Available models" list of display names.
 *    Detecting the slug would produce a picker where every row fails.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CatalogModel } from '../shared/modelCatalogPayload';

/** A detection never blocks a picker: the curated list is already rendering, so
 *  a CLI that hangs is simply a CLI we do not hear back from. */
const PROBE_TIMEOUT_MS = 6000;
/** A CLI that prints a novel's worth of output is malfunctioning, not verbose. */
const MAX_PROBE_BYTES = 512 * 1024;
/** Long enough for every id observed in the wild, short enough that a corrupt
 *  file cannot push a megabyte of text into a --model flag. */
const MAX_ID_LEN = 120;

export interface DetectionResult {
  /** Rows in picker order. Empty means "detected nothing usable" — the caller
   *  keeps the curated list rather than showing an empty picker. */
  models: CatalogModel[];
  /** Where these came from, for the UI to be honest about. */
  source: string;
}

/** The "pass no --model flag" row. Every detected list keeps it first: the CLI's
 *  own default is a real, and usually correct, choice, and losing it would make
 *  turning detection on a downgrade for anyone relying on it. */
const CLI_DEFAULT: CatalogModel = { label: 'CLI default' };

function usableRow(id: unknown, label: unknown): CatalogModel | null {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (!trimmed || trimmed.length > MAX_ID_LEN) return null;
  const text = typeof label === 'string' && label.trim() ? label.trim() : trimmed;
  return { id: trimmed, label: text.slice(0, MAX_ID_LEN) };
}

/** De-duplicate by id, first occurrence wins, so a CLI that lists a model twice
 *  cannot produce two identical picker rows. */
function dedupe(rows: CatalogModel[]): CatalogModel[] {
  const seen = new Set<string>();
  const out: CatalogModel[] = [];
  for (const r of rows) {
    const key = r.id ?? '';
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/** Run a CLI subcommand and return stdout, or null for ANY failure — missing
 *  binary, non-zero exit, timeout, oversized output. Detection is an
 *  enhancement; every failure mode collapses to "we learned nothing". */
function probe(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        { timeout: PROBE_TIMEOUT_MS, maxBuffer: MAX_PROBE_BYTES, windowsHide: true },
        (err, stdout) => resolve(err ? null : String(stdout))
      );
    } catch { resolve(null); }
  });
}

/**
 * Codex keeps its own model cache and refreshes it on launch, so reading the
 * file costs nothing and cannot hang — no subprocess at all. Its shape is
 * `{ models: [{ slug, display_name }] }`; `slug` is exactly what `--model`
 * takes.
 */
export function detectCodexModels(home = homedir()): DetectionResult | null {
  const path = join(home, '.codex', 'models_cache.json');
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const list = (raw as { models?: unknown })?.models;
    if (!Array.isArray(list)) return null;
    const rows: CatalogModel[] = [];
    for (const m of list) {
      const row = usableRow((m as { slug?: unknown })?.slug, (m as { display_name?: unknown })?.display_name);
      if (row) rows.push(row);
    }
    if (!rows.length) return null;
    return { models: dedupe([CLI_DEFAULT, ...rows]), source: '~/.codex/models_cache.json' };
  } catch { return null; }
}

/**
 * `agy models` prints one model per line as `slug<TAB>display name`.
 *
 * The id is the DISPLAY NAME, not the slug. `agy --model <slug>` fails with
 * "model <slug> is not recognized", and the CLI's own error then lists the
 * display names under "Available models" — so the second column is the value
 * the flag accepts. A line with no tab is skipped rather than guessed at.
 */
export function parseAgyModels(stdout: string): CatalogModel[] {
  const rows: CatalogModel[] = [];
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;                      // header/progress line, not a model
    const display = line.slice(tab + 1);
    const row = usableRow(display, display);
    if (row) rows.push(row);
  }
  return rows;
}

export async function detectAntigravityModels(): Promise<DetectionResult | null> {
  const stdout = await probe('agy', ['models']);
  if (stdout === null) return null;
  const rows = parseAgyModels(stdout);
  if (!rows.length) return null;
  return { models: dedupe([CLI_DEFAULT, ...rows]), source: '`agy models`' };
}

/** Providers this can speak for. Everything else keeps its curated list — see
 *  the header for why guessing at a CLI with no enumeration is worse. */
export const DETECTABLE_PROVIDERS = ['codex', 'antigravity'] as const;
export type DetectableProvider = (typeof DETECTABLE_PROVIDERS)[number];

/**
 * Detect every provider we can, in parallel. Providers that report nothing are
 * simply absent from the result, which the renderer reads as "keep the curated
 * list for that one" — detection is never able to empty a picker.
 */
export async function detectModels(): Promise<Record<string, DetectionResult>> {
  const [codex, antigravity] = await Promise.all([
    Promise.resolve(detectCodexModels()),
    detectAntigravityModels()
  ]);
  const out: Record<string, DetectionResult> = {};
  if (codex) out.codex = codex;
  if (antigravity) out.antigravity = antigravity;
  return out;
}
