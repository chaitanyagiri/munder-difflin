'use strict';
// Under `npm run dev`, a change of harness home (or a full reset) must EXIT, not
// relaunch.
//
// Both paths ended in app.relaunch() + app.exit(0). Packaged, that is the clean
// re-bind. In dev the renderer is served by electron-vite's dev server, which
// lives in the wrapper that watches this Electron and exits with it — so the
// relaunched Electron started against a dead dev server and came up with a
// BLANK window that the developer had to hunt down and kill before running
// `npm run dev` again (seen every time a hive was created or switched in dev).
// Now dev mode exits cleanly with a console line saying why; the next
// `npm run dev` boots against the new config.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { relaunchPlan, devExitNotice } = loadTs('src/main/relaunch.ts');

test('relaunchPlan: packaged relaunches, electron-vite dev exits', () => {
  assert.equal(relaunchPlan({}), 'relaunch');
  assert.equal(relaunchPlan({ ELECTRON_RENDERER_URL: '' }), 'relaunch', 'an empty marker is no marker');
  assert.equal(relaunchPlan({ ELECTRON_RENDERER_URL: 'http://localhost:5173' }), 'exit');
});

test('the dev notice names the trigger and tells the developer what to run', () => {
  const line = devExitNotice('changeHome');
  assert.match(line, /^\[changeHome\] dev mode/);
  assert.match(line, /npm run dev/);
});

// The two callers are IPC handlers that cannot be imported on their own, so the
// wiring is pinned by reading index.ts as text: neither path calls app.relaunch()
// directly any more — both go through the one helper that knows about dev mode.
test('changeHome and reset both go through relaunchOrExit; app.relaunch() lives only inside it', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const helper = source.indexOf('function relaunchOrExit(');
  assert.ok(helper > 0, 'the helper exists');
  assert.ok(source.indexOf("relaunchOrExit('changeHome')") > helper, 'changeHome uses it');
  assert.ok(source.indexOf("relaunchOrExit('reset')") > helper, 'reset uses it');
  const relaunches = source.match(/app\.relaunch\(\)/g) ?? [];
  assert.equal(relaunches.length, 1, 'the only app.relaunch() is the helper\'s packaged branch');
  const helperBody = source.slice(helper, source.indexOf('\n}\n', helper));
  assert.ok(helperBody.includes("relaunchPlan() === 'exit'"), 'the helper asks relaunchPlan');
  assert.ok(helperBody.includes('app.relaunch()') && helperBody.includes('app.exit(0)'));
});
