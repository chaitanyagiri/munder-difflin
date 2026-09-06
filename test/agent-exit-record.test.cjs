'use strict';

/**
 * An agent killed by its provider crashing used to leave NO durable cause.
 *
 * Observed live on 2026-08-24: a `claude` CLI panicked 923 ms into startup
 * (Bun, SIGILL) and the hive recorded exactly
 *   {"kind":"archive","agentId":"god","archived":true}
 * — no exit code, no signal, no output. The crash banner existed only in a UI
 * terminal pane. A two-second death and a completed agent were indistinguishable
 * in the only record the hive keeps.
 *
 * `recordAgentExit` fixes that. These tests pin the three properties that make
 * it useful and safe:
 *   1. a signal-death is recorded even though its exit code is 0;
 *   2. a CLEAN exit records nothing (a diagnostic, not an audit log);
 *   3. the raw output goes to a GITIGNORED file, never into log.jsonl —
 *      the hive repo is committed on every change, so a token captured from
 *      provider output would otherwise be permanent.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-exit-'));
}

function readLog(home) {
  const p = path.join(home, 'hive', 'log.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function freshHive(t) {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });
  return { home, hive };
}

test('a signal death is recorded even though its exit code is 0', async (t) => {
  const { home, hive } = await freshHive(t);

  // SIGILL is exactly the shape that bit us: node-pty reports exitCode 0 and a
  // non-zero signal, so an exitCode-only check calls this a clean finish.
  hive.recordAgentExit('a1', { exitCode: 0, signal: 4, tail: 'panic: Illegal instruction\n' });

  const rows = readLog(home).filter((r) => r.kind === 'agent-exit');
  assert.equal(rows.length, 1, 'a signal death must be recorded');
  assert.equal(rows[0].agentId, 'a1');
  assert.equal(rows[0].signal, 4);
  assert.equal(rows[0].exitCode, 0);
  assert.equal(rows[0].abnormal, true);
});

test('a non-zero exit code is recorded', async (t) => {
  const { home, hive } = await freshHive(t);
  hive.recordAgentExit('a1', { exitCode: 127, tail: 'claude: command not found\n' });

  const rows = readLog(home).filter((r) => r.kind === 'agent-exit');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].exitCode, 127);
  assert.equal(rows[0].signal, null);
});

test('a CLEAN exit records nothing — this is a diagnostic, not an audit log', async (t) => {
  const { home, hive } = await freshHive(t);

  hive.recordAgentExit('a1', { exitCode: 0, signal: 0, tail: 'goodbye\n' });
  hive.recordAgentExit('a1', { exitCode: 0, tail: 'goodbye\n' });
  hive.recordAgentExit('a1', {});

  assert.equal(readLog(home).filter((r) => r.kind === 'agent-exit').length, 0);
});

test('raw output goes to a gitignored crashes/ file, NOT into log.jsonl', async (t) => {
  const { home, hive } = await freshHive(t);

  // A plausible secret in provider output. It must reach the dump file and must
  // NOT reach log.jsonl, which the hive commits.
  const secret = 'sk-ant-EXAMPLE-NOT-A-REAL-KEY-000';
  hive.recordAgentExit('a1', { exitCode: 0, signal: 11, tail: `boom ${secret}\n`, command: '/usr/bin/claude --model x' });

  const rows = readLog(home).filter((r) => r.kind === 'agent-exit');
  assert.equal(rows.length, 1);

  const raw = fs.readFileSync(path.join(home, 'hive', 'log.jsonl'), 'utf8');
  assert.ok(!raw.includes(secret), 'log.jsonl must never carry raw provider output');

  const tailPath = rows[0].tailPath;
  assert.ok(tailPath, 'the row must point at the dump');
  const dump = fs.readFileSync(tailPath, 'utf8');
  assert.ok(dump.includes(secret), 'the dump keeps the output that explains the death');
  assert.ok(dump.includes('signal:   11'), 'the dump carries a header naming the signal');
  assert.ok(dump.includes('/usr/bin/claude --model x'), 'and the command that died');

  // The dump must live under crashes/, which ensureHive gitignores.
  assert.equal(path.basename(path.dirname(tailPath)), 'crashes');
  const ignore = fs.readFileSync(path.join(home, 'hive', '.gitignore'), 'utf8');
  assert.ok(ignore.split('\n').includes('crashes/'), 'crashes/ must be gitignored');
});

test('a death is still recorded when there is no output to dump', async (t) => {
  const { home, hive } = await freshHive(t);
  hive.recordAgentExit('a1', { exitCode: 0, signal: 9, tail: '' });

  const rows = readLog(home).filter((r) => r.kind === 'agent-exit');
  assert.equal(rows.length, 1, 'losing the output must not lose the fact of the death');
  assert.equal(rows[0].signal, 9);
  assert.equal(rows[0].tailPath, null);
});
