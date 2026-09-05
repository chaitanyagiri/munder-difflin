import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';
import { AgentHoldButton } from './AgentHoldButton';
import { isComposingKey } from '@shared/imeGuard';

/**
 * 单个代理的操作控制（#7C.1-7C.3）——暂停（在下一个边界处拒绝工具调用）、
 * 优雅停止（干净收尾）、以及运行中途的引导（无需在 TUI 中输入即可注入上下文）。
 * 全部走 Claude Code 的 hook-return 协议，不发送 PTY 按键。是代理头部下方的一条
 * 细操作条。
 *
 * 标签过去是 "CONTROL"、"pause"、"halt"、"steer"，只说明了机制，完全没说明后果。
 * 到底「控制」什么？暂停和停止又有什么区别？两者都会停下某件事，但只有其中一个
 * 能在同一口气里恢复。所以每个按钮现在都说清楚会发生什么（HAPPENS），说明文字放在
 * 样式化的悬停提示里，而不是放在原生 `title` 上——那种要等一秒、然后弹出一个
 * 无样式 OS 气泡。
 *
 * 标题被去掉了：按钮读起来已经是完整的句子后，标题只是在标注显而易见的东西，
 * 三个清晰动词排成一行，上面不需要再放标题。
 *
 * 1:1 hold 也放在这里。它是另一种「控制」——另外两个约束的是 AGENT，1:1 约束的
 * 是 MICHAEL，而且代理会继续运行并继续回答你——所以这个区别现在体现在它的
 * tooltip 里，而不是体现在布局上。
 */
interface Snapshot {
  paused: boolean;
  halted: boolean;
  autoDeliveryPaused: boolean;
  gatedTools: string[];
  pendingSteers: number;
}

export function AgentControlStrip({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [steer, setSteer] = useState('');
  const [note, setNote] = useState('');
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    window.cth.controlSnapshot(agentId).then((s) => { if (alive && s) setSnap(s); }).catch(() => { /* none */ });
    return () => { alive = false; };
  }, [agentId]);

  const flash = (m: string) => {
    setNote(m);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(''), 1800);
  };

  const togglePause = async () => {
    const s = snap?.paused ? await window.cth.controlResume(agentId) : await window.cth.controlPause(agentId, true);
    if (s) setSnap(s);
    flash(snap?.paused ? t('agentControl.flashResumed') : t('agentControl.flashPaused'));
  };
  const halt = async () => {
    const s = await window.cth.controlHalt(agentId);
    if (s) setSnap(s);
    flash(t('agentControl.flashHalt'));
  };
  const sendSteer = async () => {
    const t_ = steer.trim();
    if (!t_) return;
    const s = await window.cth.controlSteer(agentId, t_);
    if (s) setSnap(s);
    setSteer('');
    flash(t('agentControl.flashSteer'));
  };

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 6,
      padding: '6px 8px', background: 'var(--cth-paper-100)',
      borderBottom: '1px solid var(--cth-ink-300)', flexShrink: 0
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {/* 这两个都不会杀死任何东西，而旧的二字标签从未说明这一点 ——
            区别在于代理何时停止、以及是否保留会话。按钮上写明后果，悬停时给出细节。 */}
        <PixelButton variant={snap?.paused ? 'primary' : 'secondary'} size="sm" onClick={togglePause}>
          <span
            className="cth-tip cth-tip-left cth-tip-wrap"
            data-tip={snap?.paused
              ? t('agentControl.allowToolsTip')
              : t('agentControl.blockToolsTip')}
            aria-label={snap?.paused ? t('agentControl.allowToolsAria') : t('agentControl.blockToolsAria')}
          >
            {snap?.paused ? t('agentControl.allowTools') : t('agentControl.blockTools')}
          </span>
        </PixelButton>
        <PixelButton variant="destructive" size="sm" onClick={halt}>
          <span
            className="cth-tip cth-tip-left cth-tip-wrap"
            data-tip={t('agentControl.stopAfterStepTip')}
            aria-label={t('agentControl.stopAfterStepAria')}
          >
            {t('agentControl.stopAfterStep')}
          </span>
        </PixelButton>
        {/* 它与这两个按钮同排，听从创始人的调遣。它是另一种「控制」——
            上面两个约束的是 agent，这个约束的是 Michael —— 既然分组不再
            表达这个区别，就由 tooltip 来承担。 */}
        <AgentHoldButton agentId={agentId} />
        {/* v0.3.4：自动投递开关移到了 god 的 Command Center 头部 ——
            一个整层级的控制，取代了每个 agent 各自的开关。 */}
        {snap?.autoDeliveryPaused && (
          <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{t('agentControl.deliveryPaused')}</span>
        )}
        {snap?.halted && <span style={{ fontSize: 11, color: 'var(--cth-coral)' }}>{t('agentControl.halting')}</span>}
        {!!snap?.pendingSteers && <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{t('agentControl.steersQueued', { count: snap.pendingSteers })}</span>}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          className="cth-input"
          value={steer}
          onChange={(e) => setSteer(e.target.value)}
          onKeyDown={(e) => { if (isComposingKey(e)) return; if (e.key === 'Enter') sendSteer(); }}
          placeholder={t('agentControl.steerPlaceholder')}
          style={{
            flex: 1, padding: '4px 6px', background: 'var(--cth-paper-100)', border: 'none',
            fontFamily: 'var(--cth-font-ui)',
            fontSize: 12, color: 'var(--cth-ink-900)', outline: 'none'
          }}
        />
        <PixelButton variant="secondary" size="sm" onClick={sendSteer} disabled={!steer.trim()}>
          <span
            className="cth-tip cth-tip-wrap"
            data-tip={t('agentControl.steerTip')}
            aria-label={t('agentControl.steerAria')}
          >{t('agentControl.steer')}</span>
        </PixelButton>
      </div>
      {note && <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{note}</span>}
    </div>
  );
}
