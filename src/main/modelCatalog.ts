/**
 * Fetch + cache the REMOTE model catalog.
 *
 * Same shape as the hero payload and the skills catalog: served from cache when
 * fresh, refetched otherwise, and NEVER fatal. A failed fetch falls back to the
 * cached copy, and a missing cache falls back to null — which the renderer reads
 * as "keep the catalog compiled into this build".
 *
 * The point of this file: shipping a model was a build. Now it is an edit to
 * docs/model-catalog.json on main, which every installed copy picks up within
 * the TTL. The baked catalog stays the floor, so the pickers are never empty and
 * never wait on the network.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getText } from './fetchText';
import { resolveCommand, userShellPath } from './shellEnv';
import { parseModelCatalog, type CatalogModel, type ModelCatalog } from '../shared/modelCatalogPayload';

const execFileAsync = promisify(execFile);

const CATALOG_URL =
  'https://raw.githubusercontent.com/chaitanyagiri/munder-difflin/main/docs/model-catalog.json';

/** Models ship on a human timescale, and a stale list costs the user nothing —
 *  every command field in the app stays editable. Six hours matches the hero
 *  payload; a launch after that refreshes in the background. */
const TTL_MS = 6 * 60 * 60 * 1000;

export interface RemoteCatalogResult {
  /** null = nothing usable came back; the caller keeps its baked catalog. */
  catalog: ModelCatalog | null;
  /** 0 when nothing has ever been fetched. */
  fetchedAt: number;
  /** True when this is a cached or absent copy rather than a fresh fetch. */
  stale: boolean;
}

export async function loadModelCatalog(
  cachePath: string,
  opts: { force?: boolean } = {}
): Promise<RemoteCatalogResult> {
  let cached: { catalog: ModelCatalog; fetchedAt: number } | null = null;
  try {
    if (existsSync(cachePath)) {
      const read = JSON.parse(readFileSync(cachePath, 'utf8'));
      // Re-validate on READ, not only on fetch. The cache is a file on disk that
      // a previous build wrote; a schema bump or a hand-edit must not reach the
      // pickers unchecked just because it once passed.
      const catalog = parseModelCatalog(read?.catalog);
      if (catalog && typeof read.fetchedAt === 'number') {
        cached = { catalog, fetchedAt: read.fetchedAt };
      }
    }
  } catch { cached = null; }

  if (cached && !opts.force && Date.now() - cached.fetchedAt < TTL_MS) {
    return { catalog: cached.catalog, fetchedAt: cached.fetchedAt, stale: false };
  }

  try {
    const body = await getText(CATALOG_URL, { timeoutMs: 8000 });
    // Parse the JSON and the SHAPE separately: valid JSON that is not a catalog
    // must fall back, not reach a picker as undefined rows.
    const catalog = parseModelCatalog(JSON.parse(body));
    if (!catalog) throw new Error('not a model catalog');
    const payload = { catalog, fetchedAt: Date.now() };
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify(payload));
    } catch { /* the cache is an optimisation, not the feature */ }
    return { ...payload, stale: false };
  } catch {
    if (cached) return { catalog: cached.catalog, fetchedAt: cached.fetchedAt, stale: true };
    return { catalog: null, fetchedAt: 0, stale: true };
  }
}

// ─── the LIVE catalog: what the installed CLIs say they can reach ───────────
/**
 * The baked and remote catalogs are both curated lists — someone decided what
 * belongs in them. Neither knows what models THIS machine can actually reach,
 * which depends on the user's account, plan and keys: `opencode models` reports
 * ~380 slugs against the user's own providers, and `agy models` reports whatever
 * the logged-in Antigravity account is entitled to.
 *
 * So the pickers ask. The curated list stays the floor — it carries the readable
 * labels, the editorial ordering and any version bounds — and the live list is
 * appended to it. A CLI that is missing, logged out, or slow contributes
 * nothing, which degrades to exactly the behaviour that shipped before.
 */

/** `opencode models` prints one `provider/model-id` slug per line and nothing
 *  else. The slug IS the `--model` value, so it is both id and label; the
 *  curated entries that carry a prettier label win the merge anyway. */
export function parseOpenCodeModels(stdout: string): CatalogModel[] {
  return stdout.split('\n')
    .map((line) => line.trim())
    // A slug always has a provider prefix. Requiring the '/' is what skips the
    // blank lines and any status chatter the CLI decides to print.
    .filter((line) => line.length > 0 && line.includes('/') && !line.startsWith('#'))
    .map((id) => ({ id, label: id }));
}

