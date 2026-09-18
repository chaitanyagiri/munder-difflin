'use strict';

/**
 * A terminal link must never act on a plain click.
 *
 * The provider underlines tokens found in agent output, so the text is hostile
 * by assumption. Both verdicts are therefore gated on ⌘/Ctrl: a path goes to a
 * metadata-only stat, and a URL goes to the https-only main-process opener.
 * Losing either gate turns printed agent output into a one-click browser
 * navigation or file open, which is why this is pinned rather than left to
 * review.
 *
 * `terminalPool.ts` imports xterm and React, so it cannot be require()d here.
 * This reads it as source, the same approach test/arabic-terminal.test.cjs uses
 * for this exact file.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'src/renderer/src/components/terminalPool.ts'), 'utf8');

/** The body of the link provider, where every activate() lives. */
function providerBody() {
  const i = src.indexOf('function registerMarkdownLinkProvider');
  assert.ok(i > 0, 'the link provider has been renamed — this test needs updating');
  const rest = src.slice(i);
  return rest.slice(0, rest.indexOf('\n}\n'));
}

test('every activate() in the provider is gated on a Cmd/Ctrl modifier', () => {
  const body = providerBody();
  const activates = body.split('activate:').length - 1;
  assert.ok(activates >= 2, `expected a path and a URL activate, found ${activates}`);
  const gates = body.split('metaKey').length - 1;
  assert.equal(gates, activates,
    `${activates} activate() handlers but ${gates} modifier gates — one path acts on a plain click`);
});

test('the URL branch opens only through the guarded opener, and only once', () => {
  // A second openExternal call site would be a way around the gate above.
  assert.equal(src.split('openExternal').length - 1, 1,
    'openExternal appears more than once in terminalPool.ts');
  const body = providerBody();
  const call = body.indexOf('openExternal');
  const gate = body.lastIndexOf('metaKey', call);
  assert.ok(gate > 0 && call - gate < 400,
    'the openExternal call is not behind a modifier gate');
});

test('the URL branch never reaches the filesystem verdicts', () => {
  // A URL is not a path: it must not reach statAbs, revealPath or the IDE.
  const body = providerBody();
  const url = body.indexOf("span.kind === 'url'");
  assert.ok(url > 0, "the url branch has moved — this test needs updating");
  const branch = body.slice(url, body.indexOf('continue;', url));
  for (const forbidden of ['statAbs', 'revealPath', 'openFileInIde', 'activatePath']) {
    assert.ok(!branch.includes(forbidden), `the url branch reaches ${forbidden}`);
  }
});
