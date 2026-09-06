/**
 * The model catalog's shape, and the total parser for the REMOTE copy of it.
 *
 * There are two copies of this catalog and they do different jobs:
 *
 *   - `src/shared/modelCatalog.json` is compiled INTO the build. It is what the
 *     pickers show offline, on first launch, and whenever the remote copy is
 *     missing or unreadable. Shipping a model here still means shipping a build.
 *   - `docs/model-catalog.json` in this repo is fetched at runtime from
 *     raw.githubusercontent. Editing that one file on GitHub puts a new model in
 *     every installed copy of the app within the TTL, with no release.
 *
 * The remote copy is DATA, never markup — same contract as the Settings hero
 * payload (src/shared/heroPayload.ts), for the same reasons:
 *
 *   - every field lands in a React `<option>` as a text node, so it is escaped;
 *   - `id` is spliced into an agent's spawn command line as the `--model` value,
 *     so it is LENGTH-CAPPED and NEWLINE-FREE. A model id is a slug, and letting
 *     an unbounded remote string reach a command line is the one genuinely sharp
 *     edge on this path;
 *   - a `version` that is not the schema this build understands is REJECTED
 *     whole, so a future schema change cannot half-apply to an old build;
 *   - unknown fields are ignored and anything malformed falls back to the baked
 *     catalog, so a bad edit degrades to "the models this build shipped with"
 *     rather than to an empty picker.
 *
 * `parseModelCatalog` never throws. It returns null for "nothing usable here,
 * keep what you have", never a partially-built catalog.
 */

/** One row of the catalog. `minAppVersion` / `maxAppVersion` are INCLUSIVE app
 *  version bounds; null (or an absent key) means unbounded in that direction.
 *  See the long note on the filter in src/renderer/src/store/config.ts. */
export interface CatalogModel {
  /** absent = use the CLI default (no --model flag) */
  id?: string;
  label: string;
  minAppVersion?: string | null;
  maxAppVersion?: string | null;
}

export interface ModelCatalog {
  version: number;
  providers: Record<string, CatalogModel[]>;
}

/** The only schema version this build can read. A remote catalog announcing
 *  anything else is ignored in full — that is the escape hatch that lets the
 *  shape change later without breaking every shipped build in the field. */
export const CATALOG_SCHEMA_VERSION = 1;

const MAX = {
  /** A model id is a slug or a display name agy echoes back; nothing legitimate
   *  is anywhere near this long, and it ends up on a command line. */
  id: 120,
  label: 60,
  /** Provider keys are the ids in AGENT_PROVIDER_PRESETS. */
  key: 40,
  version: 24,
  providers: 40,
  models: 60
};

/** A single-line, trimmed, capped string — or null if there is nothing usable.
 *  Control characters are neutralised rather than escaped: an id carrying a
 *  newline or a NUL would be a command-line splice, and a label carrying one
 *  would break the option row. Neither has a legitimate reason to contain one. */
function str(value: unknown, cap: number): string | null {
  if (typeof value !== 'string') return null;
  // Control characters are replaced, not stripped, so two words never fuse.
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > cap ? clean.slice(0, cap) : clean;
}

/** A version bound. Kept as a plain capped string — the comparison in config.ts
 *  is already total and treats anything unparseable as "no bound". */
function bound(value: unknown): string | null {
  return str(value, MAX.version);
}

/** One catalog row, or null if it cannot be rendered. A row with no label is
 *  dropped: an option the user cannot read is worse than a missing option. */
function parseModel(raw: unknown): CatalogModel | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const label = str(o.label, MAX.label);
  if (!label) return null;
  const model: CatalogModel = { label };
  // An absent OR empty id means "pass no --model flag", which is a real option
  // several providers carry. Only a non-empty string becomes an id.
  const id = str(o.id, MAX.id);
  if (id) model.id = id;
  const min = bound(o.minAppVersion);
  const max = bound(o.maxAppVersion);
  if (min) model.minAppVersion = min;
  if (max) model.maxAppVersion = max;
  return model;
}

/** A provider key: the ids the app already knows, or a new one a later release
 *  will know. Restricted to slug characters so a stray key cannot collide with
 *  an object prototype member when the map is indexed. */
function parseKey(key: string): string | null {
  if (key.length > MAX.key) return null;
  if (!/^[a-z][a-z0-9_-]*$/i.test(key)) return null;
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return null;
  return key;
}

/**
 * Turn whatever came off the network into a catalog, or null.
 *
 * A provider survives only if its value is an array AND either that array was
 * empty (a deliberate "offer nothing", which is what `custom` is) or at least
 * one of its rows parsed. A provider whose rows ALL failed is dropped entirely,
 * so a mangled entry costs the user that provider's remote list and they fall
 * back to the models the build shipped with — never an empty picker.
 */
export function parseModelCatalog(raw: unknown): ModelCatalog | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.version !== CATALOG_SCHEMA_VERSION) return null;
  if (!o.providers || typeof o.providers !== 'object' || Array.isArray(o.providers)) return null;

  const providers: Record<string, CatalogModel[]> = Object.create(null);
  let kept = 0;
  for (const [rawKey, rawList] of Object.entries(o.providers as Record<string, unknown>)) {
    if (kept >= MAX.providers) break;
    const key = parseKey(rawKey);
    if (!key || !Array.isArray(rawList)) continue;

    const models: CatalogModel[] = [];
    // The same id twice would render two identical options and make the picker
    // look broken. First one wins, as it does in the baked catalog.
    const seen = new Set<string>();
    for (const entry of rawList.slice(0, MAX.models)) {
      const model = parseModel(entry);
      if (!model) continue;
      const dedupe = model.id ?? '';
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      models.push(model);
    }
    if (models.length === 0 && rawList.length > 0) continue;
    providers[key] = models;
    kept += 1;
  }

  if (kept === 0) return null;
  // Object.create(null) has no prototype, which is the point above, but it also
  // is not a plain object for structuredClone across the IPC boundary.
  return { version: CATALOG_SCHEMA_VERSION, providers: { ...providers } };
}
