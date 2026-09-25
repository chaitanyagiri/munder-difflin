/**
 * HIVE PICKER — whether a launch may skip the "SELECT A HARNESS CONFIG" screen.
 *
 * The picker holds the whole floor: nothing spawns until someone clicks "open".
 * On a desk that is one click. On an unattended host (systemd + Xvfb, #595) it
 * is an outage with no error, re-armed by every restart, while the scheduler and
 * fleet.json keep looking healthy. `openLastHiveOnLaunch` is the opt-out.
 */

/** The config fields this decision reads. A structural subset, so main, preload
 *  and renderer can each pass their own HarnessConfig mirror. */
export interface HivePickerConfig {
  onboardingComplete: boolean;
  harnessHome: string | null;
  openLastHiveOnLaunch?: boolean;
}

/** True when this launch should open `harnessHome` without showing the picker.
 *  Needs a finished onboarding and a home to reopen; with neither there is
 *  nothing to skip to, so the picker (or onboarding) is the only way forward. */
export function shouldAutoOpenHive(cfg: HivePickerConfig): boolean {
  return cfg.onboardingComplete
    && cfg.openLastHiveOnLaunch === true
    && typeof cfg.harnessHome === 'string'
    && cfg.harnessHome.trim() !== '';
}

/** What the renderer reports to main, published as fleet.json's `floor`. */
export type FloorState = 'awaiting-hive-selection' | 'open';

export function isFloorState(v: unknown): v is FloorState {
  return v === 'awaiting-hive-selection' || v === 'open';
}
