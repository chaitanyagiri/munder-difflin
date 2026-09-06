'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-pi-models-'));
}

async function setupPi(t, { get, id }) {
  const hiveHome = tmpHome();
  const fakeHome = tmpHome();
  t.after(() => fs.rmSync(hiveHome, { recursive: true, force: true }));
  t.after(() => fs.rmSync(fakeHome, { recursive: true, force: true }));

  const realHome = process.env.HOME;
  const realProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
  });
  assert.equal(os.homedir(), fakeHome, 'home redirect failed — aborting before touching the real home');

  if (get) {
    const dir = path.join(fakeHome, '.pi', 'agent');
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, data] of Object.entries(get)) {
      fs.writeFileSync(path.join(dir, file), JSON.stringify(data), 'utf8');
    }
  }

  const hive = new HiveManager(() => hiveHome);
  const injection = await hive.ensureAgent({ id, name: 'Pi Agent', provider: 'pi', cwd: hiveHome });
  return injection.env.PI_CODING_AGENT_DIR;
}

function assertFiles(piAgentDir, want) {
  for (const [file, w] of Object.entries(want)) {
    const p = path.join(piAgentDir, file);
    assert.equal(fs.existsSync(p), w.exists, `${file} ${w.exists ? 'should exist' : 'should not be created'}`);
    if (w.exists) assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), w.data, `${file} content should match source`);
  }
}

test('installPiHooks copies models.json from ~/.pi/agent when it exists', async (t) => {
  const get = {
    'models.json': { default: 'anthropic/claude-sonnet-4-5', custom: { 'openai/gpt-4o': {} } },
    'models-store.json': { version: 2, models: [{ id: 'm1', name: 'test' }] },
  };
  const want = {
    'models.json': { exists: true, data: get['models.json'] },
    'models-store.json': { exists: true, data: get['models-store.json'] },
  };

  const piAgentDir = await setupPi(t, { get, id: 'pi-1' });
  assert.ok(piAgentDir, 'PI_CODING_AGENT_DIR should be set');
  assertFiles(piAgentDir, want);
});

test('installPiHooks does not create models files when source is missing (lets Pi fall back to its defaults)', async (t) => {
  const get = null;
  // absent means "no user override" — must not write {} which Pi reads as "zero models"
  const want = {
    'models.json': { exists: false },
    'models-store.json': { exists: false },
  };

  const piAgentDir = await setupPi(t, { get, id: 'pi-2' });
  assert.ok(piAgentDir, 'PI_CODING_AGENT_DIR should be set');
  assertFiles(piAgentDir, want);
});

test('installPiHooks copies models.json but skips missing models-store.json', async (t) => {
  const get = { 'models.json': { default: 'openai/gpt-4o' } };
  const want = {
    'models.json': { exists: true, data: get['models.json'] },
    'models-store.json': { exists: false },
  };

  const piAgentDir = await setupPi(t, { get, id: 'pi-3' });
  assert.ok(piAgentDir, 'PI_CODING_AGENT_DIR should be set');
  assertFiles(piAgentDir, want);
});
