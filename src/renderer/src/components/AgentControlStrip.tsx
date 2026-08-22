import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';

/** Operator control for one agent (#7C.1–7C.3) — pause (deny tools at the next
 *  boundary), graceful halt (clean stop), and mid-run steering (inject context
 *  without typing into the TUI). All ride Claude Code's hook-return protocol; no
 *  PTY keystrokes. A thin strip under the agent header. */
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
        <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-500)', marginRight: 2 }}>{t('agentControl.control')}</span>
        {/* Neither of these kills anything, and the two-word labels never said
            so — the difference is WHEN the agent stops and whether it keeps its
            session. Spelled out on hover rather than left to be discovered. */}
        <PixelButton variant={snap?.paused ? 'primary' : 'secondary'} size="sm" onClick={togglePause}>
          <span title={snap?.paused
            ? t('agentControl.resumeTitle')
            : t('agentControl.pauseTitle')}>
            {snap?.paused ? t('agentControl.resume') : t('agentControl.pause')}
          </span>
        </PixelButton>
        <PixelButton variant="destructive" size="sm" onClick={halt}>
          <span title={t('agentControl.haltTitle')}>
            {t('agentControl.halt')}
          </span>
        </PixelButton>
        {/* v0.3.4: the auto-delivery switch moved to the god's Command Center
            header — ONE floor-wide control instead of a per-agent toggle. */}
        {snap?.autoDeliveryPaused && (
          <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{t('agentControl.deliveryPaused')}</span>
        )}
        {snap?.halted && <span style={{ fontSize: 11, color: 'var(--cth-coral)' }}>{t('agentControl.halting')}</span>}
        {!!snap?.pendingSteers && <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{t('agentControl.steersQueued', { count: snap.pendingSteers })}</span>}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={steer}
          onChange={(e) => setSteer(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') sendSteer(); }}
          placeholder={t('agentControl.steerPlaceholder')}
          style={{
            flex: 1, padding: '4px 6px', background: 'var(--cth-paper-100)', border: 'none',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontFamily: 'var(--cth-font-ui)',
            fontSize: 12, color: 'var(--cth-ink-900)', outline: 'none'
          }}
        />
        <PixelButton variant="secondary" size="sm" onClick={sendSteer} disabled={!steer.trim()}>{t('agentControl.steer')}</PixelButton>
      </div>
      {note && <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{note}</span>}
    </div>
  );
}
