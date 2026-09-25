'use strict';

/**
 * BUG REPRO — "Failed CLI install exits the PTY with code 0 on both POSIX and
 * Windows, so the relaunch path fires on failure."
 *
 * Surfaces involved:
 *   src/main/cliInstall.ts   buildMissingCliScript() — the script the
 *                            missing-CLI auto-install path runs in the agent
 *                            terminal (npm / native rungs).
 *   src/main/index.ts:603-621  the PTY-exit handler: `exitCode === 0` is the
 *                            ONLY install-success signal — it tracks
 *                            agent_install_finished{outcome:'agent_launched'},
 *                            broadcasts `pty:relaunch:<id>` and re-runs
 *                            spawnAgentCore with noAutoInstall:true; non-zero
 *                            is documented as the install-failed signal.
 *   src/main/pty.ts:711-733  node-pty forwards the shell's exit code verbatim
 *                            to that handler.
 *
 * The defect: buildMissingCliScript never propagates the installer's exit
 * status. The POSIX form captures `__clirc=$?` and prints it inside an
 * if/else — but an if/else's own status is the LAST COMMAND's, an `echo`, so
 * the login shell exits 0. The Windows form is ONE `&`-chained cmd.exe line
 * (pty.ts wraps it verbatim in `cmd /d /s /c "…"`) whose final segments are
 * `echo`s, so the installer's errorlevel is overwritten before cmd exits.
 *
 * Consequence (the failure scenario): ANY failing `npm install -g …` (network
 * down, EACCES, registry 404) exits the install PTY with 0 → the exit handler
 * takes the relaunch path (pty:relaunch broadcast, telemetry
 * outcome:'agent_launched', spawnAgentCore{noAutoInstall:true}) → the
 * still-missing binary is spawned and dies seconds later with bare 'process
 * exited'. Failed installs are indistinguishable from successful ones.
 *
 * This repro drives the REAL generated scripts — only the executed installer
 * command is substituted for a deterministic, offline, failing/succeeding
 * `node -e process.exit(N)`; every banner/hint byte stays production-identical
 * — through the REAL transports:
 *   - win32: the real PtyManager shellScript route (node-pty → cmd /d /s /c),
 *     exactly what index.ts:2657 spawn uses;
 *   - POSIX: `$SHELL -lc <script>`, exactly pty.ts:612-613.
 * and asserts the exit code the exit handler would receive.
 *
 * FAILS on current main (failing install ⇒ PTY exit 0, relaunch fires).
 * PASSES after a fix that propagates the installer's exit status (failing ⇒
 * non-zero so the handler records 'install_failed'; succeeding ⇒ 0 so the
 * relaunch still fires). No network, no npm, no real provider CLIs.
 */

const { existsSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');

const loadTs = require('../load-ts.cjs');
const { buildMissingCliScript } = loadTs('src/main/cliInstall.ts');
const { PtyManager } = loadTs('src/main/pty.ts');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WIN = process.platform === 'win32';

// Substitute installer commands: deterministic, offline, no npm. The win32
// forms must stay quote-free — the generated script is wrapped verbatim in
// `cmd /d /s /c "…"` and a single embedded quote would end the command line.
const FAIL_WIN = 'node -e process.exit(7)';
const OK_WIN = 'node -e process.exit(0)';
const FAIL_POSIX = 'node -e "process.exit(7)"';
const OK_POSIX = 'node -e "process.exit(0)"';

/** Replace ONLY the executed installer occurrence (never the echo'd banner
 *  hints) with `replacement`, leaving every other byte of the real script.
 *  win32 scripts are one ` & `-chained line; POSIX scripts are one statement
 *  per line. In both, executed statements never start with `echo`. */
function substituteExecuted(script, realCmd, replacement, label) {
  const isPosix = script.includes('\n');
  const segs = isPosix ? script.split('\n') : script.split(' & ');
  let hits = 0;
  const out = segs.map((seg) => {
    if (!seg.trim().startsWith('echo') && seg.includes(realCmd)) {
      hits++;
      return seg.split(realCmd).join(replacement);
    }
    return seg;
  }).join(isPosix ? '\n' : ' & ');
  assert.equal(hits, 1, `${label}: expected exactly one executed occurrence of the installer, got ${hits}`);
  return out;
}

/** Run a script through the EXACT production win32 transport — the real
 *  PtyManager shellScript route (node-pty → `cmd.exe /d /s /c "<script>"`) —
 *  and return what the exit handler receives. */
function ptyExit(id, shellScript) {
  return new Promise((resolve, reject) => {
    const mgr = new PtyManager();
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error(`PTY "${id}" produced no exit event within 30s`)); }
    }, 30000);
    mgr.setExitHandler((id2, exitCode, info) => {
      if (id2 !== id || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, tail: (info && info.tail) || '' });
    });
    const res = mgr.spawn({ id, cwd: REPO_ROOT, command: 'bug6-unused-bin', shellScript }, null);
    if (!res.ok && !settled) { settled = true; clearTimeout(timer); reject(new Error(`PTY spawn failed: ${res.error}`)); }
  });
}