/** `agy models` prints `<slug>\t<Display Name>` per model, after a
 *  'Fetching available models...' status line that carries no tab.
 *
 *  THE ID IS THE DISPLAY NAME, NOT THE SLUG. `agy --model` takes the label
 *  exactly as printed — verified against agy's own log line, `Propagating
 *  selected model override … label="…"` — which is why every curated antigravity
 *  entry carries an id like 'Gemini 3.1 Pro (High)', spaces and parens included.
 *  Taking the slug column here produced both a `--model` value agy rejects and a
 *  dedupe that never matched its curated twin, so the picker filled with
 *  duplicates that could not be selected. */
export function parseAgyModels(stdout: string): CatalogModel[] {
  return stdout.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.includes('\t'))
    .map((line) => {
      const [, ...rest] = line.split('\t');
      return rest.join('\t').trim();
    })
    // A row with no display name is DROPPED, not backfilled from its slug. The
    // slug is not a substitute: it is precisely the value agy refuses, so
    // guessing one here would rebuild the bug this parser exists to avoid.
    .filter((label) => label.length > 0)
    .map((label) => ({ id: label, label }));
}

/** Append the live list to the curated one, dropping anything already named.
 *
 *  Curated entries WIN on a collision: they carry the readable label and any
 *  version bounds, and the CLI only knows the raw id. Their hand-ordered
 *  sequence is preserved too — that order is editorial, recommended picks first
 *  — and only the appended tail is sorted, because a CLI emits its list in no
 *  order a human scrolling or filtering can predict. */
export function mergeCliModels(base: CatalogModel[], live: CatalogModel[]): CatalogModel[] {
  const seen = new Set(base.map((model) => model.id));
  const added: CatalogModel[] = [];
  for (const model of live) {
    // Guards the curated list AND a CLI that prints a slug twice; a duplicate id
    // is a duplicate row and a duplicate React key.
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    added.push(model);
  }
  added.sort((a, b) => (a.id ?? '').localeCompare(b.id ?? ''));
  return [...base, ...added];
}

/** How long a CLI's answer is reused.
 *
 *  This is NOT the cheap lookup its call site makes it look like: `agy models`
 *  round-trips to Google and takes ~6s, and every `models:catalog` request would
 *  otherwise spawn both CLIs and wait on the network. The window is short
 *  relative to the remote catalog's six hours because a CLI's list changes when
 *  the user logs in or switches plan — within a session, not between releases. */
const CLI_TTL_MS = 10 * 60 * 1000;

/** `agy models` is a network call behind a CLI; 5s was not enough for it and the
 *  probe came back empty on a healthy machine. */
const CLI_TIMEOUT_MS = 15_000;

const cliCache = new Map<string, { at: number; models: CatalogModel[] }>();

/** Reset point for the tests, which must not inherit a previous file's cache. */
export function clearCliModelCache(): void {
  cliCache.clear();
}

/** Run `<cli> models` and parse it, or return [] for any reason at all.
 *
 *  A missing CLI, a logged-out CLI and a timed-out CLI are all the same answer
 *  here — "nothing to add" — because the curated list is already rendering and
 *  there is no action the user could take from an error they did not ask for. */
async function probeCli(
  command: string,
  parse: (stdout: string) => CatalogModel[]
): Promise<CatalogModel[]> {
  try {
    const { stdout } = await execFileAsync(resolveCommand(command), ['models'], {
      timeout: CLI_TIMEOUT_MS,
      shell: process.platform === 'win32',
      // A packaged app does NOT inherit the login shell's PATH — an .AppImage or
      // .deb launched from the desktop sees a minimal environment, so `agy` and
      // `opencode` were simply not found and the probe failed silently. The
      // user's real PATH has to be injected explicitly.
      env: { ...process.env, PATH: userShellPath() }
    });
    return parse(stdout);
  } catch {
    return [];
  }
}

/** The live model lists, per provider key, cached behind {@link CLI_TTL_MS}. */
export async function loadCliModels(
  opts: { force?: boolean } = {}
): Promise<Record<string, CatalogModel[]>> {
  const probes: [string, string, (stdout: string) => CatalogModel[]][] = [
    ['opencode', 'opencode', parseOpenCodeModels],
    ['antigravity', 'agy', parseAgyModels]
  ];
  const entries = await Promise.all(probes.map(async ([provider, command, parse]) => {
    const hit = cliCache.get(provider);
    if (hit && !opts.force && Date.now() - hit.at < CLI_TTL_MS) return [provider, hit.models] as const;
    const models = await probeCli(command, parse);
    // Only a NON-EMPTY answer is worth caching. Caching the empty one would pin
    // the pickers short for the whole TTL after a single transient failure.
    if (models.length > 0) cliCache.set(provider, { at: Date.now(), models });
    return [provider, models] as const;
  }));
  return Object.fromEntries(entries);
}
