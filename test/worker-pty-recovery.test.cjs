/* A worker can exit before its successful spawn is registered. Its normal exit
 * handler then cannot see the worker record, so the controller must explicitly
 * release that false-ready slot rather than leaving the queue deadlocked. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

test('worker controller releases a registered worker whose PTY disappeared', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  assert.match(source, /const idleMs = ptyManager\.idleFor\(workerId\);/);
  assert.match(source, /if \(idleMs === undefined\) \{[\s\S]*?teardownPty\(workerId\);[\s\S]*?continue;/);
  assert.match(source, /PTY is no longer live/);
});
