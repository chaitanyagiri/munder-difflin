/**
 * Hire-manifest transport for the main process: fetch a manifest from an https
 * URL (deep link) or read one from disk (file import), and validate it via the
 * shared, dependency-free validator. See `src/shared/hire.ts` for the spec and
 * security model. Deliberately free of any `electron` import so it can be
 * smoke-tested as a plain Node module (mirrors webhook.ts's approach).
 */
import { readFileSync, statSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
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

/** Address ranges we must never fetch from (SSRF guard): loopback, RFC1918
 *  private, link-local incl. the 169.254.169.254 cloud-metadata endpoint, CGNAT,
 *  ULA, deprecated site-local, and unspecified/multicast/reserved. https alone
 *  does NOT make a target safe — a remote manifest can point/redirect at
 *  https://10.x or https://169.254.169.254, so the resolved ADDRESS is gated.
 *  node:net's BlockList does real prefix-membership (subnet math), which replaces
 *  the earlier hand-rolled v6 string-prefix logic that a v4-mapped hex form
 *  (e.g. ::ffff:7f00:1, the shape `new URL()` actually emits) sailed straight
 *  past. v4-in-v6 forms are de-mapped to their embedded v4 below before checking. */
const SSRF_BLOCK = new BlockList();
// IPv4 ranges.
SSRF_BLOCK.addSubnet('0.0.0.0', 8, 'ipv4');        // 0.0.0.0/8 "this network" / unspecified
SSRF_BLOCK.addSubnet('10.0.0.0', 8, 'ipv4');       // RFC1918
SSRF_BLOCK.addSubnet('100.64.0.0', 10, 'ipv4');    // CGNAT
SSRF_BLOCK.addSubnet('127.0.0.0', 8, 'ipv4');      // loopback
SSRF_BLOCK.addSubnet('169.254.0.0', 16, 'ipv4');   // link-local + 169.254.169.254 cloud metadata
SSRF_BLOCK.addSubnet('172.16.0.0', 12, 'ipv4');    // RFC1918
SSRF_BLOCK.addSubnet('192.168.0.0', 16, 'ipv4');   // RFC1918
SSRF_BLOCK.addSubnet('224.0.0.0', 3, 'ipv4');      // 224/4 multicast + 240/4 reserved + broadcast
// IPv6 ranges.
SSRF_BLOCK.addAddress('::1', 'ipv6');              // loopback
SSRF_BLOCK.addAddress('::', 'ipv6');               // unspecified
SSRF_BLOCK.addSubnet('fc00::', 7, 'ipv6');         // ULA (fc00::/7)
SSRF_BLOCK.addSubnet('fe80::', 10, 'ipv6');        // link-local (fe80::/10)
SSRF_BLOCK.addSubnet('fec0::', 10, 'ipv6');        // deprecated site-local (fec0::/10)
SSRF_BLOCK.addSubnet('ff00::', 8, 'ipv6');         // multicast (ff00::/8)

/** Expand an IPv6 literal into its eight 16-bit groups, handling `::` compression
 *  and a trailing embedded dotted-quad. Returns null if malformed (→ fail closed). */
function v6Groups(v6: string): number[] | null {
  let s = v6;
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct); // drop any zone id
  // A trailing dotted-quad (e.g. ::ffff:127.0.0.1) becomes two hex groups.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const o = tail.split('.').map(Number);
    if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((o[0] << 8) | o[1]).toString(16);
    const lo = ((o[2] << 8) | o[3]).toString(16);
    s = s.slice(0, lastColon + 1) + hi + ':' + lo;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const back = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let groups: string[];
  if (back === null) {
    groups = head; // no `::`
  } else {
    const missing = 8 - head.length - back.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill('0'), ...back];
  }
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.some((n) => Number.isNaN(n)) ? null : nums;
}

/** If a v6 literal embeds an IPv4 destination — v4-mapped `::ffff:a.b.c.d` (in
 *  BOTH dotted and hex-group form), the deprecated v4-compatible `::a.b.c.d`,
 *  NAT64 `64:ff9b::/96`, or 6to4 `2002::/16` — return that dotted v4 so the v4
 *  classifier gates it. These all route to a v4 destination, and the hex-group
 *  form is exactly what bypassed the old textual v6 check. Else null. */
function embeddedV4(v6: string): string | null {
  const g = v6Groups(v6);
  if (!g) return null;
  const v4 = (hi: number, lo: number): string => `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  const top6zero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
  if (top6zero && g[5] === 0xffff) return v4(g[6], g[7]);                            // ::ffff:a.b.c.d (v4-mapped)
  if (top6zero && g[5] === 0 && (g[6] !== 0 || g[7] !== 0)) return v4(g[6], g[7]);   // ::a.b.c.d / ::1 (v4-compatible)
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return v4(g[6], g[7]); // NAT64 64:ff9b::/96
  if (g[0] === 0x2002) return v4(g[1], g[2]);                                        // 6to4 2002::/16
  return null;
}

/** True if an IP LITERAL resolves into a blocked range. v4-in-v6 forms are
 *  de-mapped to the embedded v4 first; anything not parseable as an IP fails
 *  closed (returns true). */
function isBlockedIp(ip: string): boolean {
  const addr = ip.trim().toLowerCase();
  const kind = isIP(addr);
  if (kind === 4) return SSRF_BLOCK.check(addr, 'ipv4');
  if (kind === 6) {
    const v4 = embeddedV4(addr);
    if (v4 && isIP(v4) === 4) return SSRF_BLOCK.check(v4, 'ipv4');
    return SSRF_BLOCK.check(addr, 'ipv6');
  }
  return true; // not a parseable IP literal → fail closed
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
