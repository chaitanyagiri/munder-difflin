/**
 * Realtime Michael — microphone & speaker device picker (card rt-8, Phase 1).
 *
 * Lets the user choose WHICH microphone the voice loop captures and WHICH speaker
 * it plays Michael's voice through. Selections are held in the realtime session
 * store via `setDeviceId()` / `setOutputDeviceId()` (see session.ts): the mic is
 * applied on the next connect() (getUserMedia `{ deviceId: { exact } }`), the
 * speaker is applied immediately to the live `<audio>` sink via `setSinkId()` (and
 * re-applied at connect). Both fall back to the system default if a stored id is
 * stale.
 *
 * `enumerateDevices()` only returns device LABELS once the page has been granted
 * mic access at least once (our main-process gate opens while a voice session or
 * Free Flow is live — see src/main/index.ts). Before that we show generic
 * "Microphone N" / "Speaker N" names and a hint, so the picker is usable cold.
 *
 * Branch feat/realtime-michael. See board.md "🎙 REALTIME MICHAEL".
 */
import { useCallback, useEffect, useState } from 'react';
import { useRealtimeMichael } from './session';

interface AudioDevice {
  deviceId: string;
  label: string;
}

/** Whether this runtime can route audio output to a chosen sink (Chromium/Electron
 *  expose HTMLMediaElement.setSinkId; some lib.dom targets don't). When false we
 *  hide the speaker picker rather than show an inert control. */
const CAN_PICK_SPEAKER =
  typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

/** Enumerate audio devices of one kind, with a generic fallback label when the
 *  real label is hidden (no mic permission granted yet this session). */
async function listDevices(kind: 'audioinput' | 'audiooutput'): Promise<AudioDevice[]> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return [];
  const fallback = kind === 'audioinput' ? 'Microphone' : 'Speaker';
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === kind)
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `${fallback} ${i + 1}` }));
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
  const { deviceId, setDeviceId, outputDeviceId, setOutputDeviceId } = useRealtimeMichael();
  const [mics, setMics] = useState<AudioDevice[]>([]);
  const [speakers, setSpeakers] = useState<AudioDevice[]>([]);
  /** True once at least one device exposes a real label ⇒ mic permission granted. */
  const [labelled, setLabelled] = useState(false);

  const refresh = useCallback(async () => {
    const [ins, outs] = await Promise.all([
      listDevices('audioinput'),
      CAN_PICK_SPEAKER ? listDevices('audiooutput') : Promise.resolve<AudioDevice[]>([])
    ]);
    setMics(ins);
    setSpeakers(outs);
    setLabelled(ins.some((m) => m.label && !/^Microphone \d+$/.test(m.label)));
  }, []);

  useEffect(() => {
    void refresh();
    // Hot-plug / unplug a device, or a permission grant that reveals labels → re-list.
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md) return;
    const onChange = (): void => void refresh();
    md.addEventListener?.('devicechange', onChange);
    return () => md.removeEventListener?.('devicechange', onChange);
  }, [refresh]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: 280 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
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
      </div>

      {CAN_PICK_SPEAKER && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={labelStyle}>Speaker</span>
          <select
            value={outputDeviceId ?? ''}
            onChange={(e) => setOutputDeviceId(e.target.value || null)}
            style={selectStyle}
          >
            <option value="">System default</option>
            {speakers.map((s) => (
              <option key={s.deviceId} value={s.deviceId}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {!labelled && (
        <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
          Device names appear after you first start a voice session and grant mic access.
          The microphone choice applies the next time Michael connects; the speaker switches live.
        </span>
      )}
    </div>
  );
}
