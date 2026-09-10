'use strict';

/**
 * `lumberroom search "--help" --limit N` (verified against the real 0.3.1
 * binary) exits 0 and prints the CLI's own top-level usage/version text
 * instead of running a search — a caller reading only the exit code would
 * report a SUCCESSFUL search whose "result" is a usage dump. `--` as a
 * positional separator does not rescue it: lumberroom scans the whole argv
 * for "--help"/"--version" before subcommand parsing starts. No argv form
 * fixes this, so MemoryManager.search() must reject these queries itself,
 * before ever spawning the CLI.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { MemoryManager } = loadTs('src/main/memory.ts');
const { isUnsafeQuery } = loadTs('src/main/memoryProviders.ts');

test('isUnsafeQuery flags exactly the two tokens verified to short-circuit lumberroom, nothing else', () => {
  assert.equal(isUnsafeQuery('--help'), true);
  assert.equal(isUnsafeQuery('--version'), true);
  assert.equal(isUnsafeQuery('-h'), false, 'confirmed to run as a literal query against the real CLI');
  assert.equal(isUnsafeQuery('-v'), false, 'confirmed to run as a literal query against the real CLI');
  assert.equal(isUnsafeQuery('--foo'), false, 'confirmed to fail loudly (exit 1) — already handled correctly');
  assert.equal(isUnsafeQuery('--help me deploy'), false, 'not an exact match — a real query that happens to contain the word');
  assert.equal(isUnsafeQuery('normal query'), false);
});

function managerWithMarkerCli(t, { queryTriggersUsageDump }) {
  // A stand-in for the real bug: whatever argv it's given, if it CONTAINS
  // the literal token "--help" or "--version" anywhere, it behaves like the
  // real binary — exits 0 with a "usage" line rather than a real result —
  // and touches a marker file so the test can prove whether it ran at all.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-cli-'));
  const bin = path.join(dir, 'lumberroom');
  const marker = path.join(dir, 'ran');
  fs.writeFileSync(bin, `#!/bin/sh
touch "${marker}"
for a in "$@"; do
  if [ "$a" = "--help" ] || [ "$a" = "--version" ]; then
    echo "usage: lumberroom <command> [options]"
    exit 0
  fi
done
echo "0.9  [ns] a real search result"
exit 0
`, { mode: 0o755 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { bin, marker };
}

function manager(t, bin) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-memory-'));
  const memory = new MemoryManager(() => home, () => ({ enabled: true, model: 'minilm', provider: 'lumberroom' }));
  memory.bin = () => bin;
  memory.authenticated = () => true; // bypass the auth gate — not what this test is about
  t.after(() => { memory.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  return memory;
}

test('search("--help") is rejected before the CLI is ever spawned', async (t) => {
  const { bin, marker } = managerWithMarkerCli(t, {});
  const memory = manager(t, bin);

  const result = await memory.search('--help');

  assert.equal(result.ok, false);
  assert.match(result.error, /--help/);
  assert.equal(fs.existsSync(marker), false, 'the CLI must never have been spawned at all');
});

test('search("--version") is rejected the same way', async (t) => {
  const { bin, marker } = managerWithMarkerCli(t, {});
  const memory = manager(t, bin);

  const result = await memory.search('--version');

  assert.equal(result.ok, false);
  assert.equal(fs.existsSync(marker), false);
});

test('a normal query still runs — the guard is narrow, not a broad ban on "-"-prefixed text', async (t) => {
  const { bin, marker } = managerWithMarkerCli(t, {});
  const memory = manager(t, bin);

  const result = await memory.search('-x is not banned, only exact --help/--version are');

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(marker), true);
});

// Runs only when the real CLI is present — the true regression guard.
const hasRealLumberroom = spawnSync('which', ['lumberroom'], { encoding: 'utf8' }).status === 0;
test('regression: the real lumberroom binary silently "succeeds" on --help (documents the bug this guards against)', { skip: !hasRealLumberroom }, () => {
  const res = spawnSync('lumberroom', ['search', '--help', '--limit', '3'], { encoding: 'utf8' });
  assert.equal(res.status, 0, 'the CLI itself exits 0 — this is exactly why our own guard has to catch it first');
  assert.match(res.stdout, /usage: lumberroom/);
});
