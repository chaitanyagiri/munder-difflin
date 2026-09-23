import en from '../renderer/src/i18n/locales/en.json';

/**
 * A minimal English `t` for shared code called without a translator.
 *
 * The string builders in src/shared take an optional i18next `t`. The renderer
 * always passes one; tests and any non-renderer caller do not. Rather than keep
 * a second copy of every English sentence next to its key, this resolves the
 * key in en.json and fills `{{var}}` placeholders — so English has one source,
 * and a test that calls a builder bare still checks the real English copy.
 *
 * Deliberately not i18next: no plurals, no nesting, no formatting. A key that
 * needs those should not be built in shared code. A missing key returns the key
 * itself, as i18next does.
 */
export function enT(key: string, vars: Record<string, unknown> = {}): string {
  const value = key.split('.').reduce<unknown>(
    (node, part) => node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
    en
  );
  if (typeof value !== 'string') return key;
  return value.replace(/{{\s*([^},\s]+).*?}}/g, (match, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : match
  );
}
