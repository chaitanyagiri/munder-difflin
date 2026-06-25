/**
 * Realtime Michael — voice session cost HUD (card rt-9, cost-guard).
 *
 * A compact meter for the live voice session's spend. Reads the cost store
 * (costStore.ts), which Kevin's session feeds via resetRealtimeCost() on connect
 * and recordRealtimeUsage() on each usage delta. Self-contained: mount it once
 * near the voice toggle (Michael's card / fullscreen header) — it renders its own
 * state and needs no props.
 *
 * Shows:
 *  • a spend cap control (always) — set a USD ceiling for the session;
 *  • the running $ + token counts while a session is metering;
 *  • an amber "approaching cap" cue at ≥80% and a red "over cap" warning at 100%,
 *    so the user (and Michael, who can read get_cost) knows to wrap up. The actual
 *    auto-stop / mic-off-when-idle action lives in the session (it owns the mic);
 *    this HUD surfaces the signal + the cap the session reads.
 *
 * Branch feat/realtime-michael. See board.md "🎙 REALTIME MICHAEL".
 */
import { useEffect, useState } from 'react';
import { formatUsd } from '@shared/realtimePricing';
import { useRealtimeCost } from './costStore';

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

export function CostHud(): React.ReactElement {
  const { usd, inputTokens, outputTokens, capUsd, overCap, startedTs, setCap } = useRealtimeCost();
  // Local text state so the field can be cleared/typed without fighting the store.
  const [capText, setCapText] = useState(capUsd != null ? String(capUsd) : '');

  // Keep the input in sync if the cap is changed elsewhere (e.g. reset).
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

  return (
    <div style={wrap}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={labelStyle}>Spend cap</span>
        <input
          type="number"
          min="0"
          step="0.5"
          inputMode="decimal"
          placeholder="none"
          value={capText}
          onChange={(e) => setCapText(e.target.value)}
          onBlur={(e) => commitCap(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitCap((e.target as HTMLInputElement).value);
          }}
          style={capInputStyle}
        />
        <span style={{ color: 'var(--cth-ink-500)' }}>USD{capUsd != null ? '' : ' (off)'}</span>
      </label>

      {live ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ color: meterColor, fontWeight: 600 }}>
            {formatUsd(usd)} this session{capUsd != null ? ` / ${formatUsd(capUsd)}` : ''}
          </span>
          <span style={{ color: 'var(--cth-ink-500)', fontSize: 11 }}>
            {inputTokens.toLocaleString()} in · {outputTokens.toLocaleString()} out audio tokens
          </span>
          {overCap && (
            <span style={{ color: 'var(--cth-danger, #c0392b)', fontSize: 11 }}>
              Over the spend cap — time to wrap up.
            </span>
          )}
          {near && (
            <span style={{ color: 'var(--cth-warn, #b8860b)', fontSize: 11 }}>
              Approaching the spend cap.
            </span>
          )}
        </div>
      ) : (
        <span style={{ color: 'var(--cth-ink-500)', fontSize: 11 }}>
          {usd > 0 ? `Last session: ${formatUsd(usd)}` : 'No active voice session.'}
        </span>
      )}
    </div>
  );
}
