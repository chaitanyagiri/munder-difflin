import en from '../renderer/src/i18n/locales/en.json';
import de from '../renderer/src/i18n/locales/de.json';
import ar from '../renderer/src/i18n/locales/ar.json';
import zhCN from '../renderer/src/i18n/locales/zh-CN.json';

const locales: Record<string, unknown> = { en, de, ar, 'zh-CN': zhCN };

/** The locales this resolver can serve — the one list a new language is added
 *  to, so nothing else has to enumerate them. */
export const SUPPORTED_LOCALES = Object.keys(locales);

function resolve(root: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>(
    (node, part) => node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
    root
  );
}

/**
 * A minimal locale-aware `t` for shared and main-process code.
 *
 * The string builders in src/shared take an optional i18next `t`. The renderer
 * always passes one; tests and any non-renderer caller do not. Rather than keep
 * a second copy of every English sentence next to its key, this resolves the
 * key in the requested locale, falls back to en.json, and fills `{{var}}`
 * placeholders — so English has one source and main can reuse the same bundles.
 *
 * Deliberately not i18next: no plurals, no nesting, no formatting. A key that
 * needs those should not be built in shared code. A missing key returns the key
 * itself, as i18next does.
 */
export function makeT(locale: string): (key: string, vars?: Record<string, unknown>) => string {
  return (key, vars = {}) => {
    const localized = resolve(locales[locale], key);
    const value = typeof localized === 'string' ? localized : resolve(en, key);
    if (typeof value !== 'string') return key;
    return value.replace(/{{\s*([^},\s]+).*?}}/g, (match, name: string) =>
      Object.hasOwn(vars, name) ? String(vars[name]) : match
    );
  };
}

export const enT = makeT('en');
