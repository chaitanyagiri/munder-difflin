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

test('installPiHooks copies models.json from ~/.pi/agent when it exists', async (t) => {
  const hiveHome = tmpHome();
  t.after(() => fs.rmSync(hiveHome, { recursive: true, force: true }));

  const fakeHome = tmpHome();
  t.after(() => fs.rmSync(fakeHome, { recursive: true, force: true }));

  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  t.after(() => { if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome; });

  const userPiAgentDir = path.join(fakeHome, '.pi', 'agent');
  fs.mkdirSync(userPiAgentDir, { recursive: true });
  const modelsData = { default: 'anthropic/claude-sonnet-4-5', custom: { 'openai/gpt-4o': {} } };
  fs.writeFileSync(path.join(userPiAgentDir, 'models.json'), JSON.stringify(modelsData), 'utf8');
  const storeData = { version: 2, models: [{ id: 'm1', name: 'test' }] };
  fs.writeFileSync(path.join(userPiAgentDir, 'models-store.json'), JSON.stringify(storeData), 'utf8');

  const hive = new HiveManager(() => hiveHome);
  const injection = await hive.ensureAgent({
    id: 'pi-1',
    name: 'Pi Agent',
    provider: 'pi',
    cwd: hiveHome
  });

  const piAgentDir = injection.env.PI_CODING_AGENT_DIR;
  assert.ok(piAgentDir, 'PI_CODING_AGENT_DIR should be set');
  assert.equal(fs.existsSync(path.join(piAgentDir, 'models.json')), true, 'models.json should exist');
  assert.equal(fs.existsSync(path.join(piAgentDir, 'models-store.json')), true, 'models-store.json should exist');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(piAgentDir, 'models.json'), 'utf8')),
    modelsData,
    'models.json content should match source'
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(piAgentDir, 'models-store.json'), 'utf8')),
    storeData,
    'models-store.json content should match source'
  );
});

test('installPiHooks writes empty {} when ~/.pi/agent models files do not exist', async (t) => {
  const hiveHome = tmpHome();
  t.after(() => fs.rmSync(hiveHome, { recursive: true, force: true }));

  const fakeHome = tmpHome();
  t.after(() => fs.rmSync(fakeHome, { recursive: true, force: true }));

  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  t.after(() => { if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome; });

  const hive = new HiveManager(() => hiveHome);
  const injection = await hive.ensureAgent({
    id: 'pi-2',
    name: 'Pi Agent',
    provider: 'pi',
    cwd: hiveHome
  });

  const piAgentDir = injection.env.PI_CODING_AGENT_DIR;
  assert.ok(piAgentDir, 'PI_CODING_AGENT_DIR should be set');
  assert.equal(fs.existsSync(path.join(piAgentDir, 'models.json')), true, 'models.json should exist even when source is missing');
  assert.equal(fs.existsSync(path.join(piAgentDir, 'models-store.json')), true, 'models-store.json should exist even when source is missing');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(piAgentDir, 'models.json'), 'utf8')),
    {},
    'models.json should default to empty object'
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(piAgentDir, 'models-store.json'), 'utf8')),
    {},
    'models-store.json should default to empty object'
  );
});

test('installPiHooks copies models.json even when models-store.json is missing', async (t) => {
  const hiveHome = tmpHome();
  t.after(() => fs.rmSync(hiveHome, { recursive: true, force: true }));

  const fakeHome = tmpHome();
  t.after(() => fs.rmSync(fakeHome, { recursive: true, force: true }));

  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  t.after(() => { if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome; });

  const userPiAgentDir = path.join(fakeHome, '.pi', 'agent');
  fs.mkdirSync(userPiAgentDir, { recursive: true });
  const modelsData = { default: 'openai/gpt-4o' };
  fs.writeFileSync(path.join(userPiAgentDir, 'models.json'), JSON.stringify(modelsData), 'utf8');

  const hive = new HiveManager(() => hiveHome);
  const injection = await hive.ensureAgent({
    id: 'pi-3',
    name: 'Pi Agent',
    provider: 'pi',
    cwd: hiveHome
  });

  const piAgentDir = injection.env.PI_CODING_AGENT_DIR;
  assert.ok(piAgentDir, 'PI_CODING_AGENT_DIR should be set');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(piAgentDir, 'models.json'), 'utf8')),
    modelsData,
    'models.json should be copied from source'
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(piAgentDir, 'models-store.json'), 'utf8')),
    {},
    'models-store.json should default to empty object when source is missing'
  );
});
