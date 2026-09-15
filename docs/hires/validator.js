/* Shared client-side hire-manifest validator — mirrors src/shared/hire.ts in
   the app. Loaded by both the gallery (app.js) and the hiring desk (submit.js). */

'use strict';

window.HireSpec = (function () {
  const SPEC = 'munder-difflin/hire@1';
  const PROVIDERS = ['claude', 'antigravity', 'codex', 'cursor'];
  const PROVIDER_LABEL = { claude: 'Claude Code', antigravity: 'Antigravity', codex: 'Codex', cursor: 'Cursor' };
  const FLAG_RE = /^[A-Za-z0-9._\/=:,@+-]{1,100}$/;
  // Keep these allowlists in lockstep with src/shared/hire.ts and
  // src/shared/mcpCatalog.ts. test/hire-validator-parity.test.cjs locks the
  // browser validator to the canonical runtime validator.
  const SAFE_FLAG_NAMES = new Set(['--model', '--max-turns', '--output-format', '--verbose']);
  const BUNDLED_SKILL_IDS = new Set(['md-hive-sync', 'md-fetch-summarize', 'md-audit']);
  const MCP_SERVER_IDS = new Set([
    'sequential-thinking', 'time', 'fetch', 'context7', 'filesystem', 'git',
    'github-token', 'db', 'email-calendar', 'search-with-key'
  ]);
  // model flows onto the spawn command line — reject shell metacharacters
  // (mirror of MODEL_RE in the app's src/shared/hire.ts).
  const MODEL_RE = /^[A-Za-z0-9 ._()[\]\/:@+-]{1,80}$/;
  const CAST = ['michael', 'jim', 'pam', 'dwight', 'kevin', 'angela', 'oscar', 'stanley',
    'phyllis', 'andy', 'kelly', 'ryan', 'toby', 'creed', 'meredith'];
  const ACCENTS = ['coral', 'mint', 'sky', 'lemon', 'lilac', 'peach'];

  function normalizeProvider(p) { return p === 'agy' ? 'antigravity' : p; }
  function isSafeFlag(token) {
    if (!token.startsWith('-')) return false;
    return SAFE_FLAG_NAMES.has(token.split('=', 1)[0].toLowerCase());
  }

  function validate(raw) {
    const errors = [];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, errors: ['manifest must be a JSON object'] };
    }
    if (raw.spec !== SPEC) return { ok: false, errors: ['unsupported spec (expected "' + SPEC + '")'] };
    const str = (v) => typeof v === 'string';
    const cap = (v, max, field, required) => {
      if (v === undefined || v === null) { if (required) errors.push('"' + field + '" is required'); return; }
      if (!str(v)) { errors.push('"' + field + '" must be a string'); return; }
      if (required && !v.trim()) errors.push('"' + field + '" must not be empty');
      if (v.trim().length > max) errors.push('"' + field + '" exceeds ' + max + ' chars');
    };
    cap(raw.name, 40, 'name', true);
    cap(raw.description, 200, 'description');
    cap(raw.goal, 4000, 'goal');
    cap(raw.character, 24, 'character');
    cap(raw.accent, 24, 'accent');
    cap(raw.model, 80, 'model');
    if (str(raw.model) && raw.model.trim() && !MODEL_RE.test(raw.model.trim())) {
      errors.push('"model" contains disallowed characters (it goes onto the spawn command line; letters, digits, spaces and . _ - ( ) [ ] / : @ + only)');
    }
    cap(raw.author, 80, 'author');
    cap(raw.homepage, 300, 'homepage');
    if (raw.provider !== undefined) {
      const p = normalizeProvider(raw.provider);
      if (!PROVIDERS.includes(p)) errors.push('"provider" must be claude, antigravity (or agy), codex, or cursor');
    }
    if (raw.commandFlags !== undefined) {
      if (!Array.isArray(raw.commandFlags) || raw.commandFlags.length > 16) {
        errors.push('"commandFlags" must be an array of at most 16 items');
      } else {
        let valueAllowed = false;
        raw.commandFlags.forEach((f, index) => {
          if (!str(f) || !FLAG_RE.test(f)) {
            errors.push('commandFlags entry ' + JSON.stringify(f) + ' is not a safe flag token');
            valueAllowed = false;
            return;
          }
          if (index === 0 && !f.startsWith('-')) {
            errors.push('"commandFlags" must start with a flag (e.g. "--model")');
            valueAllowed = false;
            return;
          }
          if (f.startsWith('-')) {
            if (!isSafeFlag(f)) {
              errors.push('commandFlags entry ' + JSON.stringify(f) + ' is not in the shared-hire safe-flag list (' + Array.from(SAFE_FLAG_NAMES).join(', ') + ')');
              valueAllowed = false;
              return;
            }
            valueAllowed = !f.includes('=');
          } else {
            if (!valueAllowed) {
              errors.push('commandFlags entry ' + JSON.stringify(f) + ' is not allowed here (a value may only follow an allowed flag such as "--model")');
              return;
            }
            valueAllowed = false;
          }
        });
      }
    }
    if (raw.skills !== undefined) {
      if (!Array.isArray(raw.skills) || raw.skills.length > 8) {
        errors.push('"skills" must be an array of at most 8 items');
      } else {
        raw.skills.forEach((skill) => {
          if (!str(skill) || !skill.trim()) {
            errors.push('"skills" entries must be non-empty strings');
          } else if (!BUNDLED_SKILL_IDS.has(skill.trim())) {
            errors.push('"skills" entry ' + JSON.stringify(skill.trim()) + ' is not a bundled skill id');
          }
        });
      }
    }
    if (raw.mcpServers !== undefined) {
      if (!Array.isArray(raw.mcpServers) || raw.mcpServers.length > 8) {
        errors.push('"mcpServers" must be an array of at most 8 items');
      } else {
        raw.mcpServers.forEach((server) => {
          if (!str(server) || !server.trim()) {
            errors.push('"mcpServers" entries must be non-empty strings');
          } else if (!MCP_SERVER_IDS.has(server.trim())) {
            errors.push('"mcpServers" entry ' + JSON.stringify(server.trim()) + ' is not a known catalog id');
          }
        });
      }
    }
    if (raw.capabilities !== undefined && (!Array.isArray(raw.capabilities) || raw.capabilities.length > 12)) {
      errors.push('"capabilities" must be an array of at most 12 items');
    }
    if (raw.isolate !== undefined && typeof raw.isolate !== 'boolean') errors.push('"isolate" must be a boolean');
    if (raw.tokenCap !== undefined && !(Number.isInteger(raw.tokenCap) && raw.tokenCap > 0 && raw.tokenCap <= 1e10)) {
      errors.push('"tokenCap" must be a positive integer (max 1e10)');
    }
    if (str(raw.homepage) && raw.homepage.trim() && !raw.homepage.trim().startsWith('https://')) errors.push('"homepage" must be https');
    return { ok: errors.length === 0, errors };
  }

  return { SPEC, PROVIDERS, PROVIDER_LABEL, FLAG_RE, CAST, ACCENTS, normalizeProvider, validate };
})();
