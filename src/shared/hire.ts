/**
 * Shareable "hires" — portable agent role templates (manifest spec v1).
 *
 * A hire manifest is a small JSON document that describes a role-configured
 * agent (name, provider, model, flags, goal, budget) so it can be shared as a
 * file or hosted in a community gallery and imported with one click via the
 * `munderdifflin://hire?src=<https-url>` deep link or an in-app file picker.
 *
 * SECURITY MODEL — a manifest is untrusted input:
 *   - It can NEVER auto-spawn an agent. Importing only pre-fills the Add-Agent
 *     modal; the human reviews the final command and clicks spawn.
 *   - It cannot carry a raw executable/command. The spawn binary always comes
 *     from the locally configured provider preset; a manifest may only append
 *     flag-shaped arguments (validated below), which the modal shows in full.
 *   - All fields are length/shape-capped here, in one dependency-free module
 *     shared by main (deep link / file import) and renderer (prefill).
 */

export const HIRE_SPEC_V1 = 'munder-difflin/hire@1';

/** Providers a manifest may request ('agy' is accepted as an alias for
 *  'antigravity'). 'custom' is deliberately NOT allowed — it would let a
 *  manifest choose an arbitrary local binary. */
export type HireProvider = 'claude' | 'antigravity' | 'codex';

export interface HireManifest {
  /** Spec tag; exactly `munder-difflin/hire@1` for this version. */
  spec: typeof HIRE_SPEC_V1;
  /** Agent display name (also seeds the hive id). Required. */
  name: string;
  /** One-line role, e.g. "Documentation writer" — lands in identity.md + card. */
  description?: string;
  /** The standing goal/mission text pre-filled into the goal field. */
  goal?: string;
  /** Office cast sprite id (e.g. 'pam'); unknown values fall back to default. */
  character?: string;
  /** Accent color name (e.g. 'mint'); unknown values fall back to default. */
  accent?: string;
  /** Which CLI the role is designed for. Default: the user's default provider. */
  provider?: HireProvider;
  /** Model id/label for that provider (e.g. 'claude-sonnet-4-6'). */
  model?: string;
  /** Extra flag-shaped args appended to the locally-built spawn command.
   *  Each must look like a flag or a flag value (no shell metacharacters). */
  commandFlags?: string[];
  /** Capability tags for the hive registry (routing hints). */
  capabilities?: string[];
  /** Spawn in an isolated git worktree. */
  isolate?: boolean;
  /** Per-agent total-token ceiling, applied to agentTokenCaps after spawn. */
  tokenCap?: number;
  /** Attribution shown in the import preview. */
  author?: string;
  /** Manifest home (gallery page). https only. */
  homepage?: string;
}

export interface HireValidation {
  ok: boolean;
  manifest?: HireManifest;
  errors: string[];
}

const PROVIDERS: readonly string[] = ['claude', 'antigravity', 'codex'];
const MAX_BYTES = 64 * 1024;

/** A flag ("-x", "--flag", "--flag=value") or a bare value token that may follow
 *  a flag. Letters/digits plus a conservative punctuation set; no quotes,
 *  backticks, semicolons, pipes, ampersands, redirects, percent (cmd.exe
 *  %VAR% env-expansion), or whitespace. Args are passed to node-pty as argv
 *  (no shell), so this is defense in depth. */
const FLAG_RE = /^[A-Za-z0-9._\/=:,@+-]{1,100}$/;

/** Allowed characters in a model id/label. Model values flow into the spawn
 *  command line (`--model <value>`), so this MUST reject shell metacharacters —
 *  on Windows a `.cmd`/`.bat` provider shim routes the command through cmd.exe,
 *  where an unquoted `&`/`|`/`^`/`<`/`>`/`(`/`)` would chain a second command.
 *  Real model ids/labels only need letters, digits, spaces, and a little
 *  punctuation: `claude-sonnet-4-6[1m]`, `Gemini 3.1 Pro (High)`. No quotes,
 *  backticks, `$`, `;`, `&`, `|`, `^`, `<`, `>`, `%`, `!`. (The command field
 *  stays editable, so a legitimate exotic value can still be typed by hand.) */
const MODEL_RE = /^[A-Za-z0-9 ._()[\]\/:@+-]{1,80}$/;

function str(v: unknown): v is string { return typeof v === 'string'; }

function capped(v: unknown, max: number, field: string, errors: string[], required = false): string | undefined {
  if (v === undefined || v === null) {
    if (required) errors.push(`"${field}" is required`);
    return undefined;
  }
  if (!str(v)) { errors.push(`"${field}" must be a string`); return undefined; }
  const t = v.trim();
  if (required && !t) { errors.push(`"${field}" must not be empty`); return undefined; }
  if (t.length > max) { errors.push(`"${field}" exceeds ${max} chars`); return undefined; }
  return t || undefined;
}

