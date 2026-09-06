import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { isArabicTerminalEnabled } from './arabicSetting';
import { notifyArabicTerminalChangeAll } from '@/components/terminalPool';

/**
 * 让终端阿拉伯语/RTL 渲染跟随应用语言。
 *
 * 在根附近挂载一次。`isArabicTerminalEnabled()` 已读取
 * 语言，因此用户切换时 VALUE 立刻正确 —— 但已打开的
 * 终端在 attach 时读取它，否则会继续用旧方式渲染
 * 直到被重建。这是推送端。
 *
 * 跳过首次运行：挂载时每个终端都已在当前设置下创建，
 * 因此无需切换，触发会无故在启动时丢弃一个 WebGL 租赁。
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
