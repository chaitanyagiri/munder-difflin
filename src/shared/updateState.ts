/**
 * Auto-update status model + presentation mapping.
 *
 * Deliberately electron-free: main (src/main/updater.ts) produces these states
 * from electron-updater events, the toolbar badge
 * (src/renderer/src/components/UpdateBadge.tsx) renders them, and the rules that
 * matter — which state wins when two arrive out of order, what the button says
 * and does — live here where they can be unit-tested without booting Electron.
 */

export type UpdateStatus =
  /** Nothing known yet (fresh window, or dev build where we never check). */
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'not-available' }
  | { state: 'available'; version: string; notes?: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'downloaded'; version: string; notes?: string }
  /** This install can't self-update (win-portable, or the native path failed):
   *  notify-only, link to the release page. `reason` is the underlying error. */
  | { state: 'available-manual'; version: string; url: string; reason?: string }
  | { state: 'error'; message: string };

export type UpdateAction = 'none' | 'check' | 'download' | 'restart' | 'open-release';

export interface UpdateBadgeView {
  /** Extra text beside the version, or null to show the version alone. */
  label: string | null;
  /** What a click does. 'none' renders the badge non-interactive. */
  action: UpdateAction;
  tone: 'idle' | 'busy' | 'ready' | 'warn';
  /** Tooltip — the only place the underlying error is ever surfaced verbatim. */
  title: string;
  busy: boolean;
}

/** `1.2.3` / `v1.2.3` -> [1,2,3]; null for anything that isn't semver-ish. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = String(v ?? '').trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** Download percentages arrive as floats and, on a resumed/differential
 *  download, occasionally out of range. Clamp so the UI can't render `-0%`
 *  or `104%`. */
export function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** How far along the update pipeline a state is. A later stage is never
 *  replaced by an earlier one for the SAME version — see `reduceStatus`. */
function rank(s: UpdateStatus): number {
  switch (s.state) {
    case 'idle': return 0;
    case 'checking': return 1;
    case 'not-available': return 1;
    case 'error': return 1;
    case 'available-manual': return 2;
    case 'available': return 3;
    case 'downloading': return 4;
    case 'downloaded': return 5;
  }
}

function versionOf(s: UpdateStatus): string | null {
  return 'version' in s ? s.version : null;
}

/**
 * Fold a new status into the current one.
 *
 * The rule that matters: once an update is staged, the 6-hourly re-check (or a
 * manual "check now") must NOT wipe the "restart to update" affordance out from
 * under the user — `checking` / `not-available` / a transient `error` are all
 * lower-rank and lose. A genuinely NEWER version always wins, so a long-running
 * app that sees 0.3.7 while 0.3.6 is staged moves forward rather than sticking.
 */
export function reduceStatus(prev: UpdateStatus | null, next: UpdateStatus): UpdateStatus {
  if (!prev) return next;
  const pv = versionOf(prev);
  const nv = versionOf(next);
  if (pv && nv && isNewer(nv, pv)) return next;   // a newer release supersedes
  if (pv && nv && pv !== nv) return next;         // different (e.g. rolled back) release
  return rank(next) >= rank(prev) ? next : prev;
}

/**
 * What the toolbar badge shows and does for a given status.
 *
 * `currentVersion` is the running app's version — it is always rendered next to
 * the logo, so every one of these views is "v0.3.6" plus at most one extra chip.
 */
