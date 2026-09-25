import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useTranslation } from 'react-i18next';

// Cream-paper light theme — kept in sync with the tuned light palette in
// PtyTerminalView.tsx. The old palette here used the dark-theme neon colours
// (e.g. green #6BCF7F, yellow #FFD93D) which are near-invisible as foreground on
// the cream background; these dark/deep inks read on cream, and the terminal's
// `minimumContrastRatio` (below) keeps coloured backgrounds legible too.
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
  feed?: string[]; // appended lines (replaced each render — we diff naively)
}

export function TerminalView({ initialLines = [], feed = [] }: TerminalViewProps) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writtenCount = useRef(0);

  useEffect(() => {
    if (!hostRef.current) return;
    const term = new Terminal({
      theme,
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.0,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 5000,
      convertEol: true,
      // Keep text legible on any program-set background colour (WCAG AA).
      // See terminalPool.ts for the full rationale.
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
    // Write only new lines beyond `writtenCount` to avoid duplicating
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
        {t('terminalView.live')}
      </div>
      <div ref={hostRef} style={{ flex: 1, minHeight: 0 }} />
    </div>
  );
}
