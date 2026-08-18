'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-hierarchy-'));
}

function promptFrom(injection) {
  const index = injection.args.indexOf('--append-system-prompt');
  return index >= 0 ? injection.args[index + 1] : '';
}

test('advisory hierarchy persists and directs routine work through the supervisor', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);

  await hive.ensureAgent({ id: 'holt', name: 'Holt', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'terry', name: 'Terry', provider: 'claude', cwd: home, reportsTo: 'holt' });
  const jake = await hive.ensureAgent({ id: 'jake', name: 'Jake', provider: 'claude', cwd: home, reportsTo: 'terry' });

  assert.equal(hive.registry().agents.jake.reportsTo, 'terry');
  assert.match(fs.readFileSync(path.join(home, 'hive', 'agents', 'jake', 'identity.md'), 'utf8'), /Reports to: Terry \(terry\)/);
  assert.match(promptFrom(jake), /advisory supervisor is terry/i);
  assert.match(promptFrom(jake), /critical\/human.*directly to "god"/i);

  await hive.ensureAgent({ id: 'jake', name: 'Jake', provider: 'claude', cwd: home });
  assert.equal(hive.registry().agents.jake.reportsTo, 'terry', 'restart metadata omission retains hierarchy');
});

test('god remains the sole router alias and can mail any worker directly', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);

  const holt = await hive.ensureAgent({ id: 'holt', name: 'Holt', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'terry', name: 'Terry', provider: 'claude', cwd: home, reportsTo: 'holt' });
  await hive.ensureAgent({ id: 'rosa', name: 'Rosa', provider: 'claude', cwd: home, reportsTo: 'terry' });

  assert.match(promptFrom(holt), /retaining authority to address any agent directly/i);
  hive.send({ to: 'rosa', act: 'request', subject: 'Direct assignment', body: 'Report directly.' }, 'holt');
  assert.equal(hive.inbox('rosa').some((message) => message.from === 'holt'), true);
  assert.equal(hive.registry().godId, 'holt');
  assert.equal(hive.registry().agents.terry.isGod, undefined);
});

test('invalid supervisors are dropped without blocking registration', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);

  await hive.ensureAgent({ id: 'self', name: 'Self', provider: 'claude', cwd: home, reportsTo: 'self' });
  await hive.ensureAgent({ id: 'missing', name: 'Missing', provider: 'claude', cwd: home, reportsTo: 'nobody' });
  await hive.ensureAgent({ id: 'jake', name: 'Jake', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'terry', name: 'Terry', provider: 'claude', cwd: home, reportsTo: 'jake' });
  await hive.ensureAgent({ id: 'jake', name: 'Jake', provider: 'claude', cwd: home, reportsTo: 'terry' });

  const agents = hive.registry().agents;
  assert.equal(agents.self.reportsTo, undefined);
  assert.equal(agents.missing.reportsTo, undefined);
  assert.equal(agents.jake.reportsTo, undefined, 'cycle-closing edge is rejected');
  assert.equal(agents.terry.reportsTo, 'jake');
});
