/**
 * Hire-manifest transport for the main process: fetch a manifest from an https
 * URL (deep link) or read one from disk (file import), and validate it via the
 * shared, dependency-free validator. See `src/shared/hire.ts` for the spec and
 * security model. Deliberately free of any `electron` import so it can be
 * smoke-tested as a plain Node module (mirrors webhook.ts's approach).
 */
import { readFileSync, statSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
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

/** True if an IP LITERAL is in a range we must never fetch from (SSRF guard):
 *  loopback, RFC1918 private, link-local incl. the 169.254.169.254 cloud-metadata
 *  endpoint, CGNAT, ULA, and unspecified/multicast/reserved. https alone does NOT
 *  make a target safe — a remote manifest can point/redirect at https://10.x or
 *  https://169.254.169.254, so the resolved ADDRESS is what we gate on. */
function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const o = ip.split('.').map(Number);
    if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    if (o[0] === 0 || o[0] === 127) return true;                  // 0.0.0.0/8 unspecified, 127/8 loopback
    if (o[0] === 10) return true;                                 // 10.0.0.0/8
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;    // 172.16.0.0/12
    if (o[0] === 192 && o[1] === 168) return true;                // 192.168.0.0/16
    if (o[0] === 169 && o[1] === 254) return true;                // 169.254.0.0/16 link-local + metadata
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;   // 100.64.0.0/10 CGNAT
    if (o[0] >= 224) return true;                                 // 224.0.0.0/3 multicast/reserved
    return false;
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;           // loopback / unspecified
    // IPv4-mapped (::ffff:a.b.c.d) — judge by the embedded v4 address.
    if (lower.startsWith('::ffff:')) {
      const v4 = lower.slice(lower.lastIndexOf(':') + 1);
      if (isIP(v4) === 4) return isBlockedIp(v4);
    }
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10 link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 ULA
    return false;
  }
  return true; // not a parseable IP → fail closed
}

/** Resolve a host (or use the literal IP) and return true if ANY resolved
 *  address is in a blocked range. Unresolvable → blocked (fail closed). Closes
 *  the simple DNS-to-internal SSRF; a determined rebind between this lookup and
 *  fetch()'s own resolution is a residual we accept for v1 (no connection pinning). */
async function isInternalHost(hostname: string): Promise<boolean> {
  const host = hostname.replace('[', '').replace(']', ''); // strip IPv6 brackets
  if (isIP(host)) return isBlockedIp(host);
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.length === 0 || addrs.some((a) => isBlockedIp(a.address));
  } catch { return true; }
}

/** SSRF gate for ONE url — the initial request AND every redirect hop. The only
 *  internal target permitted is the documented http-loopback dev gallery (already
 *  gated by isAllowedManifestUrl); every other target must resolve to a PUBLIC
 *  address. Returns an error string when the target is internal, else null. */
async function assertPublicTarget(u: URL): Promise<string | null> {
  const devLoopbackHttp = u.protocol === 'http:' &&
    (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]');
  if (devLoopbackHttp) return null;
  if (await isInternalHost(u.hostname)) {
    return 'manifest URL resolves to a private/loopback/link-local address (SSRF blocked)';
  }
  return null;
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
    //   - AND the resolved ADDRESS of every target (initial + each hop) must be
    //     public: https://10.x / https://169.254.169.254 would otherwise sail
    //     through the https-only check. assertPublicTarget resolves DNS and
    //     blocks private/loopback/link-local/metadata IPs.
    const ssrf0 = await assertPublicTarget(url);
    if (ssrf0) return { ok: false, error: ssrf0 };
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
        const ssrfN = await assertPublicTarget(next);
        if (ssrfN) return { ok: false, error: ssrfN };
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
