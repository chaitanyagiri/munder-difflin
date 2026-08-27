import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { isArabicTerminalEnabled } from './arabicSetting';
import { notifyArabicTerminalChangeAll } from '@/components/terminalPool';

/**
 * Make terminal Arabic/RTL rendering follow the app language.
 *
 * Mounted once, near the root. `isArabicTerminalEnabled()` already reads the
 * language, so the VALUE is correct the moment a user switches — but terminals
 * that are already open read it at attach time and would otherwise keep
 * rendering the old way until they were recreated. This is the push half.
 *
 * Skips the first run: on mount every terminal was created under the current
 * setting already, so there is nothing to switch, and firing anyway would drop
 * a WebGL lease at boot for no reason.
 */
export function useArabicTerminalSync(): void {
  const { i18n } = useTranslation();
  const lng = i18n.language;
  const last = useRef<boolean | null>(null);
  useEffect(() => {
    const want = isArabicTerminalEnabled();
    if (last.current === null) { last.current = want; return; }
    if (last.current === want) return;
    last.current = want;
    notifyArabicTerminalChangeAll();
  }, [lng]);
}
