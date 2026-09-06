/**
 * IDE 共享的栏 chrome。
 *
 * 这三个样式对象之前是 IdePanel 私有的，这没问题
 * 因为 IdePanel 自己渲染每个 pane。图片预览渲染自己的
 * 栏，而第二份 "padding 3px 8px、cream-200、ink-700 细线" 会在
 * 任一文件被改动时立即产生偏差 —— 两个栏在同一个标签页栏中
 * 直接叠在一起，任何偏差都立即可见。一个定义，两者共用。
 *
 * 每个颜色都是 token，绝非字面量：应用同时提供浅色和深色
 * 主题，通过重新定义这些变量来切换，因此此处的硬编码 hex
 * 只在其中一个主题下看起来正确。
 */
import type { CSSProperties } from 'react';

/** 编辑器 / 预览主体上方的水平栏。 */
export const ideBarStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px',
  background: 'var(--cth-cream-200)', borderBottom: '1px solid var(--cth-ink-700)',
  fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-700)'
};

/** 方形、无边框、仅含图标的按钮。 */
export const ideIconBtn: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  padding: 0, width: 18, height: 18, background: 'transparent', border: 'none',
  cursor: 'pointer', color: 'var(--cth-ink-500)'
};

/** 带标签的小按钮，用于栏操作（保存、复制路径、视图切换）。 */
export const ideTextBtn: CSSProperties = {
  padding: '0 6px', height: 20, fontFamily: 'var(--cth-font-ui)', fontSize: 12,
  color: 'var(--cth-ink-900)', background: 'var(--cth-cream-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', gap: 4
};
