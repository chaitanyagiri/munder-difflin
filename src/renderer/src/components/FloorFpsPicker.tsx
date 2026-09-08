import { useState } from 'react';
import type { HarnessConfig } from '@/store/config';
import { useStore } from '@/store/store';
import { FLOOR_FPS_CHOICES, resolveFloorFps } from '@shared/floorFps';

/**
 * Settings → General → "Floor frame rate": how fast the pixel office redraws.
 *
 * The office animates for as long as the app is open, so its frame rate is the
 * app's largest continuous cost and, on a laptop, its largest continuous battery
 * draw. The default is low for that reason. This exists because smoothness is a
 * legitimate thing to want, and on a desktop the power may simply not matter.
 *
 * Applying is instant and reversible: the store mirror drives the live Pixi
 * ticker, so the floor repaints at the new rate as soon as you click. There is
 * nothing destructive here and nothing to confirm.
 */
export function FloorFpsPicker({ config }: { config: HarnessConfig }) {
  const stored = resolveFloorFps(config.floorMaxFps);
  const [current, setCurrent] = useState<number>(stored);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const setFloorMaxFps = useStore((s) => s.setFloorMaxFps);

  const choose = async (fps: number) => {
    if (busy || fps === current) return;
    setBusy(true);
    setNote('');
    const previous = current;
    // Optimistic: the scene picks the rate up from the store immediately, so the
    // click and the repaint happen together rather than after a round trip.
    setCurrent(fps);
    setFloorMaxFps(fps);
    try {
      await window.cth.updateConfig({ floorMaxFps: fps });
    } catch {
      setCurrent(previous);
      setFloorMaxFps(previous);
      setNote('Could not save that — the floor is back on the previous rate.');
    }
    setBusy(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 18 }}>
      <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)' }}>
        FLOOR FRAME RATE
      </div>
      <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-700)' }}>
        How fast the office redraws. It does not change how fast anything moves — the floor's
        motion runs on elapsed time, so a character covers the same ground per second at every
        setting and simply does it in fewer steps. It changes how smooth that looks, and what the
        scene costs while the app sits open.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {FLOOR_FPS_CHOICES.map((choice) => {
          const active = choice.fps === current;
          return (
            <button
              key={choice.fps}
              onClick={() => void choose(choice.fps)}
              disabled={busy}
              style={{
                display: 'flex', alignItems: 'baseline', gap: 10, width: '100%',
                padding: '7px 9px', textAlign: 'left', cursor: busy ? 'default' : 'pointer',
                border: 'none',
                background: active ? 'var(--cth-lilac-light, #ece2f5)' : 'var(--cth-paper-100)',
                boxShadow: `inset 0 0 0 ${active ? 2 : 1}px var(--cth-ink-${active ? '700' : '100'})`,
                fontFamily: 'var(--cth-font-mono)', fontSize: 13, color: 'var(--cth-ink-900)'
              }}
            >
              <span style={{ minWidth: 74 }}>{choice.label}</span>
              <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{choice.note}</span>
            </button>
          );
        })}
      </div>
      {note && (
        <div style={{ fontSize: 11, color: 'var(--cth-coral)' }}>{note}</div>
      )}
      <div style={{ fontSize: 11, color: 'var(--cth-ink-300)', lineHeight: '15px' }}>
        Measured on a 120 Hz display: uncapped the floor costs 26.7% of a CPU core plus 16.9% of the
        GPU process; at the default it is 12.7% and 5.8%. Yours will differ — a 60 Hz display is
        already doing half the work of a 120 Hz one before any of this applies.
      </div>
    </div>
  );
}