/** Validate an untrusted parsed JSON value into a HireManifest. Pure; no I/O. */
export function validateHireManifest(raw: unknown): HireValidation {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['manifest must be a JSON object'] };
  }
  const o = raw as Record<string, unknown>;

  if (o.spec !== HIRE_SPEC_V1) {
    return { ok: false, errors: [`unsupported spec "${String(o.spec)}" (expected "${HIRE_SPEC_V1}")`] };
  }

  const name = capped(o.name, 40, 'name', errors, true);
  const description = capped(o.description, 200, 'description', errors);
  const goal = capped(o.goal, 4000, 'goal', errors);
  const character = capped(o.character, 24, 'character', errors)?.toLowerCase();
  const accent = capped(o.accent, 24, 'accent', errors)?.toLowerCase();
  const model = capped(o.model, 80, 'model', errors);
  if (model !== undefined && !MODEL_RE.test(model)) {
    errors.push('"model" contains disallowed characters (it goes onto the spawn command line; letters, digits, spaces and . _ - ( ) [ ] / : @ + only)');
  }
  const author = capped(o.author, 80, 'author', errors);
  const homepage = capped(o.homepage, 300, 'homepage', errors);

  let provider: HireProvider | undefined;
  if (o.provider !== undefined) {
    const p = str(o.provider) ? (o.provider === 'agy' ? 'antigravity' : o.provider) : o.provider;
    if (str(p) && PROVIDERS.includes(p)) provider = p as HireProvider;
    else errors.push(`"provider" must be one of ${PROVIDERS.join(', ')} (or "agy")`);
  }

  let commandFlags: string[] | undefined;
  if (o.commandFlags !== undefined) {
    if (!Array.isArray(o.commandFlags) || o.commandFlags.length > 16) {
      errors.push('"commandFlags" must be an array of at most 16 items');
    } else {
      commandFlags = [];
      for (const f of o.commandFlags) {
        if (!str(f) || !FLAG_RE.test(f)) { errors.push(`commandFlags entry ${JSON.stringify(f)} is not a safe flag token`); continue; }
        commandFlags.push(f);
      }
      // The FIRST entry must actually be flag-shaped; later bare tokens are
      // allowed as values for a preceding flag.
      if (commandFlags.length > 0 && !commandFlags[0].startsWith('-')) {
        errors.push('"commandFlags" must start with a flag (e.g. "--max-turns")');
      }
      if (commandFlags.length === 0) commandFlags = undefined;
    }
  }

  let capabilities: string[] | undefined;
  if (o.capabilities !== undefined) {
    if (!Array.isArray(o.capabilities) || o.capabilities.length > 12) {
      errors.push('"capabilities" must be an array of at most 12 items');
    } else {
      capabilities = o.capabilities.filter(str).map(c => c.trim().slice(0, 40)).filter(Boolean);
      if (capabilities.length === 0) capabilities = undefined;
    }
  }

  let isolate: boolean | undefined;
  if (o.isolate !== undefined) {
    if (typeof o.isolate === 'boolean') isolate = o.isolate;
    else errors.push('"isolate" must be a boolean');
  }

  let tokenCap: number | undefined;
  if (o.tokenCap !== undefined) {
    if (typeof o.tokenCap === 'number' && Number.isInteger(o.tokenCap) && o.tokenCap > 0 && o.tokenCap <= 1e10) tokenCap = o.tokenCap;
    else errors.push('"tokenCap" must be a positive integer (max 1e10)');
  }

  if (homepage && !homepage.startsWith('https://')) errors.push('"homepage" must be https');

  if (errors.length > 0 || !name) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    manifest: { spec: HIRE_SPEC_V1, name, description, goal, character, accent, provider, model, commandFlags, capabilities, isolate, tokenCap, author, homepage }
  };
}

/** Parse a `munderdifflin://hire?src=<https-url>` deep link. Returns the https
 *  manifest URL, or null if the link is not a well-formed hire link. */
export function parseHireDeepLink(link: string): string | null {
  let u: URL;
  try { u = new URL(link); } catch { return null; }
  if (u.protocol !== 'munderdifflin:') return null;
  // Both munderdifflin://hire?src= (host) and munderdifflin:hire?src= (path).
  const action = (u.host || u.pathname.replace(/^\/+/, '')).toLowerCase();
  if (action !== 'hire') return null;
  const src = u.searchParams.get('src');
  if (!src) return null;
  let s: URL;
  try { s = new URL(src); } catch { return null; }
  if (!isAllowedManifestUrl(s)) return null;
  return s.toString();
}

/** https everywhere; plain http is allowed ONLY for loopback (local gallery
 *  development) — a remote page can never point the app at an http manifest. */
export function isAllowedManifestUrl(u: URL): boolean {
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
}

/** Byte cap shared by the deep-link fetcher and the file importer. */
export const HIRE_MAX_BYTES = MAX_BYTES;
