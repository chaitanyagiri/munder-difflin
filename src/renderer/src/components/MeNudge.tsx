import { useEffect, useRef, useState } from 'react';
import { PixelButton } from './PixelButton';
import { SpritePortrait } from './SpritePortrait';
import { MeCharacterCreator } from './MeCharacterCreator';
import { useStore } from '@/store/store';

/**
 * The one-time "Make Michael yours" nudge.
 *
 * WHY THIS EXISTS. The creator deliberately lives in the edit panel rather than
 * in onboarding: onboarding's job is to get someone to a working office fast,
 * and asking a user to personalise a mascot they met ninety seconds ago is
 * asking for a decision they cannot yet make well. The cost of that call is
 * discoverability — without a prompt the feature ships into a drawer nobody
 * opens — and this is the answer to it.
 *
 * WHEN. After a worker's first SUCCESSFUL run, because that is the first moment
 * personalising Michael means anything: the user has just watched their clone do
 * something useful. Not on launch, not on a timer.
 *
 * It appears at most once. Dismissing it and saving a character are both "dealt
 * with" — a user who customized from the edit panel on their own should never
 * then be told to.
 */
export function MeNudge() {
  const agents = useStore((s) => s.agents);
  const godRecipe = useStore((s) => s.godRecipe);
  const setGodRecipe = useStore((s) => s.setGodRecipe);

  const [armed, setArmed] = useState(false);
  const [dismissed, setDismissed] = useState(true); // assume handled until config says otherwise
  const [creatorOpen, setCreatorOpen] = useState(false);
  // Config is read once. Re-reading on every roster tick would let a save
  // elsewhere in the app resurrect a nudge the user just dismissed.
  const asked = useRef(false);

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void window.cth.getConfig()
      .then((c) => setDismissed(!!c.meNudgeDismissed || !!c.godRecipe))
      .catch(() => setDismissed(true));
  }, []);

  // A worker finishing a run is the trigger. The god's own status does not
  // count: it is busy from the moment the app opens, so it would fire this on
  // launch, which is exactly the moment the nudge is meaningless.
  useEffect(() => {
    if (armed || dismissed) return;
    if (agents.some((a) => !a.isGod && a.status === 'success')) setArmed(true);
  }, [agents, armed, dismissed]);

  const close = (persist: boolean) => {
    setDismissed(true);
    if (persist) void window.cth.updateConfig({ meNudgeDismissed: true });
  };

  if (dismissed || !armed) return creatorOpen ? renderCreator() : null;

  return (
    <>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 10px',
        background: 'var(--cth-sky-light)',
        boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
      }}>
        <div style={{
          width: 24, height: 30, overflow: 'hidden', flexShrink: 0,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'center'
        }}>
          <SpritePortrait character="michael" recipe={godRecipe} scale={1} />
        </div>
        <span style={{ flex: 1, minWidth: 0, fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-900)' }}>
          Michael just finished a job for you. Make him look like you?
        </span>
        <PixelButton size="sm" variant="primary" onClick={() => { setCreatorOpen(true); close(true); }}>
          Make Michael yours →
        </PixelButton>
        <PixelButton size="sm" variant="ghost" onClick={() => close(true)}>Not now</PixelButton>
      </div>
      {creatorOpen && renderCreator()}
    </>
  );

  function renderCreator() {
    return (
      <MeCharacterCreator
        recipe={godRecipe}
        onClose={() => setCreatorOpen(false)}
        onSave={(next) => {
          setGodRecipe(next);
          void window.cth.updateConfig({ godRecipe: next, meNudgeDismissed: true });
          setCreatorOpen(false);
        }}
      />
    );
  }
}
