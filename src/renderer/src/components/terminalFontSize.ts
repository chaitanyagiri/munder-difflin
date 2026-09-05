import { useSyncExternalStore } from 'react';

/** 终端缩放级别，由每个应随之缩放的组件共享。
 *
 *  它以前是 PtyTerminalView 内部的组件局部状态，持久化到 localStorage。
 *  这样 xterm 面板只因为在挂载时各自读取存储值而保持同步——终端之外的任何东西
 *  （尤其是消息编辑器）根本无法跟随用户的 Cmd +/-，于是大屏上终端文字变大了，
 *  而输入框仍停留在写死的 13px。把值放在一个带订阅者的模块里，让缩放成为
 *  一等公民的全局设置：PtyTerminalView 写入它，任何人都能实时读取。 */

export const DEFAULT_TERMINAL_FONT_SIZE = 12;
export const MIN_TERMINAL_FONT_SIZE = 8;
export const MAX_TERMINAL_FONT_SIZE = 40;

const LS_FONT_SIZE = 'cth.ptyFontSize';

function load(): number {
  try {
    const n = parseInt(window.localStorage.getItem(LS_FONT_SIZE) ?? '', 10);
    if (!Number.isNaN(n) && n >= MIN_TERMINAL_FONT_SIZE && n <= MAX_TERMINAL_FONT_SIZE) return n;
  } catch { /* noop */ }
  return DEFAULT_TERMINAL_FONT_SIZE;
}

let current = load();
const listeners = new Set<() => void>();

export function getTerminalFontSize(): number {
  return current;
}

/** 设置共享缩放级别（受限）并持久化。未变化时是 no-op，这样
 *  重复的 set 不会搅动每个订阅者的 effect。 */
export function setTerminalFontSize(next: number): number {
  const clamped = Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(next)));
  if (clamped === current) return current;
  current = clamped;
  try { window.localStorage.setItem(LS_FONT_SIZE, String(clamped)); } catch { /* noop */ }
  for (const l of [...listeners]) l();
  return clamped;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 实时终端字体大小。无论缩放从哪里被改变，只要一变就重新渲染调用方。 */
export function useTerminalFontSize(): number {
  return useSyncExternalStore(subscribe, getTerminalFontSize, getTerminalFontSize);
}
