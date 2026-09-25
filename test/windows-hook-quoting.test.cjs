'use strict';

/**
 * #549: on Windows, every hook failed when the profile path contained a space.
 *
 * A harness runs a `type: "command"` hook through `cmd.exe /d /s /c "<command>"`.
 * `/s` strips the first and last quote character of what it is handed, so a
 * command quoted exactly once arrives with its quotes removed:
 *
 *   built     "C:\Users\John Doe\hive\bin\hive-node.cmd" "…\hook.cjs"
 *   after /s   C:\Users\John Doe\hive\bin\hive-node.cmd" "…\hook.cjs
 *
 * cmd then splits the launcher at the first space and reports
 * `"C:\Users\John" is not recognized as an internal or external command`.
 * Agents still ran, but the floor received no hook events at all.
 *
 * The fix adds a second, outer pair on win32: `/s` eats that one and the inner
 * quoting survives. These tests pin the property that matters — what is left
 * AFTER cmd strips — rather than the exact string, and cover the statusLine,
 * whose `--status` has to travel inside the outer pair to survive with it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-549-ud-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { app: { getPath: () => userData } }
};

const { HiveManager } = loadTs('src/main/hive.ts');

const realPlatform = process.platform;
function asPlatform(value, fn) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  }
}

/** A home whose path contains a space, as `C:\Users\John Doe` does. */
function spacedHome() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'md-549-'));
  const home = path.join(base, 'John Doe');
  fs.mkdirSync(home, { recursive: true });
  return home;
}

/** Put the launcher on disk so nodeLauncher() resolves it instead of falling
 *  back to bare `node`, which has no space to split at. */
function withLauncher(home, platform) {
  const bin = path.join(home, 'hive', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const name = platform === 'win32' ? 'hive-node.cmd' : 'hive-node';
  fs.writeFileSync(path.join(bin, name), '');
  return path.join(bin, name);
}

/** What `cmd.exe /d /s /c` hands on.
 *
 *  `/s` strips the FIRST and LAST quote character of the string — wherever they
 *  sit, not only when the command both opens and closes with one. That is why
 *  appending an argument after a quoted command does not save it: the last
 *  quote is then the one before the argument, and the launcher is left bare. */
function afterCmdSlashS(command) {
  const first = command.indexOf('"');
  const last = command.lastIndexOf('"');
  if (first === -1 || first === last) return command;
  return command.slice(0, first) + command.slice(first + 1, last) + command.slice(last + 1);
}

test('a spaced launcher is still quoted after cmd.exe /s strips the outer pair', () => {
  const home = spacedHome();
  const launcher = withLauncher(home, 'win32');
  const shim = path.join(home, 'hive', 'bin', 'hook.cjs');

  const command = asPlatform('win32', () => new HiveManager(() => home).hookCommand(shim));
  const delivered = afterCmdSlashS(command);

  assert.ok(
    delivered.includes(`"${launcher}"`),
    `launcher lost its quotes: ${delivered}`
  );
  assert.ok(delivered.includes(`"${shim}"`), `script lost its quotes: ${delivered}`);
});

test('the pre-fix single-quoted form is what cmd /s breaks', () => {
  // Guards the model itself: if this stops reproducing the reported failure,
  // afterCmdSlashS no longer describes the behaviour the fix exists for. The
  // exact string and error are from the issue.
  const single = '"C:\\Users\\John Doe\\hive-node.cmd" "C:\\hook.cjs"';
  assert.equal(afterCmdSlashS(single), 'C:\\Users\\John Doe\\hive-node.cmd" "C:\\hook.cjs');
  // cmd then splits at the first space and reports `C:\Users\John`.
  assert.equal(afterCmdSlashS(single).split(' ')[0], 'C:\\Users\\John');
});

test('statusLine keeps --status inside the outer pair', () => {
  const home = spacedHome();
  withLauncher(home, 'win32');
  const shim = path.join(home, 'hive', 'bin', 'hook.cjs');

  const settings = asPlatform('win32', () =>
    new HiveManager(() => home).hookSettings(shim, home, {})
  );
  const command = settings.statusLine.command;
  const delivered = afterCmdSlashS(command);

  assert.ok(delivered.endsWith('--status'), `--status was stripped with the outer pair: ${command}`);
  assert.ok(delivered.includes(`"${shim}"`), `script lost its quotes: ${delivered}`);
});

test('every generated hook command survives the strip', () => {
  const home = spacedHome();
  withLauncher(home, 'win32');
  const shim = path.join(home, 'hive', 'bin', 'hook.cjs');

  const settings = asPlatform('win32', () =>
    new HiveManager(() => home).hookSettings(shim, home, {})
  );
  const commands = Object.values(settings.hooks ?? {})
    .flat()
    .flatMap((entry) => entry.hooks ?? [])
    .map((hook) => hook.command);

  assert.ok(commands.length > 0, 'expected hookSettings to generate hooks');
  for (const command of commands) {
    assert.ok(
      afterCmdSlashS(command).includes(`"${shim}"`),
      `hook command loses its quoting: ${command}`
    );
  }
});

test('POSIX gains no extra quotes', () => {
  const home = spacedHome();
  const launcher = withLauncher(home, 'linux');
  const shim = path.join(home, 'hive', 'bin', 'hook.cjs');

  const command = asPlatform('linux', () => new HiveManager(() => home).hookCommand(shim));

  assert.equal(command, `"${launcher}" "${shim}"`);
  assert.ok(!command.startsWith('""'), 'POSIX must not carry the cmd.exe workaround');
});
