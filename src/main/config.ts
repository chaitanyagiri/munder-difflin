import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** A recurring auto-dispatched mission fired on an interval by the scheduler. */
export interface ScheduledMission {
  id: string;
  label: string;
  intervalMs: number;
  to: string;
  body: string;
  enabled: boolean;
  lastFiredAt?: number;
}

export interface HarnessConfig {
  /** Has the user completed the first-run onboarding? */
  onboardingComplete: boolean;
  /** Folder where the harness keeps its own state (agent metadata, logs). */
  harnessHome: string | null;
  /** Folders the user registered during onboarding (used as quick-picks). */
  registeredRepos: string[];
  /** When true, new agents are spawned with --permission-mode bypassPermissions. */
  autoMode: boolean;
  /** The command we run when spawning a new agent. */
  defaultCommand: string;
  /** Default model for newly spawned agents (e.g. 'claude-sonnet-4-6[1m]'); unset = CLI default. */
  defaultModel?: string;
  /** Enable semantic memory (MemPalace CLI). No-op if mempalace isn't installed. */
  semanticMemory: boolean;
  /** Embedding model for the palace: lightweight 'minilm' or multilingual 'embeddinggemma'. */
  embeddingModel: 'minilm' | 'embeddinggemma';
  /** Recurring auto-dispatch missions handled by the scheduler. */
  missions?: ScheduledMission[];
  /** Fire native desktop notifications on agent lifecycle events (idle finish / waiting for input). */
  notifications?: boolean;
}

const DEFAULTS: HarnessConfig = {
  onboardingComplete: false,
  harnessHome: null,
  registeredRepos: [],
  autoMode: true,
  defaultCommand: 'claude',
  semanticMemory: true,
  embeddingModel: 'minilm',
  missions: [],
  notifications: false
};

function configPath(): string {
  return join(app.getPath('userData'), 'config.json');
}

export function readConfig(): HarnessConfig {
  const p = configPath();
  if (!existsSync(p)) return { ...DEFAULTS };
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeConfig(patch: Partial<HarnessConfig>): HarnessConfig {
  const current = readConfig();
  const next: HarnessConfig = { ...current, ...patch };
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** Wipe the persisted config back to first-run defaults so the app boots into
 *  onboarding again. Used by the "reset & start over" flow. */
export function resetConfig(): HarnessConfig {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(DEFAULTS, null, 2), 'utf8');
  return { ...DEFAULTS };
}

/** Auto-suggested command string given current autoMode preference. */
export function commandForAutoMode(config: HarnessConfig): string {
  if (config.autoMode) {
    return `${config.defaultCommand} --permission-mode bypassPermissions`;
  }
  return config.defaultCommand;
}

/** Ensure harnessHome exists on disk. */
export function ensureHarnessHome(path: string): { ok: boolean; error?: string } {
  try {
    mkdirSync(path, { recursive: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
