/**
 * i18n bootstrap — react-i18next with inline JSON resources.
 *
 * English is the default language (and the fallback for any missing key).
 * The user's choice is persisted in localStorage (`cth.language`) and, when
 * nothing has been chosen yet, the app follows the OS/browser language
 * (navigator.language) — so a Chinese-locale machine lands on 简体中文 out of
 * the box.
 *
 * Adding a language: drop a `locales/<code>.json` with the exact same key
 * tree as `en.json`, register it in `resources` and `supportedLngs`, and add
 * an entry to `LANGUAGES` (Settings → General exposes the picker from that
 * list). No other code needs to change.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';

/** The languages the Settings picker offers, in display order. */
export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'zh-CN', label: '简体中文' }
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]['code'];

const STORAGE_KEY = 'cth.language';

/** Resolve the initial language: saved choice, else the OS/browser locale. */
function detectLanguage(): string {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved) return saved;
  } catch { /* localStorage unavailable — fall through to the locale */ }
  const nav = (window.navigator.language ?? 'en').toLowerCase();
  return nav.startsWith('zh') ? 'zh-CN' : 'en';
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
      'zh-CN': { translation: zhCN }
    },
    lng: detectLanguage(),
    fallbackLng: 'en',
    supportedLngs: ['en', 'zh-CN'],
    // Resources are bundled inline, so nothing ever suspends — the string is
    // there at init time. Keeping this false lets every component call
    // useTranslation() without wrapping the tree in <Suspense>.
    react: { useSuspense: false },
    interpolation: { escapeValue: false },
    returnNull: false
  });

export default i18n;
