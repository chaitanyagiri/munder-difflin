import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { directionFor, isRtlLanguage } from './index';

/**
 * RTL 布局的唯一门控。
 *
 * `useRtl()` 是每个组件都会问的；`useDirectionSync()` 在根附近挂载一次
 * 并给 <html> 打上 `dir`/`lang`。两者都只读取一个输入 —— 用户在设置中选择的
 * 语言。不是 `navigator.language`，不是 OS，不是屏幕上的内容。未选择 RTL
 * 语言的用户会得到 `dir="ltr"` 和 `useRtl() === false`，行为与阿拉伯语存在前
 * 完全一致：没有方向翻转、没有镜像布局、没有不同字体、没有不同间距。
 *
 * 这个门控是整个阿拉伯语 UI 交付的条件，因此它只是一个函数，而不是一句
 *  `language === 'ar'` 的检查散落在十几个组件中 —— 散落的检查是某人最终会
 *  忘记写的那类，每个遗漏都是 English 用户的布局变更。
 *
 * 在 <html> 上设置 `dir` 而非 React 包装器，是因为 portalled UI（模态框、
 *  提示框、全屏终端）挂载在 React 树之外，否则会在其余应用镜像时保持文档的方向。
 */

/** 仅当用户选择了 RTL 应用语言时为 true。 */
export function useRtl(): boolean {
  const { i18n } = useTranslation();
  return isRtlLanguage(i18n.language);
}

/**
 * 让 <html dir> 和 <html lang> 指向所选语言。
 *
 * 在根附近挂载一次。从 RTL 语言退出时恢复 `dir="ltr"`/`lang="en"`，
 * 使得阿拉伯语 → 英语切换时 UI 镜像回去而不是卡住它。
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
