/**
 * How a god-hired worker's spawn request becomes an executable + argv, as a
 * pure function: this exact translation silently killed real workers for days
 * while reporting success, which is what earned it a unit test.
 */
import {
  autoModeFlagForProvider,
  defaultCommandForProvider,
  hasAutoModeStance,
  inferAgentProvider,
  normalizeAgentProvider
} from '../shared/agentProvider';
import { tokenizeCommand } from '../shared/commandLine';

export interface WorkerLaunch {
  /** The executable name alone — what the PTY layer resolves and spawns. */
  bin: string;
  /** Everything else, in argv form, model flag included when applicable. */
  args: string[];
  /** The full effective command line, for display and floor cards. */
  command: string;
}

/** Normalize CRLF in place and reject garbled string values in a parsed JSON request.
 *  This covers nested/unknown fields too, before any worker id is reserved.
 *  Iterative traversal avoids a stack overflow on deeply nested JSON. */
export function normalizeSpawnRequestStrings(raw: unknown): string | undefined {
  const pending: { value: unknown; path: string }[] = [{ value: raw, path: 'request' }];
  while (pending.length > 0) {
    const { value, path } = pending.pop()!;
    if (typeof value === 'string') {
      const controls = value.replace(/\r\n/g, '\n').match(/[\u0000-\u0008\u000B-\u001F\u007F]/g);
      if (controls) {
        const codes = [...new Set(controls)].map(ch => `U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
        // Do not quote the value: it may be a brief, a command, or a secret.
        return `${path} contains control characters (${codes.join(', ')}); a Windows path may have lost its escaping`;
      }
    } else if (value && typeof value === 'object') {
      const entries = Object.entries(value);
      for (let i = entries.length - 1; i >= 0; i--) {
        const [key, child] = entries[i];
        const normalized = typeof child === 'string' ? child.replace(/\r\n/g, '\n') : child;
        if (normalized !== child) (value as Record<string, unknown>)[key] = normalized;
        pending.push({ value: normalized, path: Array.isArray(value) ? `${path}[${key}]` : `${path}[${JSON.stringify(key)}]` });
      }
    }
  }
}

export function buildWorkerLaunch(opts: {
  /** `command` from the spawn request — god authors a full command LINE. */
  requestCommand?: unknown;
  requestProvider?: unknown;
  /** Separate `model` field from the request, if any. */
  requestModel?: unknown;
  defaultCommand?: string;
  /** The app's auto (skip-permissions) setting. */
  autoMode: boolean;
}): WorkerLaunch {
  const requestCommand =
    typeof opts.requestCommand === 'string' && opts.requestCommand.trim()
      ? opts.requestCommand.trim()
      : '';
  const requestProvider = normalizeAgentProvider(opts.requestProvider);
  const fallbackCommand = opts.defaultCommand ?? 'claude';
  // An explicit command may be a wrapper or shim and remains authoritative.
  // Without one, keep the executable and provider behavior coherent by taking
  // the provider's canonical command before the configured legacy fallback.
  let command =
    requestCommand ||
    (requestProvider ? defaultCommandForProvider(requestProvider, fallbackCommand) : fallbackCommand);
  // Inherit the app's auto (skip-permissions) mode when the request takes no
  // stance of its own: a headless worker has no human to click through tool
  // prompts, so without the flag it stalls at the first ask until the idle
  // reaper kills it. The flag is the PROVIDER'S — a codex worker needs
  // `-a never -s workspace-write`, and claude's --permission-mode
  // would mean nothing to it (an earlier hardcoded-claude version left every
  // non-claude worker stalling; review caught it). An explicit stance in the
  // request still wins: the flag's leading token already present as a TOKEN
  // (not substring — copilot's flag starts with `-s`) means the request chose.
  const provider = inferAgentProvider(command, requestProvider);
  const autoFlag = opts.autoMode ? autoModeFlagForProvider(provider) : '';
  if (autoFlag && !hasAutoModeStance(tokenizeCommand(command), provider)) {
    command += ` ${autoFlag}`;
  }
  // god authors `command` as a full command LINE ("claude --model … --permission-mode …"),
  // but the PTY layer takes ONE executable name (resolveCommand) plus argv — the
  // unsplit line made node-pty exec a binary literally named like the whole
  // string → ENOENT → the worker died within ~1s of spawning while its request
  // archived as .done (this killed both flag-carrying Ryan spawns on 2026-08-16;
  // only the bare-`claude` one lived). Split with the SAME tokenizer the
  // renderer's spawn flows use, and hand the flags over as argv.
  const tokens = tokenizeCommand(command);
  const bin = tokens[0] || command;
  const flags = tokens.slice(1);
  // A separate `model` field only applies when the command line didn't pick a
  // model itself (spawnAgentCore likewise skips its default-model injection
  // when argv already carries --model).
  const model =
    typeof opts.requestModel === 'string' && opts.requestModel.trim() ? opts.requestModel.trim() : '';
  const args = [...flags, ...(model && !flags.includes('--model') ? ['--model', model] : [])];
  return { bin, args, command };
}
