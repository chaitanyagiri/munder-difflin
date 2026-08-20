import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import type { BlockReason } from '@/store/store';

export interface BlockedBannerProps {
  reason: BlockReason;
  onAction: (label: string, send?: string) => void;
}

export function BlockedBanner({ reason, onAction }: BlockedBannerProps) {
  const { t } = useTranslation();
  return (
    <div style={{
      background: 'var(--cth-coral-light)',
      boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-500), inset 0 0 0 4px var(--cth-coral)',
      padding: 12,
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        fontFamily: 'var(--cth-font-display)',
        fontSize: 8, lineHeight: '12px',
        color: 'var(--cth-ink-900)',
        textTransform: 'uppercase'
      }}>
        <Icon name="bell" /> {t('blockedBanner.needsYou')}
      </div>
      <div style={{
        fontFamily: 'var(--cth-font-ui)',
        fontSize: 16,
        lineHeight: '20px',
        color: 'var(--cth-ink-900)'
      }}>
        {reason.summary}
      </div>
      <div style={{
        fontSize: 13,
        lineHeight: '18px',
        color: 'var(--cth-ink-700)'
      }}>
        {reason.detail}
      </div>
      {reason.command && (
        <div style={{
          fontFamily: 'var(--cth-font-mono)',
          fontSize: 13,
          lineHeight: '18px',
          color: 'var(--cth-ink-900)',
          background: 'var(--cth-paper-100)',
          padding: '4px 8px',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }}>
          $ {reason.command}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {reason.actions.map((a) => (
          <PixelButton
            key={a.label}
            variant={a.kind === 'approve' ? 'primary' : a.kind === 'deny' ? 'destructive' : 'secondary'}
            size="sm"
            onClick={() => onAction(a.label, a.send)}
          >
            {a.label}
          </PixelButton>
        ))}
      </div>
    </div>
  );
}
