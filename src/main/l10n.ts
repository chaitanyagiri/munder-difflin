/**
 * 最小化的主进程本地化器。
 *
 * 渲染进程拥有完整的 i18next 配置（设置里的语言选择器，存放在 localStorage）。
 * 主进程读不到那份存储，因此它以操作系统区域设置（OS locale）为依据——这与
 * 渲染进程默认语言检测所用的信号一致。用户在设置里特意选择与系统不同的
 * 语言时，渲染进程仍完全使用该语言；原生菜单/对话框跟随系统区域设置，
 * 这本来就是 Electron 惯例行为。
 */
import { app } from 'electron';

let cached: 'zh' | 'other' | null = null;

function lang(): 'zh' | 'other' {
  if (cached) return cached;
  try {
    const loc = (app.getLocale() ?? '').toLowerCase();
    cached = loc.startsWith('zh') ? 'zh' : 'other';
  } catch {
    cached = 'other';
  }
  return cached;
}

/** 为 UI 标签/对话框/菜单项选取中文或英文字符串。 */
export function l10n(en: string, zh: string): string {
  return lang() === 'zh' ? zh : en;
}
