/**
 * The missing-engine-CLI install ladder.
 *
 * Split out of index.ts deliberately: it imports NOTHING from electron, so the
 * decision ("which installer can actually succeed on this machine?") and the
 * script it emits are both testable without booting an app.
 */
import type { AgentProvider, ProviderInstallInfo } from '../shared/agentProvider';
import { installInfoForProvider } from '../shared/agentProvider';
import type { NodeInstaller } from './nodeInstall';
import { buildNodeInstallScript } from './nodeInstall';

export type InstallRungKind = 'npm' | 'node-then-npm' | 'native' | 'manual';

/** Pick which rung of the install ladder to run, given what this machine has.
 *
 *  Every provider's `installCommand` is `npm install -g …`, which needs npm,
 *  which needs node. On a machine with no node the banner used to print that
 *  command anyway and run it — so the user watched `npm: command not found`
 *  scroll past and concluded the app was broken. Classify first:
 *
 *    npm usable                        → npm install (unchanged; the common case)
 *    npm absent, Node installer found  → install real Node + npm, THEN npm install
 *    npm absent, native installer      → the vendor's self-contained installer
 *    neither                           → manual only. Do NOT run a doomed command.
 *
 *  Founder decision (2026-08-07) put `node-then-npm` ABOVE `native`, reversing the
 *  earlier "never auto-install a system Node" rule: a user who only ever gets the
 *  node-free Claude installer still has no runtime for MCP servers, hooks, or any
 *  other provider — so the default is to fix the machine, not to route around it.
 *  `native` survives as the fallback for when no installer could be resolved
 *  (offline, or a platform nodejs.org ships no package for).
 *
 *  `npmAvailable` means npm is present AND its Node is new enough (see
 *  nodeInstall.NODE_FLOOR_MAJOR) — an ancient Node routes into the upgrade rung. */
export function chooseInstallRung(
  info: ProviderInstallInfo,
  npmAvailable: boolean,
  nodeInstaller?: NodeInstaller | null
): { command?: string; kind: InstallRungKind; nodeMissing: boolean } {
  if (info.command && npmAvailable) return { command: info.command, kind: 'npm', nodeMissing: false };
  if (info.command && nodeInstaller) return { command: info.command, kind: 'node-then-npm', nodeMissing: true };
  if (info.nativeCommand) return { command: info.nativeCommand, kind: 'native', nodeMissing: !npmAvailable };
  return { kind: 'manual', nodeMissing: !npmAvailable };
}

/** Build the shell script the missing-CLI auto-install path runs IN PLACE of a
 *  missing engine CLI. When a rung of the ladder above is runnable it prints a
 *  banner then RUNS it visibly (so the user can watch + finish any sign-in);
 *  otherwise it prints a manual instruction only and runs nothing. The script is
 *  emitted in the target platform's shell syntax ($SHELL on unix, cmd.exe on
 *  Windows) — `platform` is a parameter only so the Windows branch is reachable
 *  from a test on macOS. The only user-derived value (the missing binary name) is
 *  sanitized to a safe identifier; the install commands are trusted constants. */
