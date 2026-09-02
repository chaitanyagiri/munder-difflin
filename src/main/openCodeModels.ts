// Runtime model discovery for the OpenCode CLI.
//
// The Add-Agent model picker ships a small CURATED list of OpenCode slugs
// (src/shared/modelCatalog.json) because models.dev drifts and a hardcoded list
// goes stale. `opencode models` is the CLI's own source of truth — it prints the
// live catalog the user can actually reach (their authenticated providers plus
// models.dev), one `provider/model` slug per line. This module runs it once and
// parses those slugs so the renderer can merge them into the picker.
//
// Everything here is best-effort and provider-neutral in spirit: any failure
// (CLI absent, offline, non-zero exit, junk output) returns an EMPTY list, and
// the caller falls back to the static catalog. Discovery never blocks a hire.

import { spawnSync } from 'node:child_process';
import { resolveCommand, userShellPath } from './shellEnv';

/** Longest we let `opencode models` run before giving up. It hits models.dev on
 *  a cold run, so this is generous — but bounded, because it executes on the
 *  main process and a hang would freeze every window. */
const OPENCODE_MODELS_TIMEOUT_MS = 8000;

/** Cache the parsed list for the process lifetime. The catalog does not change
 *  mid-session, and each call boots a subprocess (and possibly a network round
 *  trip), so the picker should pay that cost at most once. Only a SUCCESSFUL,
 *  non-empty read is cached; an empty result stays retryable (the user may have
 *  just installed the CLI or authenticated a provider). */
let cached: string[] | null = null;

/** A plausible `provider/model` slug as printed by `opencode models`: at least
 *  one `provider/` segment, no whitespace, printable. Guards against rc-file
 *  chatter or an error banner sneaking into the list as if it were a model. */
function looksLikeSlug(line: string): boolean {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9./:_-]+$/.test(line);
}

/** Parse the raw stdout of `opencode models` into a de-duplicated slug list,
 *  preserving the CLI's own ordering (opencode/* first, then per provider).
 *  Exported so it can be unit-tested without spawning a process. */
export function parseOpenCodeModels(stdout: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !looksLikeSlug(line) || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

/** Run `opencode models` and return the live slug list, or [] on any failure.
 *
 *  Uses the shared PATH/binary resolution (shellEnv) so it finds `opencode` in a
 *  packaged app the same way agent spawns do — Electron on macOS starts without
 *  the login-shell PATH, so a bare `opencode` would ENOENT. */
export function listOpenCodeModels(): string[] {
  if (cached !== null) return cached;

  const bin = resolveCommand('opencode');
  try {
    const res = spawnSync(bin, ['models'], {
      encoding: 'utf8',
      timeout: OPENCODE_MODELS_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      // Give the child the user's real PATH so any tools opencode shells out to
      // resolve too, matching the environment an agent spawn would see.
      env: { ...process.env, PATH: userShellPath() }
    });
    // A non-zero exit, a signal (timeout kill), or a spawn error all mean "we
    // could not read the live list" — return empty and let the caller fall back.
    if (res.status !== 0 || res.error) return [];
    const models = parseOpenCodeModels(res.stdout ?? '');
    if (models.length > 0) cached = models;
    return models;
  } catch {
    return [];
  }
}
