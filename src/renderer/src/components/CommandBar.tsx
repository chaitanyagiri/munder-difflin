import { useState, KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { AccentColorName } from '@/design/tokens';
import { isComposingKey } from '@shared/imeGuard';

type Mode = 'free' | 'slash' | 'quick';

export interface CommandBarProps {
  accent: AccentColorName;
  busy?: boolean;
  blocked?: boolean;
  onSend?: (text: string) => void;
}

export function CommandBar({ accent, busy, blocked, onSend }: CommandBarProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>('free');
  const [text, setText] = useState('');

  const send = () => {
    if (!text.trim()) return;
    onSend?.(text);
    setText('');
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isComposingKey(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const inputBorder = blocked
    ? 'var(--cth-coral)'
    : busy
    ? 'var(--cth-lemon)'
    : 'var(--cth-ink-700)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 4 }}>
        {(['free', 'slash', 'quick'] as Mode[]).map(m => (
          <button
            key={m}
            onClick={() => setMode(m)}
            style={{
              padding: '4px 10px 2px',
              border: 'none',
              background: mode === m ? `var(--cth-${accent})` : 'var(--cth-cream-200)',
              color: 'var(--cth-ink-900)',
              boxShadow: mode === m
                ? 'inset 0 0 0 1px var(--cth-ink-300), 0 -2px 0 var(--cth-ink-900) inset'
                : 'inset 0 0 0 1px var(--cth-ink-100)',
              fontFamily: 'var(--cth-font-ui)',
              fontSize: 13,
              cursor: 'pointer'
            }}
          >
            {m === 'free' ? t('commandBar.free') : m === 'slash' ? t('commandBar.skill') : t('commandBar.quick')}
          </button>
        ))}
      </div>
      <PixelPanel variant="inset" noPadding style={{ padding: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            fontFamily: 'var(--cth-font-mono)',
            fontSize: 18,
            color: `var(--cth-${accent})`,
            lineHeight: '20px',
            paddingLeft: 2
          }}>{'>'}</span>
          <input
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={onKey}
            placeholder={blocked ? t('commandBar.placeholderBlocked') : busy ? t('commandBar.placeholderBusy') : t('commandBar.placeholder')}
            style={{
              flex: 1,
              padding: '4px 6px 2px',
              background: 'var(--cth-paper-100)',
              border: 'none',
              boxShadow: `inset 0 0 0 1px ${inputBorder}`,
              fontFamily: 'var(--cth-font-mono)',
              fontSize: 18,
              lineHeight: '20px',
              color: 'var(--cth-ink-900)',
              outline: 'none'
            }}
          />
          <PixelButton variant="primary" size="md" onClick={send}>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              {t('commandBar.send')} <Icon name="arrow-right" />
            </span>
          </PixelButton>
        </div>
      </PixelPanel>
      {busy && <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{t('commandBar.busyNote')}</span>}
      {blocked && <span style={{ fontSize: 12, color: 'var(--cth-coral)' }}>{t('commandBar.blockedNote')}</span>}
    </div>
  );
}
