import type { TFunction } from 'i18next';
import { enT } from './enFallback';

/**
 * The label to SHOW for a scheduled mission.
 *
 * Built-in missions are written into the user's config on first run, English
 * label included, so the stored label cannot carry the UI language — it would
 * freeze whichever language was active that day. Instead a built-in whose
 * stored label still equals its shipped English (en.json `missions.<id>`) is
 * shown translated; anything else — a user-made mission, or a built-in the
 * user renamed — is shown exactly as typed. test/mission-label.test.cjs keeps
 * en.json and src/main/config.ts in step, or every built-in would silently
 * count as renamed.
 */
export function displayMissionLabel(
  mission: { id: string; label: string },
  t?: TFunction
): string {
  const key = `missions.${mission.id}`;
  return mission.label === enT(key) ? (t ?? enT)(key) : mission.label;
}
