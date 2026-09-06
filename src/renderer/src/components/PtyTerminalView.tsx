import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CSSProperties } from 'react';
import '@xterm/xterm/css/xterm.css';
import { Icon } from './Icon';
import { acquireTerminal, attachTerminal, debouncedResizePty, detachTerminal, reflowTerminal } from './terminalPool';
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  getTerminalFontSize,
  setTerminalFontSize,
  useTerminalFontSize
} from './terminalFontSize';
import { useAppTheme } from '@/design/theme';

// 缩放放在 ./terminalFontSize 里，让终端之外的任何东西（消息
// composer）也能一起缩放；这些别名让下面的调用点保持简短。
const DEFAULT_FONT_SIZE = DEFAULT_TERMINAL_FONT_SIZE;
const MIN_FONT_SIZE = MIN_TERMINAL_FONT_SIZE;
const MAX_FONT_SIZE = MAX_TERMINAL_FONT_SIZE;

// v0.3.4: 终端跟随 APP-WIDE 主题（design/theme.ts，在标题栏切换），
// 而不再保留自己的明/暗开关——chrome、终端，以及（经 config.terminalTheme）
// 每个 agent 的 TUI 配色，统一一套主题。
type PtyTheme = 'light' | 'dark';

const zoomBtnStyle: CSSProperties = {
  width: 18,
  height: 18,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 12,
  lineHeight: 1,
  color: 'var(--cth-ink-700)',
  background: 'var(--cth-paper-100)',
  border: '1px solid var(--cth-ink-300)',
  cursor: 'pointer',
  padding: 0
};

// 浅色主题——奶油底纸。ANSI "white" / "yellow" / bright 槽被重映射成
// 可读的深色墨：预期深色终端的程序打印白色或浅黄文本时，在奶油背景上
// 之前是看不见的。单个 ANSI 槽必须同时扮演两种角色——奶油底上的彩色
// *前景* 和深色默认墨下的彩色 *背景*——任何固定亮度都无法同时满足。
// 终端的 `minimumContrastRatio`（见 terminalPool.ts）会动态调整每个单元格的
// 前景来让两种角色都可读；这里的取值按"原生读起来就清晰可辨"调校。绿色/黄色
// 保持足够深，能在奶油上读作文本（更亮的变体属于更浅的色阶，符合终端惯例）。
const lightTheme = {
  background: '#FCFAF0',
  foreground: '#1A1320',
  cursor: '#D96A62',
  cursorAccent: '#FCFAF0',
  selectionBackground: '#FFEC99',
  selectionForeground: '#1A1320',
  black:        '#1A1320',
  red:          '#D1453B',
  green:        '#20904B',    // 深绿 → 在奶油底上读作文本
  yellow:       '#9C6B00',    // 深琥珀 → 在奶油底上读作文本
  blue:         '#2B6CB0',
  magenta:      '#8A5CF0',
  cyan:         '#1F9C94',
  white:        '#3A2F44',   // 默认 "white" 文本 → 用深色，才能看见
  brightBlack:  '#6B5878',
  brightRed:    '#E0584E',
  brightGreen:  '#2E9E54',
  brightYellow: '#B8860B',
  brightBlue:   '#3B7DC4',
  brightMagenta:'#9B72F2',
  brightCyan:   '#2BA89F',
  brightWhite:  '#1A1320'
};

