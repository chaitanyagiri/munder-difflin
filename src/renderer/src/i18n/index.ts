/**
 * i18n bootstrap — react-i18next with inline JSON resources.
 *
 * English is the default language (and the fallback for any missing key).
 * The user's choice is persisted in localStorage (`cth.language`). With nothing
 * saved the app starts in English, ALWAYS — it deliberately does not read
 * navigator.language. Auto-detect would change the UI out from under every
 * existing user on a non-English machine, who never asked for a translation and
 * may not want a partial one. Nothing moves until someone picks a language in
 * Settings.
 *
 * Adding a language: drop a `locales/<code>.json` with the exact same key
 * tree as `en.json`, register it in `resources` and `supportedLngs`, and add
 * an entry to `LANGUAGES` (Settings → General exposes the picker from that
 * list). Give it `dir: 'rtl'` if it is a right-to-left script. No other code
 * needs to change.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { DEFAULT_GOD_NAME } from '@shared/godIdentity';
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';
import ar from './locales/ar.json';

/**
 * The languages the Settings picker offers, in display order.
 *
 * `dir` is the language's WRITING DIRECTION, and it is the ONLY thing the app
 * keys right-to-left layout off. Not the OS locale, not the content of a
 * document, not a system font — the language the user picked here, and nothing
 * else. That is what makes RTL inert for everybody who has not picked an RTL
 * language: `dir` is 'ltr' for every one of them, so every `isRtl` branch in
 * the renderer takes the same path it took before Arabic existed.
 */
export const LANGUAGES = [
  { code: 'en', label: 'English', dir: 'ltr' },
  { code: 'zh-CN', label: '简体中文', dir: 'ltr' },
  { code: 'ar', label: 'العربية', dir: 'rtl' }
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]['code'];

/** Language codes that read right-to-left, derived from LANGUAGES itself so a
 *  new locale cannot be registered with a direction and then forgotten here. */
const RTL_CODES: ReadonlySet<string> = new Set(
  LANGUAGES.filter((l) => l.dir === 'rtl').map((l) => l.code)
);

/**
 * Does this language code read right-to-left?
 *
 * Deliberately EXACT-MATCH on a registered code rather than a prefix or a
 * script guess. An unknown code is left-to-right, which is the direction every
 * user had before this shipped — an unrecognised value must never be able to
 * mirror somebody's UI.
 */
export function isRtlLanguage(lng: string | undefined | null): boolean {
  return !!lng && RTL_CODES.has(lng);
}

/** `'rtl'` or `'ltr'` for a language code, for a `dir` attribute. */
export function directionFor(lng: string | undefined | null): 'rtl' | 'ltr' {
  return isRtlLanguage(lng) ? 'rtl' : 'ltr';
}

const STORAGE_KEY = 'cth.language';

const SUPPORTED: readonly string[] = LANGUAGES.map((l) => l.code);

/**
 * The orchestrator's display name, for every string that talks about it.
 *
 * The user can rename the god, and roughly forty strings mention it. Baking
 * "Michael" into the locale files would silently undo that rename everywhere at
 * once — a bug this codebase has already fixed three times in the spawn path.
 * So the locales say `{{godName}}` and the live name is supplied here as an
 * i18next DEFAULT VARIABLE, which means no call site has to pass it. A call site
 * that needs a variant (an upper-cased title, say) still overrides it by passing
 * `godName` explicitly.
 */
export function setGodName(name: string | undefined | null): void {
  const next = name?.trim() || DEFAULT_GOD_NAME;
  const interpolation = i18n.options.interpolation ?? (i18n.options.interpolation = {});
  const vars = interpolation.defaultVariables ?? (interpolation.defaultVariables = {});
  if (vars.godName === next) return;
  vars.godName = next;
  // react-i18next re-renders on this event. Without it a rename would only
  // reach strings that happened to re-render for some other reason.
  i18n.emit('languageChanged', i18n.language);
}

/** The saved choice, or English. Never the OS locale — see the note above. */
function detectLanguage(): string {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved && SUPPORTED.includes(saved as LanguageCode)) return saved;
  } catch { /* localStorage unavailable — English it is */ }
  return 'en';
}

/** Switch language now and persist the choice for next launch. */
export function setLanguage(lng: string): void {
  void i18n.changeLanguage(lng);
  try { window.localStorage.setItem(STORAGE_KEY, lng); } catch { /* best-effort */ }
}

void i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      'zh-CN': { translation: zhCN },
      ar: { translation: ar }
    },
    lng: detectLanguage(),
    fallbackLng: 'en',
    supportedLngs: ['en', 'zh-CN', 'ar'],
    // Resources are bundled inline, so nothing ever suspends — the string is
    // there at init time. Keeping this false lets every component call
    // useTranslation() without wrapping the tree in <Suspense>.
    react: { useSuspense: false },
    // `defaultVariables` is what lets every {{godName}} string resolve without
    // its call site knowing god's name. setGodName() keeps it current.
    interpolation: { escapeValue: false, defaultVariables: { godName: DEFAULT_GOD_NAME } },
    returnNull: false
  });

export default i18n;
