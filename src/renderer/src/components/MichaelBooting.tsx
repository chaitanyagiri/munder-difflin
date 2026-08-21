import { PixelPanel } from '@/components/PixelPanel';

/**
 * Loader shown on the empty floor while the god agent ("Michael") is clocking
 * in on launch. Replaces the "add agent" prompt so a returning user doesn't see
 * the empty-floor call-to-action before Michael has booted.
 */
export function MichaelBooting() {
  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      pointerEvents: 'none'
    }}>
      <div style={{ pointerEvents: 'auto', width: 360 }}>
        <PixelPanel variant="dialog" title="CLOCKING IN" noPadding>
          <div style={{
            padding: 20,
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14
          }}>
            {/* Stepped pixel blocks — staggered blink, no easing (matches aesthetic) */}
            <div style={{ display: 'flex', gap: 6 }}>
              {[0, 1, 2, 3].map((i) => (
                <span
                  key={`block-${i}`}
                  style={{
                    width: 14, height: 14,
                    background: '#6E1423',
                    boxShadow: 'var(--cth-shadow-hard)',
                    animation: 'cth-blink 1s steps(1, end) infinite',
                    animationDelay: `${i * 0.2}s`
                  }}
                />
              ))}
            </div>
            <p style={{
              margin: 0, fontSize: 13, lineHeight: '20px', textAlign: 'center',
              color: 'var(--cth-ink-700)'
            }}>
              Michael is settling into the corner office and getting the floor
              ready. Hang tight…
            </p>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}
