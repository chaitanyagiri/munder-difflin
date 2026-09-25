'use strict';
// Relocating an existing agent must preserve its durable identity while repairing
// both its registry cwd and its spawn payload.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'md-agent-cwd-'));

test('setAgentCwd repairs the registry cwd and refreshes identity.md', async () => {
  const home = tmpHome();
  const oldProject = path.join(home, 'old-project');
  const newProject = path.join(home, 'new-project');
  fs.mkdirSync(oldProject, { recursive: true });
  fs.mkdirSync(newProject, { recursive: true });
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: oldProject });

  const identityPath = path.join(home, 'hive', 'agents', 'jim-1', 'identity.md');
  assert.ok(fs.readFileSync(identityPath, 'utf8').includes(oldProject));

  const result = hive.setAgentCwd('jim-1', newProject);
  assert.equal(result.ok, true);
  assert.equal(result.cwd, newProject);

  const registry = hive.registry();
  assert.equal(registry.agents['jim-1'].cwd, newProject);
  assert.equal(registry.agents['jim-1'].cwdValid, true);
  assert.ok(fs.readFileSync(identityPath, 'utf8').includes(newProject));
  assert.ok(!fs.readFileSync(identityPath, 'utf8').includes(oldProject));
});

test('setAgentCwd rejects missing folders without rewriting the registry', async () => {
  const home = tmpHome();
  const project = path.join(home, 'project');
  fs.mkdirSync(project, { recursive: true });
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: project });

  const missing = path.join(home, 'gone');
  const result = hive.setAgentCwd('jim-1', missing);
  assert.equal(result.ok, false);
  assert.equal(hive.registry().agents['jim-1'].cwd, project);
  assert.equal(hive.registry().agents['jim-1'].cwdValid, true);
});

test('the edit dialog exposes a pick-folder repair action backed by setAgentCwd', () => {
  const modal = fs.readFileSync(path.resolve(__dirname, '..', 'src/renderer/src/components/EditAgentModal.tsx'), 'utf8');
  assert.match(modal, /Row label="Project folder"/);
  assert.match(modal, /pickProjectFolder/);
  assert.match(modal, /setAgentCwd\(agent\.id, cwd\)/);
});
