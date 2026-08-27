/**
 * Cancelling the quit warning must un-stick restart-to-install.
 *
 * The bug: `quitAndInstall()` reports nothing. It ASKS the app to quit, and with
 * agents running the app refuses and puts up the quit warning. The IPC handler
 * returned `{ ok: true }` at that moment, so every surface that had disabled its
 * button was told the restart had succeeded — and then the user cancelled, the
 * app carried on living, and the button sat on "restarting…" forever with
 * nothing left to resolve it.
 *
 * The fix is a wiring one and lives across two files, which is exactly why it is
 * worth pinning: the handler waits for an outcome, and the cancel path is the
 * thing that supplies it. Delete either half and the bug returns silently, with
 * every unit test still green, because nothing pure is involved.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const read = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8');

test('the restart handler waits for an outcome instead of assuming one', () => {
  const src = read('src/main/updater.ts');
  const handler = src.slice(src.indexOf("ipcMain.handle('update:restartAndInstall'"));
  const body = handler.slice(0, handler.indexOf('\n  });'));

  assert.ok(body.includes('await cancelled'),
    'the handler must await the cancellation signal — returning straight after '
    + 'quitAndInstall() is what told the renderer a refused quit had succeeded');
  assert.ok(!/return \{ ok: true \}/.test(body),
    'there is no success to report here: either the process dies, or the quit was called off');
  assert.ok(/export function abortPendingRestart\(\): void/.test(src),
    'the cancel path needs a way in');
});

test('cancelling the quit warning is wired to the restart handler', () => {
  const src = read('src/main/index.ts');
  assert.ok(src.includes("import { initAutoUpdater, abortPendingRestart } from './updater';"),
    'index.ts must import the abort');
  const handler = src.slice(src.indexOf("ipcMain.handle('app:cancelClose'"));
  const body = handler.slice(0, handler.indexOf('\n});'));
  assert.ok(body.includes('abortPendingRestart()'),
    'app:cancelClose is the ONLY place that knows a requested quit was refused; '
    + 'if it stops calling this, the restart button goes back to hanging');
});

test('the renderer restores its notice when the restart reports a cancel', () => {
  const src = read('src/renderer/src/components/UpdateToast.tsx');
  const fn = src.slice(src.indexOf('const restart = async'));
  const body = fn.slice(0, fn.indexOf('\n  };'));
  assert.ok(/if \(!res\.ok\) \{ setStatus\(prev\); setBusy\(false\); \}/.test(body),
    'a cancelled restart has to put the notice back AND clear busy — clearing one '
    + 'without the other leaves either a dead button or no way to retry');
});

test('a re-entry guard refuses a duplicate restart instead of firing quitAndInstall twice', () => {
  const src = read('src/main/updater.ts');
  const handler = src.slice(src.indexOf("ipcMain.handle('update:restartAndInstall'"));
  const body = handler.slice(0, handler.indexOf('\n  });'));
  assert.ok(/if \(pendingRestart\) return/.test(body),
    'a second restart-to-install while one is pending must be refused; firing '
    + 'quitAndInstall again hits the native command Squirrel has already disabled '
    + '("The command is disabled and cannot be executed"), the recurring install wedge');
  assert.ok(!body.includes('abortPendingRestart()'),
    'the handler must NOT abort-and-refire a pending restart, that abort-then-new '
    + 'quitAndInstall WAS the double fire; the guard replaces it');
});

test('a failed quit settles the pending restart so the button stops spinning', () => {
  const src = read('src/main/updater.ts');
  assert.ok(/function failPendingRestart\(error: string\): void/.test(src),
    'a restart the native updater refuses reports via the error event, not a throw; '
    + 'without a way to settle the pending restart the handler awaits forever');
  const onErrorIdx = src.indexOf("autoUpdater.on('error'");
  const settleIdx = src.indexOf('failPendingRestart(message)');
  assert.ok(onErrorIdx !== -1 && settleIdx > onErrorIdx && settleIdx - onErrorIdx < 900,
    'the autoUpdater error handler is where a failed quit surfaces, so it must settle '
    + 'the pending restart there (failPendingRestart), or the handler hangs');
});
