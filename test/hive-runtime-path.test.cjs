'use strict';

/**
 * Layer 1 fixed the commands WE generate (every hook shim runs through
 * `hive-node`). It did nothing for node the agent's own work needs: an MCP server
 * declared as `node ./server.js`, a provider CLI that shells out to node, a helper
 * an agent wrote itself. With no system node those die with 127 — same bug, one
 * level down.
 *
 * `<hive>/bin/runtime/` holds a shim literally NAMED `node`, APPENDED to the
 * agent's PATH. Appended, not prepended: a user with their own node keeps their
 * own version, and we are strictly the fallback.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { withHiveRuntimeFallback } = loadTs('src/main/pty.ts');

const POSIX = process.platform !== 'win32';
const STRIPPED_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const SEP = path.delimiter;

async function hiveIn(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-runtime-'));
  const hive = new HiveManager(() => home);
  t.after(async () => {
    await hive.flushCommits();
    fs.rmSync(home, { recursive: true, force: true });
  });
  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });
  return { home, hive, root: path.join(home, 'hive') };
}

test('bootstrap materializes a PATH-visible `node`', async (t) => {
  const { hive, root } = await hiveIn(t);

  const dir = hive.runtimeBinDir();
  assert.equal(dir, path.join(root, 'bin', 'runtime'));
  const shim = path.join(dir, POSIX ? 'node' : 'node.cmd');
  assert.equal(fs.existsSync(shim), true, 'nothing resolves `node` here without it');

  const body = fs.readFileSync(shim, 'utf8');
  assert.match(body, /ELECTRON_RUN_AS_NODE=1/, 'without this the binary opens a second app window');
  assert.ok(body.includes(process.execPath), 'execPath is re-baked each bootstrap so an app move/update heals');
  if (POSIX) assert.ok(fs.statSync(shim).mode & 0o111, 'must be executable');
});

test('npm and npx are deliberately NOT shimmed', async (t) => {
  const { hive } = await hiveIn(t);
  // Electron bundles the Node runtime, not the npm CLI. A stub named `npm` would
  // make `npm install` fail confusingly instead of being honestly absent — which
  // is what the missing-CLI ladder (cli-install-ladder.test.cjs) detects.
  const present = fs.readdirSync(hive.runtimeBinDir());
  assert.deepEqual(present.filter((f) => /^(npm|npx)(\.cmd)?$/.test(f)), []);
});

test('the runtime dir is APPENDED — the user\'s own node still wins', async (t) => {
  const { root } = await hiveIn(t);
  const dir = path.join(root, 'bin', 'runtime');

  const out = withHiveRuntimeFallback(`/usr/local/bin${SEP}/usr/bin`, root);
  assert.equal(out, `/usr/local/bin${SEP}/usr/bin${SEP}${dir}`);
  assert.ok(out.indexOf('/usr/local/bin') < out.indexOf(dir),
    'prepending would silently swap the node version under the user\'s own projects');

  assert.equal(withHiveRuntimeFallback(out, root), out, 'a respawn must not keep appending');
});

test('no hive root, or no runtime dir, leaves PATH exactly as it was', async (t) => {
  const original = `/usr/local/bin${SEP}/usr/bin`;
  assert.equal(withHiveRuntimeFallback(original, undefined), original, 'plain terminals are untouched');

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'md-runtime-none-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  assert.equal(withHiveRuntimeFallback(original, empty), original,
    'a pre-fix hive that never wrote the dir must degrade, not point PATH at nothing');
});

test('`node` resolves and RUNS with no node on PATH — the whole point', { skip: !POSIX }, async (t) => {
  const { root } = await hiveIn(t);

  const bare = { PATH: STRIPPED_PATH };
  const probe = spawnSync('/bin/sh', ['-c', 'command -v node'], { env: bare, encoding: 'utf8' });
  if (probe.status === 0) {
    // An image with /usr/bin/node — the control is meaningless, but the fallback
    // assertion below still must hold.
    t.diagnostic(`node already on the stripped PATH at ${probe.stdout.trim()}`);
  } else {
    const before = spawnSync('/bin/sh', ['-c', 'node -e "process.exit(0)"'], { env: bare, encoding: 'utf8' });
    assert.equal(before.status, 127, 'the bug: an agent-spawned `node` is not resolvable');
  }

  const env = { PATH: withHiveRuntimeFallback(STRIPPED_PATH, root) };
  const after = spawnSync('/bin/sh', ['-c', 'node -p "1+1"'], { env, encoding: 'utf8' });
  assert.equal(after.status, 0, `node still unresolvable: ${after.stderr}`);
  assert.equal(after.stdout.trim(), '2', 'it must be a real Node, not just an executable file');
});
