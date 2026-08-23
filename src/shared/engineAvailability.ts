/**
 * Can the engine a user is about to pick actually boot on this machine?
 *
 * The onboarding wizard records Michael's engine and nothing checks it until the
 * first spawn. spawnAgentCore then runs the install ladder (cliInstall.ts), and
 * for a provider with no `installCommand` and no `nativeInstallCommand` that
 * ladder ends at the `manual` rung: a hint is printed in a terminal and the
 * orchestrator never starts. This module turns the setup catalog probe
 * (`tools:status`, which already resolves every engine binary on PATH) into one
 * answer per provider so the wizard can say so BEFORE the pick is committed.
 *
 * Pure and electron-free on purpose so it is testable from node --test.
 */
import type { AgentProvider } from './agentProvider';
import type { ToolStatus } from './toolCatalog';

export type EngineAvailabilityState =
  /** The binary resolves on this machine. */
  | 'installed'
  /** Not here yet, but the provider ships an installer the app runs on first spawn. */
  | 'installs-on-first-run'
  /** Not here and nothing we can run: the user has to install it by hand first. */
  | 'not-installable'
  /** The probe did not run or did not cover this provider. Never block on this. */
  | 'unknown';

export interface EngineAvailability {
  state: EngineAvailabilityState;
  /** Absolute path when installed. */
  path: string | null;
  /** The command the app would run (or the user could paste) to install it. */
  installCommand: string;
  docsUrl?: string;
}

/** Classify one provider from the catalog probe. `statuses` is what
 *  `window.cth.toolsStatus()` returned; undefined means it has not run (yet). */
export function classifyEngineAvailability(
  statuses: readonly ToolStatus[] | undefined,
  provider: AgentProvider
): EngineAvailability {
  const row = statuses?.find((s) => s.id === `engine:${provider}`);
  if (!row) return { state: 'unknown', path: null, installCommand: '' };
  const installCommand = row.installCommand ?? '';
  if (row.found) return { state: 'installed', path: row.path, installCommand, docsUrl: row.docsUrl };
  return {
    state: installCommand ? 'installs-on-first-run' : 'not-installable',
    path: null,
    installCommand,
    docsUrl: row.docsUrl
  };
}

/** Whether the wizard must refuse to move on with this engine selected. Only the
 *  proven dead end blocks; an unknown probe never locks a user out. */
export function engineBlocksOnboarding(a: EngineAvailability): boolean {
  return a.state === 'not-installable';
}

/** One short line for the badge on each engine row. */
export function engineAvailabilityBadge(a: EngineAvailability): string | null {
  switch (a.state) {
    case 'installed': return 'INSTALLED';
    case 'installs-on-first-run': return 'INSTALLS ON FIRST RUN';
    case 'not-installable': return 'NOT INSTALLED';
    default: return null;
  }
}

/** The explanation shown under the picker when the selected engine cannot boot.
 *  Written for someone who does not know what a CLI engine is: what happened,
 *  then what to do next. */
export function engineAvailabilityMessage(a: EngineAvailability, label: string): string | null {
  if (a.state !== 'not-installable') return null;
  return `${label} is not installed on this computer and the app has no installer for it, ` +
    `so Michael could not start. Install it first, then press "check again". ` +
    `Or pick Claude Code, which installs itself on first run.`;
}
