/**
 * A successful update check must be visible.
 *
 * The complaint that started this: on the latest release, a manual check
 * succeeds, finds nothing, and the badge settles back to a quiet grey "latest"
 * chip. A check that worked perfectly and a click that never registered look
 * identical, so the button reads as broken. The fix is a brief, positive
 * acknowledgement after a manual no-update check. Source-string checks, because
 * UpdateBadge is a React component with no jsdom harness in this repo; deleting
 * the acknowledgement wiring must not pass silently.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const read = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8');
const SRC = read('src/renderer/src/components/UpdateBadge.tsx');

test('the check branch acknowledges a no-update result', () => {
  assert.ok(/setCheckedOk\(true\)/.test(SRC),
    'the manual check must set the acknowledgement, or a successful check stays silent');
  assert.ok(/updateCheckNow\(\)/.test(SRC) && /updateCurrent\?\.\(\)/.test(SRC),
    'it reads the settled status back after the check to tell a no-update result from an available one');
  assert.ok(/'not-available'/.test(SRC),
    'the acknowledgement is gated on a no-update state, not fired blindly for every check');
});

test('the acknowledgement renders and auto-dismisses', () => {
  assert.ok(/checkedOk && !started &&/.test(SRC),
    'the acknowledgement popover must render when checkedOk is set');
  assert.ok(/on the latest version/i.test(SRC),
    'it must say, in words, that the user is already current');
  assert.ok(/setTimeout\(\(\) => setCheckedOk\(false\)/.test(SRC),
    'it must auto-dismiss, or it is a stuck mode instead of a flash');
});