// 深色主题——镜像应用的深色表面阶梯（tokens.css data-cth-theme='dark'）。
// xterm 接受字面颜色，读不了 CSS custom property，所以这些值是 RE-STATED
// 而非引用，token 一动就漂移：这一套在 tokens.css 降到更柔和的底色后，
// 仍停留在可读性改进前的阶梯上（background #1D1C21，旧的 paper-100），
// 会让每个终端与托着它的面板之间都明显差出一阶。Muted-professional ANSI：
// 可辨识的色相，在深色地面上不荧光；bright 是清晰可见的一级提升，不是粉彩。
const darkTheme = {
  background: '#1A1A1F',        // = --cth-paper-100
  foreground: '#DEDBD6',        // = --cth-ink-900
  cursor: '#E08C82',
  cursorAccent: '#1A1A1F',
  selectionBackground: '#37363F',
  selectionForeground: '#DEDBD6',
  black:        '#222229',
  red:          '#E08C82',
  green:        '#74C096',
  yellow:       '#CFAA57',
  blue:         '#6FB3C4',
  magenta:      '#A896E3',
  cyan:         '#6FB3C4',
  white:        '#DEDBD6',
  brightBlack:  '#96919F',
  brightRed:    '#EBA39C',
  brightGreen:  '#96CDA9',
  brightYellow: '#E5C87E',
  brightBlue:   '#8FC5D1',
  brightMagenta:'#C0B3EB',
  brightCyan:   '#8FC5D1',
  brightWhite:  '#EFEDE9'
};

const THEMES: Record<PtyTheme, typeof lightTheme> = { light: lightTheme, dark: darkTheme };

export interface PtyTerminalViewProps {
  ptyId: string;
  /** 转发给 renderer 侧的 onData hook，让父组件也能截获
   *  这个流做正则解析（avatar 状态推断）。 */
  onStreamData?: (chunk: string) => void;
  /** 用户提交一行（Enter）时，用去 trim 后的文本触发。 */
  onUserPrompt?: (text: string) => void;
  /** 提供时，在头部渲染一个展开/最小化按钮。 */
  onToggleFullscreen?: () => void;
  fullscreen?: boolean;
  /** 侧边栏标签页的边到边模式：无外框/无边框。 */
  embedded?: boolean;
}

