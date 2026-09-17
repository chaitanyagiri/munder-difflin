import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { useStore } from '@/store/store';
import { useResolvedGodName } from '@/hooks/useResolvedGodName';

/**
 * Shown on the empty floor instead of {@link MichaelBooting} / the "add agent"
 * empty-floor panel when `config.manualTeamStart` is on and the user has not
 * clicked Start yet this session.
 *
 * The distinction from MichaelBooting matters: that panel means "something is
 * happening, wait a second" — showing it here, with nothing actually booting,
 * would read as a hang. This is a deliberate pause, so it says so and gives the
 * same action as the header's Start button (both call `requestTeamStart`),
 * for discoverability from the center of an otherwise-empty screen.
 *
 * Per-agent engine choices belong to the restore dropdown ("previous session"),
 * where each agent's duty is already settable — not to this panel.
 *
 * Plain English rather than i18n, matching MichaelBooting and the empty-floor
 * panel it sits alongside — neither of those is translated either.
 */
export function ReadyToStart() {
  const godName = useResolvedGodName();
  const requestTeamStart = useStore(s => s.requestTeamStart);

  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      pointerEvents: 'none'
    }}>
      <div style={{ pointerEvents: 'auto', width: 360 }}>
        <PixelPanel variant="dialog" title="TEAM PAUSED" noPadding>
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-700)' }}>
              Manual start is on — nobody is running yet, {godName} included. Assign
              roles or check settings, then hit start to bring the floor online.
            </p>
            <PixelButton variant="primary" size="md" onClick={requestTeamStart}>
              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <Icon name="play" /> start
              </span>
            </PixelButton>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}
