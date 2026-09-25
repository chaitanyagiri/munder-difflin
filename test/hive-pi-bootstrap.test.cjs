'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-pi-bootstrap-'));
}

test('Pi fresh spawn receives exactly one positional hive bootstrap', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const hive = new HiveManager(() => home);
  const injection = await hive.ensureAgent({
    id: 'toby-pi-test',
    name: 'Toby',
    provider: 'pi',
    cwd: home
  });

  assert.equal(injection.seedPrompt, undefined, 'Pi receives its bootstrap on argv, not via TUI typing');
  assert.equal(injection.args.length, 1, 'the bootstrap must remain one trailing positional argument');

  const [prompt] = injection.args;
  assert.match(prompt, /^You are "Toby" \(toby-pi-test\),/);
  assert.match(prompt, /HIVE PROTOCOL/);
  assert.ok(prompt.includes(path.join(home, 'hive', 'agents', 'toby-pi-test', 'inbox')));
  assert.ok(prompt.split('\n').length > 5, 'the multiline bootstrap must not be split into argv tokens');
});

test('Pi bridge setup failure does not suppress its positional bootstrap', async (t) => {
  const home = tmpHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const hive = new HiveManager(() => home);
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  hive.installPiHooks = () => { throw new Error('synthetic bridge failure'); };

  const injection = await hive.ensureAgent({
    id: 'pi-degraded-test',
    name: 'Meredith',
    provider: 'pi',
    cwd: home
  });

  assert.equal(injection.env.PI_CODING_AGENT_DIR, undefined);
  assert.equal(injection.args.length, 1);
  assert.match(injection.args[0], /^You are "Meredith" \(pi-degraded-test\),/);
  assert.match(injection.args[0], /HIVE PROTOCOL/);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /install hooks bridge failed/);
});