export function PtyTerminalView({ ptyId, onStreamData, onUserPrompt, onToggleFullscreen, fullscreen, embedded }: PtyTerminalViewProps) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onStreamDataRef = useRef(onStreamData);
  onStreamDataRef.current = onStreamData;
  const onUserPromptRef = useRef(onUserPrompt);
  onUserPromptRef.current = onUserPrompt;
  const fontSize = useTerminalFontSize();
  const fontSizeRef = useRef(fontSize);
  const ptyTheme: PtyTheme = useAppTheme();
  const ptyThemeRef = useRef(ptyTheme);
  ptyThemeRef.current = ptyTheme;

  // 把这个视图挂到 pty 的持久终端上。终端和它的 buffer 跨挂载
  // 存在 pool 里，所以在这里重新挂宿主元素会立即显示已渲染的内容——
  // 切换 agent 或切换全屏时不会出现空白窗格。
  useEffect(() => {
    const container = hostRef.current;
    if (!container) return;
    const entry = acquireTerminal(ptyId, THEMES[ptyThemeRef.current], fontSizeRef.current);
    entry.term.options.theme = THEMES[ptyThemeRef.current];
    entry.term.options.fontSize = fontSizeRef.current;
    attachTerminal(entry, container);
    entry.onData = (chunk) => onStreamDataRef.current?.(chunk);
    entry.onPrompt = (text) => onUserPromptRef.current?.(text);

    // 重新挂载后、fit 落定前立即贴到底部
    try { entry.term.scrollToBottom(); } catch { /* 尚未打开 */ }

    // `scrollToEnd` 只在初始挂载时为 true（切换 agent / 切换全屏），
    // 这样我们落在最近的输出上。否则重新挂父的 pooled terminal 会把
    // 视口重置到顶部。之后由 resize 驱动的 fit 传 false，
    // 不会把已经向上滚去读历史的人拽回底部。
    // 跟踪第一次真正跑在真实（非零）宿主上的 fit，让下面的 ResizeObserver
    // 能在首次有效 fit 时贴到底部——哪怕初始的 rAF/timeout fit 是空操作
    // （终端挂在不活跃标签页下，宿主还没有尺寸）。
    let initialFitDone = false;
    const tryFit = (scrollToEnd = false) => {
      // 宿主没有真实尺寸时绝不 fit。对 0×0 的宿主做 fit 会让 xterm
      // 提出一个极小的网格并把 pty 缩成它，于是启动横幅渲染得过大/被裁剪，
      // 只有等之后的手动 resize 才"修好"。等真实尺寸——由
      // ResizeObserver 驱动首次 fit。
      if (!container.clientWidth || !container.clientHeight) return;
      try {
        const before = { cols: entry.term.cols, rows: entry.term.rows };
        entry.fit.fit();
        // 只在网格 ACTUALLY 变化时才去戳 pty：每次 resize 都会让
        // Claude TUI 重绘整屏，而每次重绘都把上一帧推进 scrollback——
        // 挂载时的重 fit 级联（rAF、60ms、240ms、字体加载）过去会在用户
        // 键入任何东西之前把启动横幅叠三次。经防抖合并后，整个级联只发
        // 一次 SIGWINCH（最终网格），qwen 的 alternate-screen 全量重绘
        // 不再把同一横幅推进 scrollback 多份。
        if (entry.term.cols !== before.cols || entry.term.rows !== before.rows) {
          debouncedResizePty(ptyId, entry.term.cols, entry.term.rows);
        }
        entry.term.refresh(0, Math.max(0, entry.term.rows - 1));
        initialFitDone = true;
      } catch { /* 宿主可能还没有尺寸 */ }
      if (scrollToEnd) {
        try {
          // 重新挂父 pooled terminal 会把 DOM 视口的 scrollTop 重置为 0，
          // 而 xterm 的内部滚动状态仍停在底部——屏幕看起来还是对的，
          // 但用户第一次滚轮会读到陈旧的 scrollTop≈0，把视图拽到历史顶部。
          // 裸的 scrollToBottom() 修不了这个（buffer 内部已经在底部 →
          // 无状态变化 → 视口不同步）。从外面写 DOM scrollTop 也不行：
          // 它会和 xterm 的 ignore-next-scroll-event 标志竞速（滚动事件会
          // 合并），可能留下滚动条钉在 max 而 buffer 却在底部之上——
          // 然后向下滚就死了（scrollTop 无法超过 max → 无事件 → 无重同步）。
          // 改为通过 xterm 自己的状态机强制一次 REAL 位置变化：
          // 先上一行，再回到底部。它的 Viewport 随即自己重新同步
          // DOM scrollTop，与自己的标志原子地完成。
          entry.term.scrollLines(-1);
          entry.term.scrollToBottom();
        } catch { /* 空操作 */ }
      }
    };
    // 布局落定后 fit 一次，等网络字体加载后再 fit 一次——
    // 这些是初始挂载的 fit，所以贴到底部。它们在宿主有真实尺寸前
    // 都是空操作，所以挂在不活跃标签页下的终端就等下面的
    // ResizeObserver 触发第一次 fit。
    requestAnimationFrame(() => requestAnimationFrame(() => tryFit(true)));
    const retries = [setTimeout(() => tryFit(true), 60), setTimeout(() => tryFit(true), 240)];
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready
        .then(() => {
          // xterm 在 open() 时只量一次字符单元；如果那时 VT323 还没加载，
          // 缓存的单元就是回退字体的尺寸，于是每次 fit() 都提出错误的
          // 列数，WebGL 字形图集也按错误的度量栅格化——横幅渲染得过大，
          // 直到手动 resize。重新应用字体 + 清空纹理图集会强制用真实字体
          // 重新度量 / 重新栅格化，然后我们重 fit。
          try {
            const fam = entry.term.options.fontFamily;
            entry.term.options.fontFamily = fam;
            entry.term.options.fontSize = fontSizeRef.current;
            entry.term.clearTextureAtlas?.();
          } catch { /* 空操作 */ }
          tryFit(true);
        })
        .catch(() => { /* 空操作 */ });
    }

    // ResizeObserver 是权威触发器：宿主第一次拿到真实尺寸（比如它的
    // 标签页变为可见）以及之后每次 resize 时它都会触发。首次有效 fit
    // 时贴到底部，之后再也不贴（这样向上滚去读历史的人不会被拽回底部）。
    const ro = new ResizeObserver(() => tryFit(!initialFitDone));
    ro.observe(container);
    const onWinResize = () => tryFit(false);
    window.addEventListener('resize', onWinResize);

    // 显示器唤醒后自愈。合上笔记本盖子会让 GPU 休眠，从而丢失 WebGL
    // context，并使 xterm 缓存的单元高度（以及由它派生的视口滚动区）过期——
    // 完整 buffer 还在，但只有一部分可滚动，直到重新度量（否则用户只能
    // 靠缩放来强制 fit）。ResizeObserver/resize 监听在开盖时不会触发，
    // 因为窗口像素尺寸没变，所以页面变为可见 / 重新聚焦时我们显式重 fit。
    // reflowTerminal 重新度量 + 重 fit 但不去滚动，所以正在读历史的人
    // 不会被拽到底部。rAF 让唤醒后的布局先落定；如果宿主仍未定尺寸，
    // reflow 是空操作，下一次 focus/visibility 会接住它。
    const onWake = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      requestAnimationFrame(() => reflowTerminal(ptyId));
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);

    return () => {
      retries.forEach(clearTimeout);
      ro.disconnect();
      window.removeEventListener('resize', onWinResize);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
      // Detach（但 DON'T dispose）终端——它继续在 pool 里运行。
      // detachTerminal 也会释放 WebGL 租约，所以没人看的终端不再
      // 占着一个屏幕上其他终端需要的 GPU context。
      entry.onData = undefined;
      entry.onPrompt = undefined;
      detachTerminal(entry, container);
    };
  }, [ptyId]);

  // 把应用主题的变更应用到 pooled terminal（持久化在 design/theme.ts ——
  // 由标题栏开关掌管）。
  useEffect(() => {
    acquireTerminal(ptyId, THEMES[ptyTheme], fontSizeRef.current).term.options.theme = THEMES[ptyTheme];
  }, [ptyTheme, ptyId]);

  // 把字号（缩放）变更应用到 pooled terminal，并重 fit 列/行。
  useEffect(() => {
    fontSizeRef.current = fontSize;
    const entry = acquireTerminal(ptyId, THEMES[ptyThemeRef.current], fontSize);
    entry.term.options.fontSize = fontSize;
    try {
      entry.fit.fit();
      debouncedResizePty(ptyId, entry.term.cols, entry.term.rows);
    } catch { /* 宿主可能还没有尺寸 */ }
  }, [fontSize, ptyId]);

  // 把文件（图片等）拖放到终端上 → 把它的绝对路径注入 pty，
  // 与原生终端的拖放完全一致。Claude Code 会在提示里检测到图片路径
  // 并附上它。没有这个，Electron 会把拖放当作导航，把 file:// URL
  // 加载到应用上。
  const onDragOver = (e: React.DragEvent) => {
    // dragover 上也必须 preventDefault——否则 `drop` 永远不会触发，
    // 窗口会导航到被拖放的文件。只在确实带着文件时认领它，
    // 让文本/选区拖放落到 xterm 自己的处理上。
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  };
  const onDrop = (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return; // 不是文件拖放——让 xterm 处理
    e.preventDefault();
    const paths = files
      .map((f) => window.cth.pathForFile(f))
      .filter(Boolean)
// SECURITY: 被拖放的文件名是攻击者可控的；把它当作一个
      // INERT（惰性）的单 shell token 注入，用 NATIVE 反斜杠转义风格
      //（即 macOS Terminal/iTerm 拖放时发出的格式，也是 Claude Code
      // 识别以附加被拖文件所用的格式）。(1) 先剥掉所有控制字符——
      // 换行/回车会被 writePty 当作 Enter 送达并 AUTO-SUBMIT 那一行；
      // ESC 会注入裸的终端转义序列。(2) 反斜杠转义反斜杠本身以及
      // 每一个可能作用于 Enter 的 shell 元字符（space $ ` " ' ; | & < > ( ) { } [ ] * ? ! ~ #），
      // 让路径保持为一个字面 token。（String.fromCharCode 让反斜杠/控制
      // 字符不进入本源码。）
      .map((p) => {
        const BS = String.fromCharCode(92);
        const CTRL = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']', 'g');
        // 反斜杠放在集合第一个，这样对每个 ORIGINAL 字符恰好转义一次，
        // 会把一个字面反斜杠变成一对（绝不会形成新的转义）。
        const SPECIAL = new Set(
          (BS + ' $' + String.fromCharCode(96) + String.fromCharCode(34) + String.fromCharCode(39) + ';|&<>(){}[]*?!~#')
            .split('').map((c) => c.charCodeAt(0))
        );
        return p.replace(CTRL, '').split('')
          .map((ch) => (SPECIAL.has(ch.charCodeAt(0)) ? BS + ch : ch)).join('');
      });
    if (paths.length === 0) return;
    // 结尾空格分隔连续两次拖放，也让用户能继续输入。
    void window.cth.writePty(ptyId, paths.join(' ') + ' ');
  };

  const zoom = (delta: number) => setTerminalFontSize(getTerminalFontSize() + delta);
  const resetZoom = () => setTerminalFontSize(DEFAULT_FONT_SIZE);

  // 键盘缩放：Cmd/Ctrl + '=' / '-' / '0'
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === '=' || e.key === '+') { e.preventDefault(); zoom(1); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoom(-1); }
      else if (e.key === '0') { e.preventDefault(); resetZoom(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div style={{
      background: 'var(--cth-paper-100)',
      boxShadow: embedded ? 'none' : 'var(--cth-panel-border-terminal)',
      padding: embedded ? 0 : 8,
      height: '100%',
      width: '100%',
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column'
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        fontFamily: 'var(--cth-font-ui)',
        fontSize: 12,
        color: 'var(--cth-ink-500)',
        borderBottom: '1px dashed var(--cth-ink-300)',
        paddingBottom: 4,
        marginBottom: 4,
        paddingLeft: embedded ? 8 : 0,
        paddingRight: embedded ? 8 : 0,
        paddingTop: embedded ? 6 : 0
      }}>
        <span style={{
          width: 8, height: 8, background: 'var(--cth-mint)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
          animation: 'cth-pulse 1200ms steps(2, end) infinite'
        }} />
        live · pty {ptyId}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 }}>
          {/* v0.3.4: 主题 + 进入全屏的按钮移到了 TITLE BAR（右上角）——
              更容易够到，而且主题现在会让整个应用变暗。
              只有 EXIT 这个退出口留在这里（全屏时）。 */}
          <button
            onClick={() => zoom(-1)}
            disabled={fontSize <= MIN_FONT_SIZE}
            title={t('ptyTerminalView.zoomOut')}
            style={zoomBtnStyle}
          >−</button>
          <button
            onClick={resetZoom}
            title={t('ptyTerminalView.resetZoom')}
            style={{ ...zoomBtnStyle, width: 'auto', padding: '0 4px', minWidth: 28 }}
          >{fontSize}px</button>
          <button
            onClick={() => zoom(1)}
            disabled={fontSize >= MAX_FONT_SIZE}
            title={t('ptyTerminalView.zoomIn')}
            style={zoomBtnStyle}
          >+</button>
          {fullscreen && onToggleFullscreen && (
            <button
              onClick={onToggleFullscreen}
              title={t('ptyTerminalView.exitFocusMode')}
              style={{ ...zoomBtnStyle, width: 22, height: 22, marginLeft: 4 }}
            >
              <Icon name="minimize" />
            </button>
          )}
        </div>
      </div>
      <div ref={hostRef} onDragOver={onDragOver} onDrop={onDrop} style={{
        flex: 1, minHeight: 0,
        padding: embedded ? '0 8px 8px' : 0
      }} />
    </div>
  );
}
