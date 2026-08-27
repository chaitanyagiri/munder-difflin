'use strict';

/**
 * Engine command-name validation.
 *
 * The engine `command` on a spawn request is untrusted input (orchestrator LLM
 * output, or anything that can write HIVE_ROOT/spawn-requests). Its first token
 * becomes the executable NAME, and a resolver may interpolate that name into a
 * shell PATH lookup (`$SHELL -ilc "… which <it> …"` on POSIX, `where <it>` on
 * Windows). So only a PLAIN command name is resolved; anything else is refused.
 *
 * The predicate is `isSafeCommandName`, applied at three sites:
 *   1. resolveCommand (shellEnv.ts) — refuses to hand a non-plain name to which;
 *   2. resolveCommandUncached (pty.ts) — the same, and drops shell:true on `where`;
 *   3. the spawn-request intake (index.ts) — refuses a bin that is neither a plain
 *      name nor an absolute path, before any resolution.
 *
 * These tests pin the predicate AND that each of the three sites actually calls
 * it — a predicate that is correct but never invoked would leave the boundary
 * open while every unit test stayed green.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { isSafeCommandName } = loadTs('src/main/shellEnv.ts');
const { buildWorkerLaunch } = loadTs('src/main/workerLaunch.ts');

test('legit engine binary names are accepted', () => {
  for (const name of ['claude', 'codex', 'grok', 'kimi', 'agy', 'qwen', 'opencode',
                       'crush', 'pi', 'copilot', 'cursor-agent', 'node', 'npm', 'node.js', 'a_b+c']) {
    assert.equal(isSafeCommandName(name), true, `${name} should be safe`);
  }
});

test('a name carrying any character outside a plain command name is rejected', () => {
  // Only [A-Za-z0-9._+-] is a command name. Every one of these carries something
  // a shell would treat as more than a name (a separator, a pipe, a redirect,
  // substitution, or whitespace introducing a second word), so none resolves.
  for (const bad of [
    'claude;rest',
    'claude&&rest',
    'claude|rest',
    'x`rest`',
    '$(rest)',
    'claude>rest',
    'claude rest',
    'claude\trest',
    'claude$IFS',
    'a&b',
    '',
  ]) {
    assert.equal(isSafeCommandName(bad), false, `${JSON.stringify(bad)} must be rejected`);
  }
});

test('a path is NOT a plain command name (the resolver early-returns paths before this)', () => {
  assert.equal(isSafeCommandName('/usr/bin/claude'), false);
  assert.equal(isSafeCommandName('./claude'), false);
  assert.equal(isSafeCommandName('a\\b'), false);
});

test('the tokenizer still yields a non-plain bin, so the allowlist is load-bearing', () => {
  // buildWorkerLaunch is pure tokenization; it does NOT validate. The guard at the
  // spawn-request call site (index.ts) is what rejects a non-plain bin. If this
  // ever changes so bin comes back constrained, revisit whether the call-site
  // guard is still needed — but do not remove it on the strength of the tokenizer.
  const l = buildWorkerLaunch({ requestCommand: 'claude;rest', autoMode: false });
  assert.equal(l.bin, 'claude;rest');
  assert.equal(isSafeCommandName(l.bin), false);
});

// ── each of the three sites actually calls the predicate ─────────────────────
// A predicate that passes every unit test still leaves the boundary open if a
// site forgets to call it. The three sites are the two resolvers (shellEnv.ts and
// pty.ts) and the spawn-request intake (index.ts). Two of those import electron
// and cannot load under plain node, so their wiring is asserted against source
// text — the pattern the rest of this suite uses for main-process wiring. The
// resolver that CAN load is checked behaviourally.

const fs = require('node:fs');
const path = require('node:path');
const { resolveCommand } = loadTs('src/main/shellEnv.ts');
const readSrc = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

test('resolveCommand returns a non-plain name unchanged — it never reaches the shell lookup', () => {
  // A bare name (no `/` or `\`) that is not a plain command name must come straight
  // back, BEFORE any `captureFromLoginShell(\`which …\`)`. Equality means the shell
  // interpolation was never reached — a resolved binary would be an absolute path.
  // Proven behaviourally too: the name below, were it ever interpolated into the
  // login-shell lookup, would create a marker file; a plain path (with a `/`) is
  // avoided so resolveCommand does not early-return before the guard. Clean before
  // and after so the check is hermetic and cannot leave a file in the repo.
  const probe = path.resolve(process.cwd(), 'md_wiring_probe');
  try { fs.rmSync(probe, { force: true }); } catch { /* nothing to clean */ }
  const nonPlain = 'claude;touch md_wiring_probe';
  try {
    assert.equal(resolveCommand(nonPlain), nonPlain);
    assert.equal(fs.existsSync(probe), false, 'the name reached a shell — the guard did not hold');
  } finally {
    try { fs.rmSync(probe, { force: true }); } catch { /* best effort */ }
  }
});

test('pty.ts resolver validates before which/where', () => {
  const src = readSrc('src/main/pty.ts');
  // The guard must sit in resolveCommandUncached and precede the spawnSync('where')
  // and the captureFromLoginShell(`which …`) calls, and `where` must not run under
  // a shell (which would re-parse the argument).
  assert.match(src, /if \(!isSafeCommandName\(command\)\) return \{ path: command, found: false \};/);
  assert.doesNotMatch(src, /spawnSync\('where', \[command\], \{ encoding: 'utf8', timeout: 3000, shell: true \}\)/);
  const guardAt = src.indexOf('if (!isSafeCommandName(command)) return { path: command, found: false };');
  const whichAt = src.indexOf('captureFromLoginShell(`which ${command}`)');
  assert.ok(guardAt > 0 && whichAt > guardAt, 'the guard must precede the `which` interpolation');
});

test('index.ts validates the bin at the spawn-request intake', () => {
  const src = readSrc('src/main/index.ts');
  // The spawn path rejects a bin that is neither a plain name nor an absolute path,
  // and it does so BEFORE isCommandAvailable(bin) (which itself calls the resolver).
  assert.match(src, /if \(!isSafeCommandName\(bin\) && !isAbsolute\(bin\)\) \{/);
  const guardAt = src.indexOf('if (!isSafeCommandName(bin) && !isAbsolute(bin)) {');
  const availAt = src.indexOf('if (!ptyManager.isCommandAvailable(bin))');
  assert.ok(guardAt > 0 && availAt > guardAt, 'the guard must precede isCommandAvailable(bin)');
});
