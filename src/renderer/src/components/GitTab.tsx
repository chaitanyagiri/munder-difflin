import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { CommitGraph } from './git/CommitGraph';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';

interface GitCommit {
  sha: string;
  shortSha: string;
  parents: string[];
  subject: string;
  author: string;
  time: number;
  refs: string[];
}
interface GitStatusEntry { path: string; index: string; worktree: string }
interface GitStatus { staged: GitStatusEntry[]; unstaged: GitStatusEntry[]; untracked: string[] }

export interface GitTabProps {
  cwd: string;
}

function statusLabelKey(code: string): string {
  return code === 'M' ? 'gitTab.modified'
    : code === 'A' ? 'gitTab.added'
    : code === 'D' ? 'gitTab.deleted'
    : code === 'R' ? 'gitTab.renamed'
    : code === '?' ? 'gitTab.untracked'
    : code === 'U' ? 'gitTab.unmerged'
    : code === ' ' ? '' : code;
}

function statusColor(code: string): string {
  if (code === 'M') return 'var(--cth-lemon)';
  if (code === 'A') return 'var(--cth-mint)';
  if (code === 'D') return 'var(--cth-coral)';
  if (code === 'R') return 'var(--cth-lilac)';
  if (code === '?') return 'var(--cth-ink-300)';
  return 'var(--cth-ink-500)';
}

