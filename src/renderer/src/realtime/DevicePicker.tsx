/**
 * Realtime Michael — microphone device picker (card rt-8, Phase 1).
 *
 * Lets the user choose WHICH microphone the voice loop captures. The selection is
 * held in the realtime session store via `setDeviceId()` (see session.ts) and
 * applied on the next connect() — rt-2's getUserMedia passes it as
 * `{ deviceId: { exact } }`, falling back to the system default if it's stale.
 *
 * `enumerateDevices()` only returns device LABELS once the page has been granted
 * mic access at least once (our main-process gate opens while a voice session or
 * Free Flow is live — see src/main/index.ts). Before that we show generic
 * "Microphone N" names and a hint, so the picker is still usable cold.
 *
 * Speaker/output selection is a fast-follow: it needs the session to expose an
 * output setter that calls `audioEl.setSinkId()` (rt-2). Until that lands this
 * picker covers the input side, which is what getUserMedia consumes.
 *
 * Branch feat/realtime-michael. See board.md "🎙 REALTIME MICHAEL".
 */
import { useCallback, useEffect, useState } from 'react';
import { useRealtimeMichael } from './session';

interface AudioInput {
  deviceId: string;
  label: string;
}

/** Enumerate audio-input devices, with a generic fallback label when the real
 *  label is hidden (no mic permission granted yet this session). */
async function listMicrophones(): Promise<AudioInput[]> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'audioinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
}

const labelStyle: React.CSSProperties = {
  fontFamily: 'var(--cth-font-display)',
  fontSize: 8,
  lineHeight: '12px',
  color: 'var(--cth-ink-500)',
  textTransform: 'uppercase'
};
const selectStyle: React.CSSProperties = {
  fontFamily: 'var(--cth-font-mono)',
  fontSize: 13,
  padding: '6px 8px',
  border: '2px solid var(--cth-ink-300)',
  background: 'var(--cth-paper-100)',
  color: 'var(--cth-ink-900)'
};

export function RealtimeDevicePicker(): React.ReactElement {
  const { deviceId, setDeviceId } = useRealtimeMichael();
  const [mics, setMics] = useState<AudioInput[]>([]);
  /** True once at least one device exposes a real label ⇒ mic permission granted. */
  const [labelled, setLabelled] = useState(false);

  const refresh = useCallback(async () => {
    const list = await listMicrophones();
    setMics(list);
    setLabelled(list.some((m) => m.label && !/^Microphone \d+$/.test(m.label)));
  }, []);

  useEffect(() => {
    void refresh();
    // Hot-plug / unplug a mic, or a permission grant that reveals labels → re-list.
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md) return;
    const onChange = (): void => void refresh();
    md.addEventListener?.('devicechange', onChange);
    return () => md.removeEventListener?.('devicechange', onChange);
  }, [refresh]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 280 }}>
      <span style={labelStyle}>Microphone</span>
      <select
        value={deviceId ?? ''}
        onChange={(e) => setDeviceId(e.target.value || null)}
        style={selectStyle}
      >
        <option value="">System default</option>
        {mics.map((m) => (
          <option key={m.deviceId} value={m.deviceId}>
            {m.label}
          </option>
        ))}
      </select>
      {!labelled && (
        <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
          Microphone names appear after you first start a voice session and grant mic access.
          The choice applies the next time Michael connects. Speaker selection is coming soon.
        </span>
      )}
    </div>
  );
}
