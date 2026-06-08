/**
 * Free Flow entry point B — hold-Option-to-talk (the human's chosen activation).
 *
 * Hold the Option (⌥) key ALONE for a short threshold to ARM recording; release
 * to stop and transcribe into the focused agent's composer draft (same path as
 * the mic button — review before send). Active only while Free Flow is enabled.
 *
 * The hard part is the TERMINAL Alt/Meta conflict: in a terminal Option is Meta
 * (Alt+key combos, special chars), so a naive "Option is down → record" would
 * clobber normal input. Disambiguation:
 *   - A solo-hold THRESHOLD (~320ms): Option must be held alone, with no other
 *     key, before recording arms. A quick Alt+key combo never reaches it.
 *   - ABORT the instant any other key joins while Option is down (and before
 *     recording armed) — it's a real Alt combo; we never call preventDefault, so
 *     the terminal/composer sees the keystroke untouched.
 *   - Auto-repeat keydowns (e.repeat) are ignored so a held Option doesn't re-arm.
 *   - Listeners are CAPTURE-phase on window, so the gesture still fires while
 *     xterm (or the composer textarea) holds DOM focus.
 *   - We never preventDefault, so when not recording, Option behaves exactly as
 *     before for terminals and text fields.
 *
 * Scope: works app-wide while the window is focused (covers any agent's terminal
 * screen per the requirement). Target = the fullscreen agent, else the selected
 * agent. A window blur resets state so a release missed off-window can't strand a
 * recording.
 */
import { useEffect } from 'react';
import { useStore } from '@/store/store';
import { freeflowRecorder } from './recorder';

/** How long Option must be held ALONE before recording arms. Long enough that a
 *  normal Alt+key combo (which disqualifies immediately) never trips it. */
const ARM_MS = 320;

function isOptionKey(e: KeyboardEvent): boolean {
  return e.code === 'AltLeft' || e.code === 'AltRight' || e.key === 'Alt' || e.key === 'AltGraph';
}

/** Install the hold-Option-to-talk gesture for as long as the component is
 *  mounted. Reads enablement + the focused agent from the store live. */
export function useHoldOptionToTalk(): void {
  useEffect(() => {
    let optionDown = false;     // Option physically held right now
    let armTimer: ReturnType<typeof setTimeout> | null = null;
    let recording = false;      // THIS gesture started a recording
    let disqualified = false;   // another key joined → treat as a normal Alt combo

    const focusedAgentId = (): string | null => {
      const s = useStore.getState();
      return s.fullscreenAgentId ?? s.selectedId;
    };

    const clearArm = (): void => {
      if (armTimer) { clearTimeout(armTimer); armTimer = null; }
    };

    const reset = (): void => {
      clearArm();
      if (recording) freeflowRecorder.stop();
      optionDown = false;
      recording = false;
      disqualified = false;
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      // Only active when Free Flow is on.
      if (!useStore.getState().freeflowEnabled) return;

      if (isOptionKey(e)) {
        if (e.repeat || optionDown) return; // ignore auto-repeat / already tracking
        optionDown = true;
        disqualified = false;
        // Don't start a second capture if one is already running/uploading.
        if (freeflowRecorder.isBusy()) { disqualified = true; return; }
        const target = focusedAgentId();
        if (!target) { disqualified = true; return; }
        clearArm();
        armTimer = setTimeout(() => {
          armTimer = null;
          if (optionDown && !disqualified) {
            recording = true;
            void freeflowRecorder.start(target);
          }
        }, ARM_MS);
        return;
      }

      // Any non-Option key while Option is held, BEFORE recording armed, means a
      // real Alt combo (or plain typing) — disqualify and let it pass untouched.
      if (optionDown && !recording) {
        disqualified = true;
        clearArm();
      }
    };

    const onKeyUp = (e: KeyboardEvent): void => {
      if (!isOptionKey(e)) return;
      clearArm();
      if (recording) freeflowRecorder.stop(); // release → transcribe
      optionDown = false;
      recording = false;
      disqualified = false;
    };

    // Capture phase so xterm/textarea focus can't swallow the events first.
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', reset);
      reset();
    };
  }, []);
}