export function GitTab({ cwd }: GitTabProps) {
  const { t } = useTranslation();
  const [isRepo, setIsRepo] = useState<boolean | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [detached, setDetached] = useState(false);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [log, setLog] = useState<GitCommit[]>([]);
  const [branches, setBranches] = useState<{ local: string[]; remote: string[] } | null>(null);
  const [ahead, setAhead] = useState(0);
  const [behind, setBehind] = useState(0);
  const [upstream, setUpstream] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const refresh = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const repo = await window.cth.gitIsRepo(cwd);
      setIsRepo(repo);
      if (!repo) { setLoading(false); return; }
      const [b, s, l, br, ab] = await Promise.all([
        window.cth.gitBranch(cwd),
        window.cth.gitStatus(cwd),
        window.cth.gitLog(cwd, 100),
        window.cth.gitBranches(cwd),
        window.cth.gitAheadBehind(cwd)
      ]);
      if ('error' in b) setError(b.error);
      else { setBranch(b.current); setDetached(b.detached); }
      if ('error' in s) setError(prev => prev ?? s.error); else setStatus(s);
      if (Array.isArray(l)) setLog(l); else if ('error' in l) setError(prev => prev ?? l.error);
      if ('error' in br) setError(prev => prev ?? br.error); else setBranches({ local: br.local, remote: br.remote });
      if ('error' in ab) { /* keep defaults */ } else { setAhead(ab.ahead); setBehind(ab.behind); setUpstream(ab.upstream); }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // Poll the working-tree status every 4s so freshly-edited files show up.
    const id = window.setInterval(refresh, 4000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  if (isRepo === false) {
    return (
      <div style={{
        flex: 1, minWidth: 0,
        height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16, textAlign: 'center', color: 'var(--cth-ink-500)',
        fontFamily: 'var(--cth-font-ui)', fontSize: 14
      }}>
        {t('gitTab.notARepo')}<br />{t('gitTab.notARepoHint')}
      </div>
    );
  }

  return (
    <div style={{
      flex: 1, minWidth: 0,
      height: '100%', minHeight: 0,
      display: 'flex', flexDirection: 'column',
      background: 'var(--cth-paper-100)'
    }}>
      {/* Branch + ahead/behind header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px',
        background: 'var(--cth-cream-200)',
        borderBottom: '1px solid var(--cth-ink-700)'
      }}>
        <span style={{
          fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px',
          padding: '2px 6px',
          background: 'var(--cth-sky-light)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
          color: 'var(--cth-ink-900)'
        }}>
          {detached ? t('gitTab.detachedHead') : (branch ?? '—')}
        </span>
        {upstream && (
          <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
            ↑ {ahead} ↓ {behind} · {upstream}
          </span>
        )}
        <div style={{ marginLeft: 'auto' }}>
          <PixelButton variant="ghost" size="sm" onClick={refresh} disabled={loading}>
            {loading ? '...' : t('gitTab.refresh')}
          </PixelButton>
        </div>
      </div>

      {error && (
        <div style={{
          padding: '4px 10px',
          background: 'var(--cth-coral-light)',
          color: 'var(--cth-ink-900)',
          fontSize: 12,
          borderBottom: '1px solid var(--cth-coral)'
        }}>{error}</div>
      )}

      {/* Body — scrollable, contains status + branches + graph */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {/* Status */}
        <Section title={t('gitTab.sectionStatus')}>
          {status && (
            <>
              <StatusGroup label={t('gitTab.staged')} entries={status.staged.map(e => ({ ...e, code: e.index }))} />
              <StatusGroup label={t('gitTab.changes')} entries={status.unstaged.map(e => ({ ...e, code: e.worktree }))} />
              <StatusGroup label={t('gitTab.untracked')} entries={status.untracked.map(p => ({ path: p, code: '?' }))} />
              {status.staged.length === 0 && status.unstaged.length === 0 && status.untracked.length === 0 && (
                <div style={{
                  padding: '4px 12px', color: 'var(--cth-ink-500)', fontSize: 13
                }}>{t('gitTab.clean')}</div>
              )}
            </>
          )}
        </Section>

        {/* Branches */}
        {branches && (branches.local.length > 0 || branches.remote.length > 0) && (
          <Section title={t('gitTab.sectionBranches')}>
            <div style={{ padding: '0 8px 8px', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {branches.local.map(b => (
                <span key={`l-${b}`} style={{
                  padding: '0 6px', fontSize: 12,
                  background: b === branch ? 'var(--cth-lemon)' : 'var(--cth-cream-100)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                  color: 'var(--cth-ink-900)'
                }}>{b}</span>
              ))}
              {branches.remote.map(b => (
                <span key={`r-${b}`} style={{
                  padding: '0 6px', fontSize: 12,
                  background: 'var(--cth-cream-100)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                  color: 'var(--cth-ink-500)',
                  display: 'inline-flex', alignItems: 'center', gap: 4
                }}>
                  <span style={{ width: 6, height: 6, background: 'var(--cth-lilac)' }} />
                  {b}
                </span>
              ))}
            </div>
          </Section>
        )}

        {/* Graph */}
        <Section title={t('gitTab.sectionLog')}>
          {log.length > 0 ? <CommitGraph commits={log} currentBranch={branch} /> : (
            <div style={{ padding: 12, color: 'var(--cth-ink-500)', fontSize: 12 }}>{t('gitTab.noCommits')}</div>
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
        textTransform: 'uppercase',
        color: 'var(--cth-ink-700)',
        padding: '8px 10px 4px',
        background: 'var(--cth-cream-50)',
        borderBottom: '1px solid var(--cth-ink-100)'
      }}>{title}</div>
      {children}
    </div>
  );
}

function StatusGroup({ label, entries }: {
  label: string;
  entries: Array<{ path: string; code: string }>;
}) {
  const { t } = useTranslation();
  if (entries.length === 0) return null;
  return (
    <div style={{ padding: '4px 0' }}>
      <div style={{
        padding: '0 12px', fontSize: 11, color: 'var(--cth-ink-500)',
        textTransform: 'uppercase', letterSpacing: 0
      }}>{label}</div>
      {entries.map(e => (
        <div key={`${label}-${e.path}-${e.code}`} style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '2px 12px',
          fontSize: 12, color: 'var(--cth-ink-900)'
        }}>
          <span style={{
            display: 'inline-block', width: 14, textAlign: 'center',
            fontFamily: 'var(--cth-font-mono)',
            color: statusColor(e.code),
            fontWeight: 'bold' as any
          }}>{e.code === ' ' ? '·' : e.code}</span>
          <span style={{
            flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            fontFamily: 'var(--cth-font-mono)', fontSize: 13
          }} title={e.path}>{e.path}</span>
          <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
            {statusLabelKey(e.code) ? t(statusLabelKey(e.code)) : ''}
          </span>
          <button
            onClick={() => navigator.clipboard.writeText(e.path).catch(() => {})}
            title={t('gitTab.copyPath')}
            style={{
              padding: 0, background: 'transparent', border: 'none',
              cursor: 'pointer', color: 'var(--cth-ink-500)'
            }}
          >
            <Icon name="folder" />
          </button>
        </div>
      ))}
    </div>
  );
}
