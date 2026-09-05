import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';
import { useStore } from '@/store/store';

/**
 * WORKERS——由 god 触发的实时临时 Slack worker（Phase-1 spawn 循环）：
 * 全新隔离的 worktree → 干活 → 在主题内回复 → 安全拆除。本标签页通过
 * workers:list 读取 main 的 `liveWorkers` 映射，让人能看到什么在运行并手动
 * 停掉一个；它也展示拆除时被保留的 worktrees（一直持有到它们的工作被整合，
 * 然后自动 GC），这样就不会静默堆积。
 */

// 类型经类型化的 `window.cth` 全局（在 preload/index.d.ts 声明）来自 main 的
// `workers:list` 处理器——在这里派生，以免跨包 import。
type WorkersData = Awaited<ReturnType<typeof window.cth.listWorkers>>;
type WorkerSnapshot = WorkersData['live'][number];
type PreservedWorktreeSnapshot = WorkersData['preserved'][number];

const POLL_MS = 2000;

function relAge(ms: number): string {
  if (ms < 1000) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

const card: React.CSSProperties = {
  background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6
};
const metaRow: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontFamily: 'var(--cth-font-mono)',
  fontSize: 11, color: 'var(--cth-ink-700)'
};
const sectionHead: React.CSSProperties = {
  fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: 0.5, color: 'var(--cth-ink-900)', margin: '2px 0'
};

function StatusBadge({ w }: { w: WorkerSnapshot }) {
  const { t } = useTranslation();
  const releasing = w.status === 'releasing';
  return (
    <span style={{
      fontFamily: 'var(--cth-font-mono)', fontSize: 10, padding: '1px 6px',
      textTransform: 'uppercase', letterSpacing: 0.5,
      color: releasing ? 'var(--cth-paper-100)' : 'var(--cth-ink-900)',
      background: releasing ? 'var(--cth-ink-700)' : 'var(--cth-green, #2f8f4e)',
      boxShadow: releasing ? 'none' : 'inset 0 0 0 1px var(--cth-ink-100)'
    }}>
      {releasing ? t('workersTab.stopping') : t('workersTab.working')}
    </span>
  );
}

export function WorkersTab() {
  const { t } = useTranslation();
  const godName = useStore((s) => s.agents.find((a) => a.isGod)?.name) ?? 'the orchestrator';
  const [data, setData] = useState<WorkersData | null>(null);
  const [stopping, setStopping] = useState<Record<string, boolean>>({});

  const refresh = useCallback(() => {
    window.cth.listWorkers().then(setData).catch(() => { /* main 未就绪 */ });
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const stop = useCallback((workerId: string) => {
    setStopping((s) => ({ ...s, [workerId]: true }));
    window.cth.stopWorker(workerId)
      .catch(() => { /* 由行消失与否来呈现 */ })
      .finally(() => { refresh(); });
  }, [refresh]);

  const live = data?.live ?? [];
  const preserved = data?.preserved ?? [];
  const max = data?.maxWorkers ?? 4;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '12px 14px 16px', overflow: 'auto' }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <span style={sectionHead}>{t('workersTab.liveWorkers')}</span>
          <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-700)' }}>
            {live.length} / {max}
          </span>
        </div>
        <p style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)', margin: '2px 0 8px' }}>
          {t('workersTab.liveIntro', { godName })}
        </p>

        {live.length === 0 ? (
          <div style={{ ...card, color: 'var(--cth-ink-700)', fontFamily: 'var(--cth-font-ui)', fontSize: 12 }}>
            {t('workersTab.noneRunning')}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {live.map((w) => (
              <div key={w.workerId} style={card}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <StatusBadge w={w} />
                    <span style={{
                      fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 600, color: 'var(--cth-ink-900)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                    }}>{w.name}</span>
                    {w.hasSlack && (
                      <span title={t('workersTab.repliesToSlack')} style={{
                        fontFamily: 'var(--cth-font-mono)', fontSize: 10, color: 'var(--cth-ink-700)',
                        boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', padding: '0 5px'
                      }}>{t('workersTab.slack')}</span>
                    )}
                  </div>
                  <PixelButton
                    onClick={() => stop(w.workerId)}
                    disabled={w.releasing || !!stopping[w.workerId]}
                  >
                    {w.releasing || stopping[w.workerId] ? t('workersTab.stoppingEllipsis') : t('workersTab.stop')}
                  </PixelButton>
                </div>
                <div style={metaRow}>
                  <span title={t('workersTab.workerIdTitle')}>{w.workerId}</span>
                  <span title={t('workersTab.baseBranchTitle')}>{t('workersTab.base', { branch: w.baseBranch })}</span>
                  <span title={t('workersTab.upSinceTitle')}>{t('workersTab.up', { age: relAge(w.ageMs) })}</span>
                  <span title={t('workersTab.idleTitle')}>
                    {w.idleMs === null ? t('workersTab.ptyGone') : t('workersTab.idle', { age: relAge(w.idleMs) })}
                  </span>
                  <span title={t('workersTab.tokensTitle')}>
                    {t('workersTab.tokens', { value: fmtTokens(w.tokensUsed) })}{w.tokenCap !== null ? ` / ${fmtTokens(w.tokenCap)}` : ` · ${t('workersTab.uncapped')}`}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {preserved.length > 0 && (
        <div>
          <span style={sectionHead}>{t('workersTab.preserved', { count: preserved.length })}</span>
          <p style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)', margin: '2px 0 8px' }}>
            {t('workersTab.preservedIntro')}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {preserved.map((p) => (
              <div key={p.wtPath} style={card}>
                <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 600, color: 'var(--cth-ink-900)' }}>
                  {p.workerId}
                </div>
                <div style={metaRow}>
                  <span style={{ wordBreak: 'break-all' }}>{p.wtPath}</span>
                  <span>{t('workersTab.base', { branch: p.baseBranch })}</span>
                  <span>{t('workersTab.keptAgo', { age: relAge(Math.max(0, Date.now() - p.preservedAt)) })}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
