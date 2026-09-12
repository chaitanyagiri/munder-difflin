'use strict';
/**
 * Upstream issue #447: closing an agent's tab RETAINS it ("Retained + flagged,
 * NOT deleted"), but the archived row's only button was ✕ permanent-delete — so
 * the retained record had no way back onto the floor. Reopen now shares ONE
 * respawn recipe with "Restore team" rather than growing a second one, and this
 * pins that recipe down: the original agent id, the isolated worktree when it is
 * still on disk (the base repo when it is not), and the prior CLI session
 * resumed — which is what makes memory.md, the inbox and the registry entry
 * reattach by id.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { respawnAgent } = loadTs('src/renderer/src/hooks/respawnAgent.ts');

const AGENT = { id: 'jim-1', name: 'Jim', cwd: '/repo', description: 'sales engineer' };
const RECIPE = { provider: 'claude', exe: 'claude', args: ['--model', 'sonnet'] };

/** Deps that record what was asked of the main process. */
function deps({ isRepo = true, result = { ok: true } } = {}) {
  const calls = { gitIsRepo: [], spawnPty: [] };
  return {
    calls,
    gitIsRepo: async (p) => { calls.gitIsRepo.push(p); return isRepo; },
    spawnPty: async (opts) => { calls.spawnPty.push(opts); return typeof result === 'function' ? result(opts) : result; }
  };
}

test('respawns under the agent\'s OWN id, resuming its prior session', async () => {
  const d = deps();
  const res = await respawnAgent(AGENT, RECIPE, d);
  assert.equal(res.outcome, 'respawned', JSON.stringify(res));
  assert.equal(res.ptyId, 'pty-jim-1', 'an archived agent has no ptyId — it is derived from the id');
  assert.equal(d.calls.spawnPty.length, 1);
  const opts = d.calls.spawnPty[0];
  assert.equal(opts.id, 'pty-jim-1');
  assert.equal(opts.cwd, '/repo');
  assert.equal(opts.command, 'claude');
  assert.deepEqual(opts.args, ['--model', 'sonnet']);
  assert.equal(opts.resume, true, 'reopening continues the conversation, it does not start a blank one');
  assert.equal(opts.isolate, false, 'never re-isolate: git worktree add would conflict on the existing branch');
  // The hive meta is what reattaches memory.md / inbox / registry by id.
  assert.equal(opts.hive.id, 'jim-1');
  assert.equal(opts.hive.cwd, '/repo');
  assert.equal(opts.hive.role, 'sales engineer', 'the durable hire role survives the respawn');
});

test('re-enters the isolated worktree while it is still on disk', async () => {
  const d = deps({ isRepo: true });
  const res = await respawnAgent({ ...AGENT, worktreePath: '/wt/jim-1' }, RECIPE, d);
  assert.equal(res.outcome, 'respawned');
  assert.equal(res.worktreeGone, false);
  assert.equal(res.cwd, '/wt/jim-1');
  assert.deepEqual(d.calls.gitIsRepo, ['/wt/jim-1'], 'the worktree is probed, not assumed');
  assert.equal(d.calls.spawnPty[0].cwd, '/wt/jim-1', 'uncommitted work in the worktree is not stranded');
});

test('falls back to the base repo when the worktree has been pruned', async () => {
  const d = deps({ isRepo: false });
  const res = await respawnAgent({ ...AGENT, worktreePath: '/wt/gone' }, RECIPE, d);
  assert.equal(res.outcome, 'respawned');
  assert.equal(res.worktreeGone, true, 'the caller needs this to drop the dead path and say so on the card');
  assert.equal(res.cwd, '/repo');
  assert.equal(d.calls.spawnPty[0].cwd, '/repo', 'never spawn into a dead path');
});

test('an id whose terminal is already running is not a failure', async () => {
  const d = deps({ result: { ok: false, error: 'pty with id pty-jim-1 already exists' } });
  const res = await respawnAgent(AGENT, RECIPE, d);
  assert.deepEqual(res, { outcome: 'already-live' });
});

test('an entry with no saved command is reported, and nothing is spawned', async () => {
  const d = deps();
  const res = await respawnAgent(AGENT, { provider: 'claude', exe: '', args: [] }, d);
  assert.deepEqual(res, { outcome: 'failed', error: 'no saved command' });
  assert.equal(d.calls.spawnPty.length, 0);
});

test('a spawn failure comes back as a reason, and a throw never escapes', async () => {
  const failed = await respawnAgent(AGENT, RECIPE, deps({ result: { ok: false, error: 'ENOENT: claude' } }));
  assert.deepEqual(failed, { outcome: 'failed', error: 'ENOENT: claude' });

  const threw = await respawnAgent(AGENT, RECIPE, {
    gitIsRepo: async () => true,
    spawnPty: async () => { throw new Error('IPC channel closed'); }
  });
  assert.deepEqual(threw, { outcome: 'failed', error: 'IPC channel closed' },
    'one bad agent must never abort a Restore-team loop over several');
});

test('the seed prompt from a bare-spawning CLI is handed back to the caller', async () => {
  const d = deps({ result: { ok: true, seedPrompt: 'read your inbox' } });
  const res = await respawnAgent(AGENT, { ...RECIPE, provider: 'crush' }, d);
  assert.equal(res.outcome, 'respawned');
  assert.equal(res.seedPrompt, 'read your inbox');
  assert.equal(d.calls.spawnPty[0].provider, 'crush');
});