export function buildMissingCliScript(
  bin: string,
  provider: AgentProvider,
  npmAvailable: boolean,
  platform: string = process.platform,
  nodeInstaller?: NodeInstaller | null
): string {
  const info: ProviderInstallInfo = installInfoForProvider(provider, platform);
  const safeBin = (bin || provider).replace(/[^A-Za-z0-9._-]/g, '') || provider;
  const rung = chooseInstallRung(info, npmAvailable, nodeInstaller);
  // Only the rung that actually needs it gets the Node install spliced in.
  const nodeSteps = rung.kind === 'node-then-npm' && nodeInstaller
    ? buildNodeInstallScript(nodeInstaller, platform)
    : null;
  const cmd = rung.command; // trusted constant, or undefined → manual hint only
  const label = info.label;
  const docs = info.docsUrl;
  const rule = '------------------------------------------------------------';

  if (platform === 'win32') {
    // ONE cmd.exe line: `&` chains steps, `^&` prints a literal ampersand, and the
    // script carries NO double-quotes (it is wrapped verbatim in `/d /s /c "..."`).
    // We avoid `if errorlevel` branching (untestable here) — a combined success/
    // failure hint after the install is robust and satisfies the manual-fallback DoD.
    const parts: string[] = ['echo.', `echo ${rule}`, `echo   Engine CLI not found:  ${safeBin}`, 'echo.'];
    if (nodeSteps && nodeInstaller) {
      parts.push(
        'echo   Node.js is not installed on this machine, so the usual npm',
        `echo   installer cannot run yet. Installing Node ${nodeInstaller.version} ^(+ npm^) first,`,
        'echo   straight from nodejs.org, checksum-verified.',
        'echo.',
        ...nodeSteps,
        'echo.'
      );
    } else if (rung.nodeMissing) {
      parts.push('echo   Node.js is not installed on this machine, so the usual', 'echo   npm installer cannot run here.', 'echo.');
    }
    if (cmd) {
      if (rung.kind === 'native') parts.push(`echo   Using the self-contained ${label} installer instead ^(no Node needed^):`);
      else parts.push(`echo   Installing the ${label} CLI now so you can watch:`);
      parts.push(
        'echo.',
        `echo     ${cmd}`,
        `echo ${rule}`,
        'echo.',
        cmd,
        'echo.',
        'echo   [done] If it succeeded, the agent launches automatically.',
        'echo   If it failed, run the command above manually, then restart the agent.',
        // Propagate the failure to cmd's exit code: the `&`-chain's own status is
        // its LAST segment (an echo), so without this a failed install exits 0 and
        // the PTY-exit handler keys its relaunch on `exitCode === 0`. Plain
        // `%errorlevel%` expands at PARSE time (0 for the whole one-liner) — but
        // `if errorlevel 1` reads the LIVE errorlevel, so this fires only when the
        // install (or a Node-install step) actually failed. The trailing echos and
        // the manual-fix hint stay on screen either way.
        'if errorlevel 1 cmd /c exit 1'
      );
    } else {
      if (rung.nodeMissing) {
        parts.push(
          `echo   Install Node.js ^(nodejs.org^), then the ${label} CLI:`,
          `echo     ${info.command ?? ''}`,
          'echo   …or install the CLI by whatever method its docs recommend.'
        );
      } else {
        parts.push(
          `echo   No bundled installer for the ${label} provider.`,
          'echo   Install it manually, then restart the agent to launch it.'
        );
      }
      if (docs) parts.push(`echo   Docs: ${docs}`);
      parts.push(`echo ${rule}`);
    }
    return parts.join(' & ');
  }

  // unix ($SHELL -lc <script>): one statement per line, single-quoted echo text so
  // no shell metacharacter expands. We avoid `!` so any shell with history
  // expansion never fires. npm is found via the interactive PATH spawn() injects.
  const lines: string[] = [
    `echo ''`,
    `echo '${rule}'`,
    `echo '  Engine CLI not found:  ${safeBin}'`,
    `echo ''`
  ];
  if (nodeSteps && nodeInstaller) {
    // The default path on a bare machine: fix the runtime, then use it. Every
    // step aborts the whole script on failure, so the npm install below only
    // ever runs against a Node that actually landed.
    lines.push(
      `echo '  Node.js is not installed on this machine, so the usual npm'`,
      `echo '  installer cannot run yet. Installing Node ${nodeInstaller.version} (+ npm) first,'`,
      `echo '  straight from nodejs.org, checksum-verified.'`,
      `echo ''`,
      ...nodeSteps,
      `echo ''`
    );
  } else if (rung.nodeMissing) {
    lines.push(
      `echo '  Node.js is not installed on this machine, so the usual npm'`,
      `echo '  installer cannot run here.'`,
      `echo ''`
    );
  }
  if (cmd) {
    lines.push(
      ...(rung.kind === 'native'
        ? [`echo '  Using the self-contained ${label} installer instead (no Node needed) —'`,
           `echo '  finish any sign-in it prompts for, then come back to this terminal.'`]
        : [`echo '  Installing the ${label} CLI now so you can watch — finish any'`,
           `echo '  sign-in it prompts for, then come back to this terminal.'`]),
      `echo ''`,
      `echo '    ${cmd}'`,
      `echo '${rule}'`,
      `echo ''`,
      cmd,
      `__clirc=$?`,
      `echo ''`,
      `if [ $__clirc -eq 0 ]; then`,
      `  echo '  [done] Installed — launching the agent…'`,
      `else`,
      `  echo "  [x] Install exited with code $__clirc — finish it manually:"`,
      `  echo '    ${cmd}'`,
      ...(docs ? [`  echo '    Docs: ${docs}'`] : []),
      `  echo '  Then restart the agent to launch it.'`,
      `fi`,
      // Propagate the install's status: an if/else's own status is its last
      // command's (an echo, always 0), so without this the login shell exits 0
      // even for a failed install and the PTY-exit handler fires its
      // exitCode===0 relaunch. `exit $__clirc` keeps 0 for a clean install, so
      // the success path is untouched.
      `exit $__clirc`
    );
  } else if (rung.nodeMissing) {
    // The honest dead end: no node, and this vendor ships no node-free installer.
    // Say what is actually missing instead of running a command that cannot work.
    lines.push(
      `echo '  Install Node.js (nodejs.org), then the ${label} CLI:'`,
      ...(info.command ? [`echo '    ${info.command}'`] : []),
      `echo '  …or install the CLI by whatever method its docs recommend.'`,
      ...(docs ? [`echo '  Docs: ${docs}'`] : []),
      `echo '${rule}'`
    );
  } else {
    lines.push(
      `echo '  No bundled installer for the ${label} provider.'`,
      `echo '  Install it manually, then restart the agent to launch it.'`,
      ...(docs ? [`echo '  Docs: ${docs}'`] : []),
      `echo '${rule}'`
    );
  }
  return lines.join(String.fromCharCode(10));
}
