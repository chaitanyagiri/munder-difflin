import { type SidebarTab } from '@/store/store';
import { type AccentColorName } from '@/design/tokens';
import { Icon, type IconName } from './Icon';

// v0.3.4: the files tab is gone — the per-agent IDE button (header) opens the
// full Monaco editor + file tree, which superseded the read-only browser.
const TABS: { key: SidebarTab; label: string; icon: IconName }[] = [
  { key: 'terminal', label: 'terminal', icon: 'terminal' },
  { key: 'git',      label: 'git',      icon: 'code' },
  { key: 'messages', label: 'messages', icon: 'bell' },
  { key: 'traces',   label: 'traces',   icon: 'web' },
  { key: 'projects', label: 'projects', icon: 'ledger' }
];

export interface SidebarTabsProps {
  current: SidebarTab;
  accent: AccentColorName;
  onChange: (tab: SidebarTab) => void;
}

export function SidebarTabs({ current, accent, onChange }: SidebarTabsProps) {
  return (
    <div style={{
      display: 'flex',
      gap: 0,
      background: 'var(--cth-cream-200)',
      boxShadow: 'inset 0 -2px 0 var(--cth-ink-900)',
      flexShrink: 0
    }}>
      {TABS.map(t => {
        const active = current === t.key;
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            style={{
              flex: 1,
              height: 36,
              padding: '0 10px',
              border: 'none',
              cursor: 'pointer',
              background: active ? 'var(--cth-cream-100)' : 'transparent',
              boxShadow: active
                ? `inset 0 -3px 0 var(--cth-${accent}), inset 1px 0 0 var(--cth-ink-900), inset -1px 0 0 var(--cth-ink-900)`
                : 'inset 0 0 0 0',
              fontFamily: 'var(--cth-font-display)',
              fontSize: 10,
              lineHeight: '14px',
              color: active ? 'var(--cth-ink-900)' : 'var(--cth-ink-500)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6
            }}
          >
            <Icon name={t.icon} /> {t.label.toUpperCase()}
          </button>
        );
      })}
    </div>
  );
}
