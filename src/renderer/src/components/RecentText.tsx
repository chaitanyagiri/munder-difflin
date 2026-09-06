import { useTypewriter } from '@/hooks/useTypewriter';
import { useTranslation } from 'react-i18next';
import type { AccentColorName } from '@/design/tokens';

export interface RecentTextProps {
  accent: AccentColorName;
  text: string;
  seed: number | undefined;
}

/**
 * 以流式打字机显示 agent 最近一条助手消息。
 * 流结束后光标闪烁仍然持续——与 Claude Code 还在撰写时相同的形态——
 * 且只在文本为空时消失。
 */
export function RecentText({ accent, text, seed }: RecentTextProps) {
  const { t } = useTranslation();
  const { shown, done } = useTypewriter(text, seed);
  if (!text) return null;
  return (
    <div style={{
      background: 'var(--cth-cream-50)',
      boxShadow: `inset 0 0 0 1px var(--cth-ink-100), inset 4px 0 0 var(--cth-${accent})`,
      padding: '8px 10px 8px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: 4
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        fontFamily: 'var(--cth-font-display)',
        fontSize: 8, lineHeight: '12px',
        color: 'var(--cth-ink-700)',
        textTransform: 'uppercase'
      }}>
        <span>{t('recentText.recent')}</span>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          color: done ? 'var(--cth-ink-500)' : `var(--cth-${accent})`
        }}>
          <span style={{
            width: 6, height: 6,
            background: done ? 'var(--cth-ink-500)' : `var(--cth-${accent})`,
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
            animation: done ? 'none' : 'cth-pulse 800ms steps(2, end) infinite'
          }} />
          {done ? 'idle' : 'live'}
        </span>
      </div>
      <div style={{
        fontFamily: 'var(--cth-font-ui)',
        fontSize: 13,
        lineHeight: '18px',
        color: 'var(--cth-ink-900)',
        minHeight: 36
      }}>
        {shown}
        <span style={{
          display: 'inline-block',
          width: 7,
          height: 14,
          marginLeft: 2,
          verticalAlign: '-2px',
          background: 'var(--cth-ink-900)',
          animation: 'cth-blink 700ms steps(2, end) infinite',
          opacity: done ? 0 : 1
        }} />
      </div>
    </div>
  );
}