export function describeUpdate(status: UpdateStatus | null, currentVersion: string): UpdateBadgeView {
  const v = currentVersion;
  switch (status?.state) {
    case 'checking':
      return { label: 'checking…', action: 'none', tone: 'busy', busy: true, title: `Checking for updates (you're on v${v})` };
    case 'available':
      return {
        label: `v${status.version} ready to install`, action: 'download', tone: 'ready', busy: false,
        title: `Version ${status.version} is available — click to download it`
      };
    case 'downloading':
      return {
        label: `downloading ${clampPercent(status.percent)}%`, action: 'none', tone: 'busy', busy: true,
        title: `Downloading v${status.version}… ${clampPercent(status.percent)}%`
      };
    case 'downloaded':
      return {
        label: `restart to update to v${status.version}`, action: 'restart', tone: 'ready', busy: false,
        title: `v${status.version} is downloaded and ready — click to restart and apply it`
      };
    case 'available-manual':
      return {
        label: `v${status.version} — get it manually`, action: 'open-release', tone: 'warn', busy: false,
        title: status.reason
          ? `This install couldn't update itself (${status.reason}) — click to open the release page`
          : `This install can't update itself — click to open the release page`
      };
    case 'error':
      return {
        label: 'update check failed', action: 'check', tone: 'warn', busy: false,
        title: `${status.message} — click to try again`
      };
    case 'not-available':
      return { label: null, action: 'check', tone: 'idle', busy: false, title: `v${v} is the latest version — click to check again` };
    case 'idle':
    default:
      return { label: null, action: 'check', tone: 'idle', busy: false, title: `v${v} — click to check for updates` };
  }
}

/** The same status, rendered for Settings instead of the toolbar chip. */
export interface UpdateSettingsView {
  /** Headline: the version that matters right now — yours, or the one waiting. */
  headline: string;
  /** One sentence of explanation. Carries the verbatim error when there is one. */
  detail: string;
  /** Primary button label, or null while the updater is mid-flight and there is
   *  nothing useful to press. */
  button: string | null;
  action: UpdateAction;
  busy: boolean;
  tone: 'idle' | 'busy' | 'ready' | 'warn';
}

/**
 * What the Settings → General "Updates" block shows and does.
 *
 * Separate from `describeUpdate` on purpose. The toolbar chip has room for two
 * words and has to stay quiet when nothing is happening, so its idle state says
 * nothing at all; Settings is where someone goes *to ask*, so every state gets a
 * full sentence and — outside the two mid-flight states — a button. The states
 * and the transitions between them are shared, which is the part that has to
 * stay in sync.
 */
export function describeUpdateSettings(
  status: UpdateStatus | null,
  currentVersion: string
): UpdateSettingsView {
  const v = currentVersion;
  switch (status?.state) {
    case 'checking':
      return {
        headline: `You're on v${v}`,
        detail: 'Checking for a newer release…',
        button: null, action: 'none', busy: true, tone: 'busy'
      };
    case 'available':
      return {
        headline: `v${status.version} is available`,
        detail: `You're on v${v}. Download it now — you'll be asked to restart once it's ready.`,
        button: `Download v${status.version}`, action: 'download', busy: false, tone: 'ready'
      };
    case 'downloading':
      return {
        headline: `Downloading v${status.version}`,
        detail: `${clampPercent(status.percent)}% done. You can keep working; the restart is yours to trigger.`,
        button: null, action: 'none', busy: true, tone: 'busy'
      };
    case 'downloaded':
      return {
        headline: `v${status.version} is ready to install`,
        detail: `Restart Planet Express to finish updating from v${v}.`,
        button: 'Restart to update', action: 'restart', busy: false, tone: 'ready'
      };
    case 'available-manual':
      return {
        headline: `v${status.version} is available`,
        detail: status.reason
          ? `This install can't update itself (${status.reason}) — download it from the release page.`
          : `This install can't update itself — download it from the release page.`,
        button: 'Open release page', action: 'open-release', busy: false, tone: 'warn'
      };
    case 'error':
      return {
        headline: 'Update check failed',
        detail: `${status.message} (you're on v${v}).`,
        button: 'Try again', action: 'check', busy: false, tone: 'warn'
      };
    case 'not-available':
      return {
        headline: `v${v} is the latest version`,
        detail: "You're already up to date — nothing to install.",
        button: 'Check again', action: 'check', busy: false, tone: 'idle'
      };
    case 'idle':
    default:
      return {
        headline: `You're on v${v}`,
        detail: 'Updates are checked automatically every 6 hours. Check now if you want to be sure.',
        button: 'Check for updates', action: 'check', busy: false, tone: 'idle'
      };
  }
}
