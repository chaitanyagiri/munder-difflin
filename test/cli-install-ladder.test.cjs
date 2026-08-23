'use strict';

/**
 * Every provider's `installCommand` is `npm install -g …`. On a machine with no
 * Node, the missing-CLI banner used to print that command and RUN it — so a fresh
 * user watched `npm: command not found` scroll past and concluded the app was
 * broken. The ladder classifies first and only ever runs something that can work.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { chooseInstallRung, buildMissingCliScript } = loadTs('src/main/cliInstall.ts');
const { installInfoForProvider } = loadTs('src/shared/agentProvider.ts');

const script = (provider, npmAvailable, platform) =>
  buildMissingCliScript(provider, provider, npmAvailable, platform);

test('with npm present the ladder is unchanged — npm install, for every provider', () => {
  for (const provider of ['claude', 'codex', 'gemini', 'opencode', 'crush', 'copilot']) {
    const info = installInfoForProvider(provider);
    const rung = chooseInstallRung(info, true);
    assert.equal(rung.kind, 'npm', provider);
    assert.equal(rung.command, info.command, provider);
    assert.equal(rung.nodeMissing, false, provider);
  }
});

test('with npm absent, a provider shipping a native installer uses it', () => {
  const rung = chooseInstallRung(installInfoForProvider('claude'), false);
  assert.equal(rung.kind, 'native');
  assert.equal(rung.nodeMissing, true);
  assert.doesNotMatch(rung.command, /\bnpm\b/, 'the whole point is that npm is not there');
});

test('cursor prefers its native curl installer (no npm package)', () => {
  const info = installInfoForProvider('cursor');
  assert.equal(info.command, undefined, 'cursor is not an npm global package');
  assert.ok(info.nativeCommand, 'ships curl|bash / irm|iex installer');
  const withNpm = chooseInstallRung(info, true);
  assert.equal(withNpm.kind, 'native', 'native rung even when npm exists');
  const withoutNpm = chooseInstallRung(info, false);
  assert.equal(withoutNpm.kind, 'native');
  assert.match(withoutNpm.command, /cursor\.com\/install/);
});

test('with npm absent and no native installer, NOTHING is run', () => {
  const info = installInfoForProvider('codex');
  assert.equal(info.nativeCommand, undefined, 'fixture assumes codex has no native installer');
  const rung = chooseInstallRung(info, false);
  assert.equal(rung.kind, 'manual');
  assert.equal(rung.command, undefined, 'a command here would be the doomed `npm install -g`');
});

test('the no-node script explains the real problem instead of failing at it', () => {
  const out = script('codex', false);
  assert.match(out, /Node\.js is not installed/);
  assert.match(out, /nodejs\.org/, 'tell the user where to get it');
  assert.match(out, /Docs: https/, 'and keep the provider docs link');

  // The npm command may still be SHOWN (as the follow-up step) but must never be
  // an executed line: every executable line here is an `echo`.
  const executable = out.split('\n').filter((l) => l.trim() && !/^\s*echo\b/.test(l.trim()));
  assert.deepEqual(executable, [], `these would run on a machine with no node: ${executable}`);
});

test('the native rung actually runs, and says why it differs', () => {
  const out = script('claude', false);
  assert.match(out, /no Node needed/);
  const native = installInfoForProvider('claude').nativeCommand;
  assert.ok(out.split('\n').includes(native), 'the installer must be an executed line, not only echoed');
});

test('with npm present nothing mentions a missing Node', () => {
  const out = script('claude', true);
  assert.doesNotMatch(out, /Node\.js is not installed/);
  assert.ok(out.split('\n').includes('npm install -g @anthropic-ai/claude-code'));
});

test('the Windows script stays a single quote-free cmd.exe line', () => {
  // It is wrapped verbatim in `cmd /d /s /c "<script>"` — one embedded double
  // quote ends the command line early and the rest executes as garbage.
  for (const provider of ['claude', 'codex']) {
    for (const npm of [true, false]) {
      const out = buildMissingCliScript(provider, provider, npm, 'win32');
      assert.ok(!out.includes('"'), `${provider}/${npm}: embedded quote`);
      assert.ok(!out.includes('\n'), `${provider}/${npm}: must be one line`);
    }
  }
  assert.match(buildMissingCliScript('claude', 'claude', false, 'win32'), /powershell/,
    'the native rung must be the PowerShell form on Windows, not the curl one');
});

test('a hostile binary name cannot inject a command into the banner', () => {
  const out = script('claude', true).split('\n');
  const evil = buildMissingCliScript("x'; rm -rf /; echo '", 'claude', true).split('\n');
  assert.equal(evil.length, out.length, 'no extra statements');
  assert.ok(evil.some((l) => l.includes('xrm-rf')), 'sanitized to a bare identifier');
  assert.ok(!evil.some((l) => /rm -rf \//.test(l)));
});
