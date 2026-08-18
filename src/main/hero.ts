/**
 * Fetch + cache the Settings hero payload.
 *
 * Same shape as the skills catalog: served from cache when fresh, refreshed in
 * the background otherwise, and NEVER fatal — a failed fetch falls back to the
 * cached copy, then to the defaults compiled into the app. The card must render
 * instantly and offline, because it sits at the top of a dialog people open to
 * change a folder.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getText } from './fetchText';
import { parseHeroPayload, DEFAULT_HERO, type HeroPayload } from '../shared/heroPayload';

const HERO_URL =
  'https://raw.githubusercontent.com/SparshSunilNaik/munder-difflin/main/docs/hero.json';
/** Plan copy and sponsors change on a human timescale. */
const TTL_MS = 6 * 60 * 60 * 1000;

export async function loadHero(
  cachePath: string,
  opts: { force?: boolean } = {}
): Promise<{ hero: HeroPayload; fetchedAt: number; stale: boolean }> {
  let cached: { hero: HeroPayload; fetchedAt: number } | null = null;
  try {
    if (existsSync(cachePath)) cached = JSON.parse(readFileSync(cachePath, 'utf8'));
  } catch { cached = null; }

  if (cached && !opts.force && Date.now() - cached.fetchedAt < TTL_MS) {
    return { hero: cached.hero, fetchedAt: cached.fetchedAt, stale: false };
  }

  try {
    const body = await getText(HERO_URL, { timeoutMs: 8000 });
    // Parse the JSON and the SHAPE separately: valid JSON that is not a hero
    // payload must still degrade to defaults rather than render as undefined.
    const hero = parseHeroPayload(JSON.parse(body));
    const payload = { hero, fetchedAt: Date.now() };
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify(payload));
    } catch { /* cache is an optimisation */ }
    return { ...payload, stale: false };
  } catch {
    if (cached) return { hero: cached.hero, fetchedAt: cached.fetchedAt, stale: true };
    return { hero: DEFAULT_HERO, fetchedAt: 0, stale: true };
  }
}
