/**
 * LOCALE PARITY — every translation must be shaped exactly like en.json.
 *
 * i18next falls back to English for a missing key, so a gap is invisible in
 * development and shows up as an English word in the middle of a German
 * sentence for the user. A dropped `{{placeholder}}` is worse: the variable
 * simply never renders, and the sentence loses the number, name or path it
 * existed to show. Neither is a type error, neither breaks a build, and
 * neither is caught by any other test in this repo.
 *
 * So the shape is checked, not the prose: same key set, same placeholders per
 * key, same array lengths, nothing empty. What the words say is a human's
 * call; that they can still carry their data is this file's.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const LOCALE_DIR = path.join(__dirname, '..', 'src', 'renderer', 'src', 'i18n', 'locales');
const BASE = 'en';

const load = (code) => JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, `${code}.json`), 'utf8'));

const locales = fs
  .readdirSync(LOCALE_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -5))
  .filter((c) => c !== BASE);

/**
 * Flatten to `dotted.path -> string`, with an array element addressed as
 * `path[i]`. Arrays are walked rather than compared whole because a locale
 * that drops one bullet from a five-bullet list still parses, still renders,
 * and still silently loses a line.
 */
function flatten(node, prefix, out) {
  if (typeof node === 'string') {
    out.set(prefix, node);
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
    return out;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

/**
 * The `{{var}}` names a string carries, sorted, WITH repeats. A repeat is
 * harmless to i18next, but test/arabic-ui.test.cjs counts them for ar and
 * zh-CN, so a translation that says the name twice where English says it once
 * fails upstream; counting here catches the same thing for every locale.
 */
const placeholders = (s) =>
  [...s.matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)].map((m) => m[1]).sort();

const baseFlat = flatten(load(BASE), '', new Map());

test('there is at least one locale to check besides the base', () => {
  assert.ok(locales.length > 0, `no locales found next to ${BASE}.json`);
});

for (const code of locales) {
  const flat = flatten(load(code), '', new Map());

  test(`${code}: key set matches ${BASE}`, () => {
    const missing = [...baseFlat.keys()].filter((k) => !flat.has(k));
    const extra = [...flat.keys()].filter((k) => !baseFlat.has(k));
    assert.deepStrictEqual(
      { missing: missing.slice(0, 20), extra: extra.slice(0, 20) },
      { missing: [], extra: [] },
      `${missing.length} missing / ${extra.length} extra key(s) in ${code}.json`
    );
  });

  test(`${code}: placeholders survive translation`, () => {
    const broken = [];
    for (const [key, en] of baseFlat) {
      const translated = flat.get(key);
      if (typeof translated !== 'string') continue;
      const want = placeholders(en);
      const got = placeholders(translated);
      if (want.join('|') !== got.join('|')) broken.push({ key, want, got });
    }
    assert.deepStrictEqual(broken.slice(0, 20), [], `${broken.length} key(s) lost or gained a placeholder`);
  });

  test(`${code}: nothing is blank`, () => {
    const blank = [...flat.entries()].filter(([, v]) => v.trim() === '').map(([k]) => k);
    assert.deepStrictEqual(blank.slice(0, 20), [], `${blank.length} empty string(s) in ${code}.json`);
  });
}
