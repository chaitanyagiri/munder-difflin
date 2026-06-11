/**
 * Hire-manifest transport for the main process: fetch a manifest from an https
 * URL (deep link) or read one from disk (file import), and validate it via the
 * shared, dependency-free validator. See `src/shared/hire.ts` for the spec and
 * security model. Deliberately free of any `electron` import so it can be
 * smoke-tested as a plain Node module (mirrors webhook.ts's approach).
 */
import { readFileSync, statSync } from 'node:fs';
import {
  HIRE_MAX_BYTES,
  isAllowedManifestUrl,
  validateHireManifest,
  type HireManifest,
  type HireValidation
} from '../shared/hire';

export type HireResult = { ok: true; manifest: HireManifest } | { ok: false; error: string };

function finish(v: HireValidation): HireResult {
  if (v.ok && v.manifest) return { ok: true, manifest: v.manifest };
  return { ok: false, error: `invalid hire manifest: ${v.errors.join('; ')}` };
}

/** Fetch + validate a hire manifest from an https URL. Bounded: 10s timeout,
 *  64 KB body cap, https only (the deep-link parser already enforces https,
 *  but this is also called with user-pasted URLs). */
export async function fetchHireManifest(src: string): Promise<HireResult> {
  let url: URL;
  try { url = new URL(src); } catch { return { ok: false, error: 'not a valid URL' }; }
  if (!isAllowedManifestUrl(url)) return { ok: false, error: 'manifest URL must be https (http allowed for localhost only)' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    // redirect:'manual' — `follow` would only validate the INITIAL url, so a
    // remote https manifest could 302 to http://127.0.0.1:PORT/... or a cloud
    // metadata endpoint, turning a clicked link into a blind GET to an internal
    // service. We follow hops ourselves and re-validate each Location.
    //   - the INITIAL url may be http-loopback (local gallery dev served over
    //     http://localhost) — isAllowedManifestUrl permits that;
    //   - a REDIRECT TARGET must be https. A real gallery never needs to bounce
    //     you into loopback/internal http, and requiring https on hops closes
    //     redirect-based SSRF to 127.0.0.1:PORT and link-local/metadata IPs
    //     outright, while https→https redirects (shorteners, CDNs) still work.
    let current = url;
    let res: Response | null = null;
    for (let hop = 0; hop < 5; hop++) {
      res = await fetch(current, {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: { accept: 'application/json' }
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return { ok: false, error: 'redirect without a location' };
        let next: URL;
        try { next = new URL(loc, current); } catch { return { ok: false, error: 'invalid redirect target' }; }
        if (next.protocol !== 'https:') return { ok: false, error: 'redirect target must be https (a manifest may not redirect into http/loopback)' };
        current = next;
        continue;
      }
      break;
    }
    if (!res) return { ok: false, error: 'fetch failed' };
    if (res.status >= 300 && res.status < 400) return { ok: false, error: 'too many redirects' };
    if (!res.ok) return { ok: false, error: `fetch failed: HTTP ${res.status}` };

    // Bound the body as we read it — content-length is attacker-controlled
    // (absent/chunked skips the check), and `res.text()` would buffer the whole
    // stream first, so a hostile host could stream unbounded data and OOM us
    // inside the 10s window. Read chunks, abort once bytes exceed the cap.
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > HIRE_MAX_BYTES) return { ok: false, error: 'manifest too large' };
    const text = await readBounded(res, HIRE_MAX_BYTES);
    if (text === null) return { ok: false, error: 'manifest too large' };

    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return { ok: false, error: 'manifest is not valid JSON' }; }
    return finish(validateHireManifest(parsed));
  } catch (e) {
    const msg = e instanceof Error && e.name === 'AbortError' ? 'fetch timed out' : String(e);
    return { ok: false, error: `fetch failed: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Read a response body, decoding as UTF-8, aborting once the byte count exceeds
 *  `maxBytes`. Returns null if the cap is exceeded. Byte-accurate (the cap is a
 *  byte limit, not UTF-16 code units). */
async function readBounded(res: Response, maxBytes: number): Promise<string | null> {
  const body = res.body;
  if (!body) {
    // No stream (e.g. some fetch polyfills) — fall back to text() with a post-check.
    const t = await res.text();
    return Buffer.byteLength(t, 'utf8') > maxBytes ? null : t;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) { try { await reader.cancel(); } catch { /* noop */ } return null; }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Read + validate a hire manifest from a local JSON file (file import). */
export function readHireManifestFile(path: string): HireResult {
  try {
    if (statSync(path).size > HIRE_MAX_BYTES) return { ok: false, error: 'manifest too large' };
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return finish(validateHireManifest(parsed));
  } catch (e) {
    return { ok: false, error: `could not read manifest: ${String(e)}` };
  }
}
