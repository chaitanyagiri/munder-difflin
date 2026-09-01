'use strict';

/**
 * Slack Stop is a user decision and must survive a restart.
 *
 * Boot re-arms the server from `slackEnabled` (src/main/index.ts, the
 * `slackCfg.slackEnabled && slackCfg.slackSigningSecret` gate), so a Stop that
 * only tears down the running server leaves the flag true and Slack silently
 * comes back on the next launch.
 *
 * `index.ts` imports electron, so it cannot be require()d here — this reads it as
 * source, the same approach test/update-applied.test.cjs uses for updater.ts.
 * The scan is deliberately TWO-SIDED: the user-facing handler must clear the
 * flag, and the lifecycle teardowns (changeHome / quit / reset) must not. Pinning
 * only the first half would let a "fix" that clears the flag on quit pass.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.log(`  ✗ ${name}\n     ${err.message}`);
  }
}

const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');

/** The body of the `slack:stop` IPC handler, from the handle() call to the
 *  matching `});` that closes it. */
function slackStopHandler() {
  const start = src.indexOf("ipcMain.handle('slack:stop'");
  assert.notStrictEqual(start, -1, "no slack:stop handler found in src/main/index.ts");
  const end = src.indexOf('\n});', start);
  assert.notStrictEqual(end, -1, "could not find the end of the slack:stop handler");
  return src.slice(start, end);
}

test('slack:stop persists slackEnabled:false, so boot does not re-arm', () => {
  const body = slackStopHandler();
  assert.ok(
    /writeConfig\(\{[^}]*slackEnabled:\s*false|disableSlack\(\)/.test(body),
    'slack:stop tears the server down but never clears slackEnabled — the next ' +
    'launch will re-arm it and Slack comes back after the user pressed Stop'
  );
});

test('slack:stop still actually stops the running server', () => {
  assert.ok(/stopSlackServer\(\)/.test(slackStopHandler()), 'slack:stop no longer stops the server');
});

test('the lifecycle teardowns do not clear the flag', () => {
  // changeHome / quit / reset call stopSlackServer() directly. They are lifecycle,
  // not the user disabling the integration, so an enabled Slack must still be
  // enabled after a restart — the issue calls this out explicitly.
  //
  // Assert against the teardown lines themselves, not a count across the file: a
  // file-wide count both fails a legitimate second clear elsewhere (e.g. clearing
  // the flag when the signing secret is emptied) and passes a teardown that
  // disables via a helper, which is the regression this is here to catch.
  for (const tag of ['changeHome', 'quit', 'reset']) {
    const re = new RegExp(`^.*console\\.error\\('\\[${tag}\\] slack\\.stop:.*$`, 'm');
    const line = src.match(re);
    assert.ok(line, `could not find the ${tag} slack teardown line — has it been renamed?`);
    assert.ok(
      !/writeConfig|slackEnabled|disableSlack/.test(line[0]),
      `the ${tag} teardown now writes config — lifecycle must not disable Slack behind the user`
    );
  }
});

if (failures > 0) {
  console.log(`\n${failures} test(s) failed`);
  process.exit(1);
}
