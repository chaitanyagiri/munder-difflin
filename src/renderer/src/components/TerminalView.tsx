import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// 奶油纸亮色主题——与 PtyTerminalView.tsx 里调好的亮色盘保持一致。旧的
// 调色板用了暗色主题的霓虹色（例如绿色 #6BCF7F、黄色 #FFD93D），在奶油背景上
// 作为前景几乎不可见；这些深/浓墨色在奶油纸上可读，而终端的 `minimumContrastRatio`
// （见下）也让彩色背景保持可读。
const theme = {
  background: '#FCFAF0',
  foreground: '#1A1320',
  cursor: '#FF6B6B',
  cursorAccent: '#FCFAF0',
  selectionBackground: '#FFEC99',
  selectionForeground: '#1A1320',
  black:        '#1A1320',
  red:          '#D1453B',
  green:        '#20904B',
  yellow:       '#9C6B00',
  blue:         '#2B6CB0',
  magenta:      '#8A5CF0',
  cyan:         '#1F9C94',
  white:        '#3A2F44',
  brightBlack:  '#6B5878',
  brightRed:    '#E0584E',
  brightGreen:  '#2E9E54',
  brightYellow: '#B8860B',
  brightBlue:   '#3B7DC4',
  brightMagenta:'#9B72F2',
  brightCyan:   '#2BA89F',
  brightWhite:  '#1A1320'
};

export interface TerminalViewProps {
  initialLines?: string[];
  feed?: string[]; // 追加的行（每次渲染都替换——我们做朴素 diff）
}

export function TerminalView({ initialLines = [], feed = [] }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writtenCount = useRef(0);

  useEffect(() => {
    if (!hostRef.current) return;
    const term = new Terminal({
      theme,
      fontFamily: '"JetBrains Mono", "Sarasa Mono SC", ui-monospace, "SF Mono", Menlo, "PingFang SC", "Microsoft YaHei", "Noto Sans Mono CJK SC", "Noto Sans CJK SC", monospace',
      fontSize: 13,
      lineHeight: 1.0,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 5000,
      convertEol: true,
      // 保持文字在程序设置的任何背景色上都可读（WCAG AA）。
      // 完整理由见 terminalPool.ts。
      minimumContrastRatio: 4.5,
      allowProposedApi: true
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    setTimeout(() => fit.fit(), 0);
    termRef.current = term;
    fitRef.current = fit;

    for (const line of initialLines) term.writeln(line);
    writtenCount.current = initialLines.length;

    const onResize = () => fit.fit();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    // 只写 `writtenCount` 之后的新行，避免重复写入
    const base = initialLines.length;
    const total = base + feed.length;
    if (writtenCount.current < total) {
      for (let i = writtenCount.current - base; i < feed.length; i++) {
        if (i < 0) continue;
        term.writeln(feed[i]);
      }
      writtenCount.current = total;
    }
  }, [feed, initialLines.length]);

  return (
    <div style={{
      background: 'var(--cth-paper-100)',
      boxShadow: 'var(--cth-panel-border-terminal)',
      padding: 8,
      height: '100%',
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
        marginBottom: 4
      }}>
        <span style={{
          width: 8, height: 8, background: 'var(--cth-coral)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
        }} />
        live · pipe-pane
      </div>
      <div ref={hostRef} style={{ flex: 1, minHeight: 0 }} />
    </div>
  );
}
