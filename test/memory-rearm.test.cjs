'use strict';

/**
 * Semantic memory must not be stuck on "getting ready" until the app restarts.
 *
 * start() runs once at boot and bails when mempalace isn't on PATH. Installing
 * it afterwards — the usual order, since the settings panel is where you learn
 * you need it — left nothing to re-invoke start(), so the mine loop never ran,
 * the palace (created by the first mine) never appeared, and the pill read
 * "On — getting ready…" forever while `available` correctly read true.
 *
 * The status poll notices the install, so the poll is what arms the loop.
 * `bin()` is stubbed here because the real one probes the machine's PATH, which
 * would make the outcome depend on whether the developer happens to have
 * mempalace installed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { MemoryManager } = loadTs('src/main/memory.ts');

/** A manager over an empty temp home whose CLI resolution we control. */
function managerWithCli(t, opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-memory-'));
  const state = { bin: opts.bin ?? null, enabled: opts.enabled !== false };
  const memory = new MemoryManager(() => home, () => ({ enabled: state.enabled, model: 'minilm' }));
  memory.bin = () => state.bin; // the real one shells out to `which mempalace`
  t.after(() => { memory.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  return { memory, state, home };
}

/** The mine loop is armed exactly when its interval handle exists. */
const armed = (memory) => memory.mineTimer !== null;

test('a poll before mempalace is installed reports "not available" and arms nothing', (t) => {
  const { memory } = managerWithCli(t);

  const status = memory.refresh();

  assert.equal(status.available, false);
  assert.equal(status.active, false);
  assert.equal(armed(memory), false);
});

test('a poll AFTER mempalace appears arms the mine loop that boot had to skip', (t) => {
  const { memory, state } = managerWithCli(t);

  memory.start();                    // boot: mempalace not installed yet
  assert.equal(armed(memory), false, 'nothing to start');

  state.bin = '/fake/bin/mempalace'; // the user installs it while the app runs
  const status = memory.refresh();

  assert.equal(status.available, true);
  assert.equal(status.active, true);
  assert.equal(armed(memory), true, 'this is what left the pill on "getting ready" forever');
});

test('polling again never starts a second mine loop', (t) => {
  const { memory } = managerWithCli(t, { bin: '/fake/bin/mempalace' });

  memory.refresh();
  const first = memory.mineTimer;
  memory.refresh();
  memory.refresh();

  assert.equal(memory.mineTimer, first, 'the palace permits a single writer — one loop only');
});

test('memory turned off in settings stays off however often it is polled', (t) => {
  const { memory } = managerWithCli(t, { bin: '/fake/bin/mempalace', enabled: false });

  const status = memory.refresh();

  assert.equal(status.available, true, 'the CLI is there…');
  assert.equal(status.enabled, false, '…but the user said no');
  assert.equal(armed(memory), false);
});
