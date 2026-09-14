'use strict';

/**
 * AEON-1523 re-verification: found live, not theorized, while stress-testing
 * the AEON-1510 async conversion against the real 0.5.3 base — a real `git
 * commit -q` can report "nothing added to commit but untracked files
 * present" (distinct from "nothing to commit") when a file written between
 * `git add -A` and `git commit` running wasn't staged. `doCommit`'s retry
 * loop used to only treat that as "gave up" (a spurious warning, since there
 * genuinely IS something to commit, unlike the true "nothing to commit"
 * case) rather than retrying — and this exact gap pre-dates AEON-1510: it's
 * present in the synchronous 0.5.3 `commit()` too, just apparently never hit
 * during that code's own verification.
 *
 * Deterministic via `gitBin` override (same pattern as hive-git-timeout.test
 * .cjs): a fake git script that answers "nothing added to commit..." to the
 * FIRST `commit` invocation only, then behaves like a normal (real) git
 * commit from the second attempt on — proving the retry loop recovers
 * without ever printing "[hive] commit gave up".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

/** Wraps the real `git` binary but makes the FIRST `commit` invocation
 *  report the "nothing added..." race instead of actually committing —
 *  every other invocation (including later `commit` calls, and every `add`/
 *  `init`/etc.) passes straight through to the real git. */
function writeFlakyGit(dir) {
  const marker = path.join(dir, 'commit-attempts.txt');
  fs.writeFileSync(marker, '0', 'utf8');
  const script = path.join(dir, 'flaky-git.js');
  fs.writeFileSync(script, `#!${process.execPath}
const fs = require('fs');
const { spawnSync } = require('child_process');
const marker = ${JSON.stringify(marker)};
const args = process.argv.slice(2);
if (args.includes('commit')) {
  const n = Number(fs.readFileSync(marker, 'utf8'));
  fs.writeFileSync(marker, String(n + 1));
  if (n === 0) {
    process.stdout.write(
      'On branch main\\nUntracked files:\\n  (use "git add <file>..." to include in what will be committed)\\n\\tsome-file\\n\\nnothing added to commit but untracked files present (use "git add" to track)\\n'
    );
    process.exit(1);
  }
}
const r = spawnSync('git', args, { cwd: process.cwd(), stdio: 'inherit' });
process.exit(r.status ?? 1);
`, 'utf8');
  fs.chmodSync(script, 0o755);
  return { script, marker };
}

test('doCommit retries (not "gave up") on a real "nothing added to commit" race, and eventually lands', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-commit-retry-'));
  t.after(async () => { await hive.flushGit(); fs.rmSync(home, { recursive: true, force: true }); });

  const hive = new HiveManager(() => home);
  const { script, marker } = writeFlakyGit(home);
  hive.gitBin = script;

  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    hive.ensureHive(); // queues the init commit, which hits the flaky first-attempt path
    await hive.flushGit();
  } finally {
    console.warn = realWarn;
  }

  const root = path.join(home, 'hive');
  const log = spawnSync('git', ['log', '--format=%s'], { cwd: root, encoding: 'utf8' });
  assert.equal(log.stdout.trim(), 'hive: init', 'the commit must have actually landed after retrying');
  assert.ok(Number(fs.readFileSync(marker, 'utf8')) >= 2, 'the flaky script must have been hit at least twice (fail then succeed)');
  assert.ok(
    !warnings.some((w) => w.includes('commit gave up')),
    `must retry through the race silently, not warn: ${JSON.stringify(warnings)}`
  );
});
