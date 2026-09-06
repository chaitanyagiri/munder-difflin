/**
 * 全局主题 (v0.3.4) —— 整个 UI 共用一个明/暗开关，而不仅仅是终端。
 *
 * 整个渲染层都通过 `--cth-*` 变量来设置样式，因此暗色模式就是一次变量
 * 切换：本模块在 <html> 上写入 `data-cth-theme`，由 tokens.css 承载暗色
 * 覆盖。xterm 调色板 (PtyTerminalView) 与每个 agent 的 Claude 会话主题
 * (config.terminalTheme，spawn 时应用) 跟随同一状态，保证终端与界面外观一致。
 *
 * 可订阅的共享模块（与 terminalFontSize 同一模式）：组件通过 `useAppTheme()`
 * 读取；唯一开关位于标题栏。
 */
import { useSyncExternalStore } from 'react';

export type AppTheme = 'light' | 'dark';

const LS_KEY = 'cth.theme';
/** 0.3.4 之前终端有独立的主题键 —— 仅作为种子值读取一次。 */
const LEGACY_LS_KEY = 'cth.ptyTheme';

function load(): AppTheme {
  try {
    const v = window.localStorage.getItem(LS_KEY) ?? window.localStorage.getItem(LEGACY_LS_KEY);
    if (v === 'dark' || v === 'light') return v;
  } catch { /* noop */ }
  return 'light';
}

let theme: AppTheme = load();
const subscribers = new Set<() => void>();

function apply(): void {
  try { document.documentElement.dataset.cthTheme = theme; } catch { /* SSR/tests */ }
}
apply();

export function appTheme(): AppTheme {
  return theme;
}

export function setAppTheme(next: AppTheme): void {
  if (next === theme) return;
  theme = next;
  try { window.localStorage.setItem(LS_KEY, next); } catch { /* noop */ }
  apply();
  subscribers.forEach((fn) => fn());
}

export function toggleAppTheme(): AppTheme {
  const next: AppTheme = theme === 'dark' ? 'light' : 'dark';
  setAppTheme(next);
  return next;
}

export function useAppTheme(): AppTheme {
  return useSyncExternalStore(
    (onChange) => {
      subscribers.add(onChange);
      return () => subscribers.delete(onChange);
    },
    () => theme
  );
}