/** Locate a POSIX shell for the `-lc` route (the real POSIX transport). */
function findPosixShell() {
  const candidates = [
    process.env.SHELL,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    '/bin/bash',
    '/bin/sh'
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (existsSync(c)) return c; } catch { /* keep looking */ }
  }
  return null;
}

function posixRun(shellPath, script) {
  const r = spawnSync(shellPath, ['-lc', script], { encoding: 'utf8', timeout: 30000 });
  if (r.error) throw new Error(`POSIX shell run failed: ${r.error.message}`);
  return { status: r.status, stdout: r.stdout || '' };
}

/** The decision src/main/index.ts:609-620 makes from the exit code — mirrored
 *  verbatim so the repro asserts the CONSUMER-visible outcome, not just a
 *  number: 0 → relaunch + outcome:'agent_launched'; else 'install_failed'. */
function handlerOutcome(exitCode) {
  return exitCode === 0 ? 'agent_launched' : 'install_failed';
}

async function main() {
  const checks = [];
  const observed = [];
  const check = (name, fn) => {
    try { fn(); checks.push({ name, pass: true }); }
    catch (e) { checks.push({ name, pass: false, message: e.message }); }
  };

  // ── The REAL generated scripts (platform is a parameter; every rung below is
  //    one production actually takes) ──────────────────────────────────────────
  const GEMINI_NPM = 'npm install -g @google/gemini-cli';                 // npm rung
  const CLAUDE_NPM = 'npm install -g @anthropic-ai/claude-code';          // npm rung (POSIX arm)
  const CLAUDE_NATIVE_WIN = 'powershell -c irm https://claude.ai/install.ps1 ^| iex'; // native rung

  const npmWin = buildMissingCliScript('gemini', 'gemini', true, 'win32');
  const nativeWin = buildMissingCliScript('claude', 'claude', false, 'win32');
  const npmPosix = buildMissingCliScript('claude', 'claude', true, 'linux');

  assert.ok(npmWin.includes(GEMINI_NPM), 'fixture: win32 npm-rung script embeds the npm install');
  assert.ok(nativeWin.includes(CLAUDE_NATIVE_WIN), 'fixture: win32 native-rung script embeds the native installer');
  assert.ok(npmPosix.split('\n').includes(CLAUDE_NPM), 'fixture: POSIX npm-rung script embeds the npm install');

  // ── ARM 1: win32, npm rung (the most common rung), FAILING install, through
  //    the real PTY the exit handler listens on ────────────────────────────────
  let arm1 = null;
  if (WIN) {
    const { exitCode, tail } = await ptyExit(
      'bug6-win-npm-fail',
      substituteExecuted(npmWin, GEMINI_NPM, FAIL_WIN, 'win32 npm rung')
    );
    arm1 = { exitCode, tail };
    observed.push(`ARM 1 (win32 PTY, npm rung, installer FAILS exit 7): PTY exitCode=${exitCode}; tail ends with: ${JSON.stringify(tail.slice(-120))}`);
    check('ARM 1 win32/npm-rung: a FAILING install must NOT exit the PTY with 0 (index.ts keys the relaunch on exitCode===0)', () => {
      assert.notEqual(exitCode, 0, `the install command exited 7 but the PTY exit handler received exitCode=${exitCode} — the trailing echo statements mask the failure, so the handler fires the relaunch path (agent_install_finished{outcome:'agent_launched'}) for a failed install`);
    });
  }

  // ── ARM 2: win32, native rung (claude's official installer), FAILING install ─
  if (WIN) {
    const { exitCode } = await ptyExit(
      'bug6-win-native-fail',
      substituteExecuted(nativeWin, CLAUDE_NATIVE_WIN, FAIL_WIN, 'win32 native rung')
    );
    observed.push(`ARM 2 (win32 PTY, native rung, installer FAILS exit 7): PTY exitCode=${exitCode}`);
    check('ARM 2 win32/native-rung: a FAILING install must NOT exit the PTY with 0', () => {
      assert.notEqual(exitCode, 0, `the (substituted) installer exited 7 but the PTY exited ${exitCode} — the &-chain's trailing echos mask the errorlevel`);
    });
  }

  // ── ARM 3: POSIX, npm rung, FAILING install, through $SHELL -lc ──────────────
  let arm3 = null;
  const posixShell = findPosixShell();
  if (posixShell) {
    const { status, stdout } = posixRun(posixShell, substituteExecuted(npmPosix, CLAUDE_NPM, FAIL_POSIX, 'posix npm rung'));
    arm3 = { status, stdout };
    observed.push(`ARM 3 ($SHELL -lc, npm rung, installer FAILS exit 7): shell exit status=${status}; failure banner printed=${stdout.includes('[x] Install exited with code 7')}`);
    check('ARM 3 posix/npm-rung: a FAILING install must NOT exit the login shell with 0', () => {
      assert.notEqual(status, 0, `the script itself printed "[x] Install exited with code 7" yet bash -lc exited ${status} — the if/else's status is the last echo's (0), and __clirc is never \`exit\`-ed`);
    });
  }

  // ── CONTROLS: a SUCCEEDING install must still exit 0 (a fix must not flip
  //    the success path — the relaunch legitimately fires there) ───────────────
  if (WIN) {
    const { exitCode } = await ptyExit('bug6-win-npm-ok', substituteExecuted(npmWin, GEMINI_NPM, OK_WIN, 'win32 npm rung (control)'));
    observed.push(`CONTROL 1 (win32 PTY, npm rung, installer SUCCEEDS): PTY exitCode=${exitCode}`);
    check('CONTROL 1 win32/npm-rung: a SUCCEEDING install still exits 0', () => {
      assert.equal(exitCode, 0, `a successful install must keep exiting 0; got ${exitCode}`);
    });
  }
  if (posixShell) {
    const { status } = posixRun(posixShell, substituteExecuted(npmPosix, CLAUDE_NPM, OK_POSIX, 'posix npm rung (control)'));
    observed.push(`CONTROL 2 ($SHELL -lc, npm rung, installer SUCCEEDS): shell exit status=${status}`);
    check('CONTROL 2 posix/npm-rung: a SUCCEEDING install still exits 0', () => {
      assert.equal(status, 0, `a successful install must keep exiting 0; got ${status}`);
    });
  }

  // ── CONSUMER MIRROR: what index.ts:609-620 records for the failing install ──
  const failing = arm1 ?? arm3;
  assert.ok(failing, 'no failing-install arm could run on this machine');
  observed.push(`CONSUMER (index.ts exit handler keyed on exitCode===0): failing install → outcome='${handlerOutcome(failing.exitCode ?? failing.status)}' (relaunch ${handlerOutcome(failing.exitCode ?? failing.status) === 'agent_launched' ? 'FIRES — the still-missing binary is spawned and dies' : 'does not fire'})`);
  check('CONSUMER: the exit handler must record outcome \'install_failed\' — never fire the relaunch — for a failing install', () => {
    assert.equal(handlerOutcome(failing.exitCode ?? failing.status), 'install_failed',
      `a failed install was classified as outcome='agent_launched': the handler broadcast pty:relaunch, tracked agent_install_finished{outcome:'agent_launched'}, and re-ran spawnAgentCore{noAutoInstall:true} which spawns the still-missing CLI that immediately dies`);
  });

  // ── Verdict ──────────────────────────────────────────────────────────────────
  const failed = checks.filter((c) => !c.pass);
  for (const c of checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : `\n      → ${c.message}`}`);
  }
  console.log('');
  console.log('Observed:');
  for (const o of observed) console.log('  ' + o);

  if (failed.length > 0) {
    console.log('');
    console.log(`BUG CONFIRMED — ${failed.length}/${checks.length} checks failed on current main:`);
    for (const c of failed) console.log(`  ✖ ${c.name}\n      ${c.message}`);
    console.log('The install-PTY exit handler (src/main/index.ts:603-621) can never see the');
    console.log('non-zero exit it documents as the install-failed signal: buildMissingCliScript');
    console.log('(src/main/cliInstall.ts) ends every rung in echo statements, so a failed');
    console.log('`npm install -g` exits 0 and the relaunch path fires on failure.');
    return false;
  }
  console.log('');
  console.log('All checks passed — failing installs now propagate a non-zero exit (bug fixed).');
  return true;
}

main().then((ok) => process.exit(ok ? 0 : 1)).catch((e) => {
  console.error('REPRO COULD NOT RUN (infrastructure error, not a bug assertion):', e);
  process.exit(2);
});
