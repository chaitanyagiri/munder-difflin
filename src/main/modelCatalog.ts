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
import { getText } from './fetchText';
import { parseModelCatalog, type ModelCatalog } from '../shared/modelCatalogPayload';

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
