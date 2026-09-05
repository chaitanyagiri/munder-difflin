import { useTranslation } from 'react-i18next';
import { useAgentSpans, useFleetTelemetry, totalTokens, cacheFraction } from '@/hooks/useTelemetry';

/**
 * 每个 agent 的工具调用时间线（#7B.2）——来自实时 `tool_result` 遥测的工具
 * span 横向瀑布。每个条是一次工具调用，宽度 ∝ 其耗时，mint=成功 / coral=失败。
 * 头部色带显示累计成本，并把缓存对比新算的拆分显式展示出来（修复成本 bug
 * #1.1.3）。这是对旧的裸工具计数代理的一次重磅升级。
 */
export function ToolWaterfall({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const spans = useAgentSpans(agentId);
  const { samples } = useFleetTelemetry();
  const sample = samples[agentId];

  const maxDur = Math.max(1, ...spans.map((s) => s.durationMs));
  const recent = spans.slice(-60); // 保持视图可读

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--cth-paper-200)', overflow: 'hidden' }}>
      {/* 头部色带：累计成本 + 缓存对比新算的拆分 */}
      <div style={{
        flexShrink: 0, padding: '8px 10px', background: 'var(--cth-cream-200)',
        boxShadow: 'inset 0 -2px 0 var(--cth-ink-900)',
        fontFamily: 'var(--cth-font-mono)', fontSize: 12, color: 'var(--cth-ink-900)',
        display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'baseline'
      }}>
        {sample ? (
          <>
            <span><strong>${sample.usd.toFixed(2)}</strong></span>
            <span style={{ color: 'var(--cth-ink-700)' }}>
              {t('toolWaterfall.fresh', { tokens: fmtTokens(sample.input + sample.cacheCreation) })}
            </span>
            <span style={{ color: 'var(--cth-sky)' }}>
              {t('toolWaterfall.cache', { tokens: fmtTokens(sample.cacheRead), pct: Math.round(cacheFraction(sample) * 100) })}
            </span>
            {sample.model && <span style={{ color: 'var(--cth-ink-500)' }}>{sample.model}</span>}
            <span style={{ color: 'var(--cth-ink-500)' }}>{t('toolWaterfall.total', { tokens: fmtTokens(totalTokens(sample)) })}</span>
          </>
        ) : (
          <span style={{ color: 'var(--cth-ink-500)' }}>{t('toolWaterfall.noTelemetry')}</span>
        )}
      </div>

      {/* 瀑布 */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10 }}>
        {recent.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
            {t('toolWaterfall.empty')}
          </div>
        )}
        {recent.map((s, i) => {
          const pct = Math.max(2, Math.round((s.durationMs / maxDur) * 100));
          const ok = s.success && s.tool !== 'api_error';
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
              <span style={{ width: 88, fontSize: 11, color: 'var(--cth-ink-700)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={s.error ?? s.tool}>
                {s.tool}
              </span>
              <div style={{ flex: 1, height: 12, background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}>
                <div
                  title={s.error
                    ? `${s.tool}: ${s.error}`
                    : ok
                      ? t('toolWaterfall.barOk', { tool: s.tool, ms: s.durationMs })
                      : t('toolWaterfall.barFailed', { tool: s.tool, ms: s.durationMs })}
                  style={{ width: `${pct}%`, height: '100%', background: ok ? 'var(--cth-mint)' : 'var(--cth-coral)' }}
                />
              </div>
              <span style={{ width: 54, textAlign: 'right', fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)' }}>
                {fmtDur(s.durationMs)}
              </span>
              <span style={{ width: 12, textAlign: 'center', fontSize: 11, color: ok ? 'var(--cth-mint)' : 'var(--cth-coral)' }}>
                {ok ? '✓' : '✗'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function fmtDur(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}
