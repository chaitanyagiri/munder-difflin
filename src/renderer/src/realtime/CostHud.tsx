/**
 * Realtime Michael —— 语音会话成本 HUD（卡片 rt-9，成本守卫）。
 *
 * 一个紧凑的实时语音会话支出计量表。读取成本 store（costStore.ts），
 * Kevin 的会话通过 connect 时 resetRealtimeCost() 和每个用量增量上的
 * recordRealtimeUsage() 喂给它。自包含：在语音开关附近挂载一次
 * （Michael 的卡片 / 全屏头部）——它渲染自己的状态，无需 props。
 *
 * 显示：
 *  • 支出上限控件（始终）——为会话设置一个美元上限；
 *  • 会话计量期间的运行中 $ + token 数；
 *  • ≥80% 时的琥珀色“接近上限”提示，100% 时的红色“超上限”警告，
 *    让用户（和能读 get_cost 的 Michael）知道该收尾了。真正的自动停止 /
 *    麦克风空闲关闭动作在会话里（它拥有麦克风）；这个 HUD 只表面化信号 +
 *    会话读取的上限。
 *
 * 分支 feat/realtime-michael。见 board.md “🎙 REALTIME MICHAEL”。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatUsd } from '@shared/realtimePricing';
import { useRealtimeCost } from './costStore';
import { isComposingKey } from '@shared/imeGuard';

const WARN_RATIO = 0.8;

const wrap: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  fontFamily: 'var(--cth-font-mono)',
  fontSize: 12,
  color: 'var(--cth-ink-900)'
};
const labelStyle: React.CSSProperties = {
  fontFamily: 'var(--cth-font-display)',
  fontSize: 8,
  lineHeight: '12px',
  color: 'var(--cth-ink-500)',
  textTransform: 'uppercase'
};
const capInputStyle: React.CSSProperties = {
  width: 92,
  fontFamily: 'var(--cth-font-mono)',
  fontSize: 12,
  padding: '4px 6px',
  border: '2px solid var(--cth-ink-300)',
  background: 'var(--cth-paper-100)',
  color: 'var(--cth-ink-900)'
};

export interface CostHudProps {
  /** 紧凑行内读数（挨着语音开关）：只显示实时的 $，按上限状态着色，且只在
   *  会话计量期间——关闭时渲染为空，绝不弄乱开关行。完整表单（上限控件 +
   *  token 明细）是默认，用于设置页这类宽敞处。 */
  compact?: boolean;
}

export function CostHud({ compact = false }: CostHudProps): React.ReactElement | null {
  const { t } = useTranslation();
  const { usd, inputTokens, outputTokens, capUsd, overCap, startedTs, setCap } = useRealtimeCost();
  // 本地文本状态，让字段可以清空/输入而不跟 store 打架。
  const [capText, setCapText] = useState(capUsd != null ? String(capUsd) : '');

  // 若上限在别处被改（例如重置），让输入保持同步。
  useEffect(() => {
    setCapText(capUsd != null ? String(capUsd) : '');
  }, [capUsd]);

  const commitCap = (raw: string): void => {
    const n = parseFloat(raw);
    setCap(isFinite(n) && n > 0 ? n : null);
  };

  const live = startedTs != null;
  const ratio = capUsd != null && capUsd > 0 ? usd / capUsd : 0;
  const near = capUsd != null && !overCap && ratio >= WARN_RATIO;
  const meterColor = overCap ? 'var(--cth-danger, #c0392b)' : near ? 'var(--cth-warn, #b8860b)' : 'var(--cth-ink-900)';

  // 紧凑版：语音开关旁一个可瞥见的 TOKEN 芯片，只在会话运行期间显示。
  // 刻意不在 agent 界面里露出钱——支出上限仍会静默触发（见 session.ts 的
  // 成本守卫）；agent 界面只显示 token 用量。
  if (compact) {
    if (!live) return null;
    const totalTok = inputTokens + outputTokens;
    const tokLabel = totalTok >= 1000 ? `${(totalTok / 1000).toFixed(1)}k` : String(totalTok);
    return (
      <span
        title={t('costHud.compactTitle', { count: totalTok })}
        style={{
          fontFamily: 'var(--cth-font-mono)',
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--cth-ink-900)',
          flexShrink: 0,
          whiteSpace: 'nowrap'
        }}
      >
        {tokLabel} {t('costHud.tok')}
      </span>
    );
  }

  return (
    <div style={wrap}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={labelStyle}>{t('costHud.spendCap')}</span>
        <input
          type="number"
          min="0"
          step="0.5"
          inputMode="decimal"
          placeholder={t('costHud.none')}
          value={capText}
          onChange={(e) => setCapText(e.target.value)}
          onBlur={(e) => commitCap(e.target.value)}
          onKeyDown={(e) => {
            if (isComposingKey(e)) return;
            if (e.key === 'Enter') commitCap((e.target as HTMLInputElement).value);
          }}
          style={capInputStyle}
        />
        <span style={{ color: 'var(--cth-ink-500)' }}>{t('costHud.usd')}{capUsd != null ? '' : ` ${t('costHud.off')}`}</span>
      </label>

      {live ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ color: meterColor, fontWeight: 600 }}>
            {capUsd != null
              ? t('costHud.thisSessionWithCap', { usd: formatUsd(usd), cap: formatUsd(capUsd) })
              : t('costHud.thisSession', { usd: formatUsd(usd) })}
          </span>
          <span style={{ color: 'var(--cth-ink-500)', fontSize: 11 }}>
            {t('costHud.audioTokens', { input: inputTokens.toLocaleString(), output: outputTokens.toLocaleString() })}
          </span>
          {overCap && (
            <span style={{ color: 'var(--cth-danger, #c0392b)', fontSize: 11 }}>
              {t('costHud.overCap')}
            </span>
          )}
          {near && (
            <span style={{ color: 'var(--cth-warn, #b8860b)', fontSize: 11 }}>
              {t('costHud.nearCap')}
            </span>
          )}
        </div>
      ) : (
        <span style={{ color: 'var(--cth-ink-500)', fontSize: 11 }}>
          {usd > 0 ? t('costHud.lastSession', { usd: formatUsd(usd) }) : t('costHud.noSession')}
        </span>
      )}
    </div>
  );
}
