import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { directionFor, isRtlLanguage } from './index';

/**
 * The single gate for right-to-left layout.
 *
 * `useRtl()` is what every component asks; `useDirectionSync()` is mounted once
 * near the root and stamps `dir`/`lang` on <html>. Both read ONE input — the
 * language the user picked in Settings. Not `navigator.language`, not the OS,
 * not the content on screen. A user who has not picked an RTL language gets
 * `dir="ltr"` and `useRtl() === false`, which is byte-for-byte the behaviour
 * they had before Arabic existed: no direction flip, no mirrored layout, no
 * different font, no different spacing.
 *
 * That gate is the condition the whole Arabic UI ships under, so it is one
 * function rather than a `language === 'ar'` check scattered across a dozen
 * components — a scattered check is a check somebody eventually forgets to
 * write, and each miss is a layout change for an English user.
 *
 * `dir` on <html> rather than on a React wrapper because portalled UI (modals,
 * tooltips, the fullscreen terminal) mounts outside the React tree and would
 * otherwise keep the document's direction while the rest of the app mirrored.
 */

/** True only when the user has selected a right-to-left app language. */
export function useRtl(): boolean {
  const { i18n } = useTranslation();
  return isRtlLanguage(i18n.language);
}

/**
 * Keep <html dir> and <html lang> pointed at the selected language.
 *
 * Mounted once, near the root. Restores `dir="ltr"`/`lang="en"` on the way
 * back out of an RTL language, so switching Arabic → English mirrors the UI
 * back rather than stranding it.
 */
export function useDirectionSync(): void {
  const { i18n } = useTranslation();
  const lng = i18n.language;
  useEffect(() => {
    const html = document.documentElement;
    html.setAttribute('dir', directionFor(lng));
    html.setAttribute('lang', lng || 'en');
  }, [lng]);
}
