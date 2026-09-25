'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  canUseCodexRemote,
  codexRemoteAliasPath,
  codexRemoteEndpoint,
  codexRemoteSocketFits,
  withCodexRemoteArgs,
  CODEX_REMOTE_SOCKET_MAX,
  CODEX_REMOTE_SOCKET_RELATIVE
} = loadTs('src/shared/codexRemote.ts');

test('Codex remote uses a short stable per-agent home alias', () => {
  const first = codexRemoteAliasPath('/very/long/hive/agent/.codex', 'dev-1', '/tmp');
  const again = codexRemoteAliasPath('/very/long/hive/agent/.codex', 'dev-1', '/tmp');
  const other = codexRemoteAliasPath('/very/long/hive/agent/.codex', 'dev-2', '/tmp');
  assert.equal(first, again);
  assert.notEqual(first, other);
  assert.ok(first.length < 80);
  assert.match(codexRemoteEndpoint(first), /^unix:\/\/\/tmp\//);
});

test('the default alias root yields a socket within sun_path', () => {
  // The real hive home that failed with "path must be shorter than SUN_LEN".
  const realHome =
    '/Users/vyapakgoyal/Documents/HarnessAgents/hive/agents/dev2-mrxb3l43/.codex';
  const socket =
    codexRemoteAliasPath(realHome, 'dev2-mrxb3l43') + '/' + CODEX_REMOTE_SOCKET_RELATIVE;
  assert.ok(
    socket.length < CODEX_REMOTE_SOCKET_MAX,
    `socket path is ${socket.length} bytes: ${socket}`
  );
  // …and shorter than the home it replaces, which the $TMPDIR version was not.
  assert.ok(socket.length < (realHome + '/' + CODEX_REMOTE_SOCKET_RELATIVE).length);
});

test('an over-long alias root is rejected instead of failing at bind time', () => {
  const tmpdirStyle = '/var/folders/v6/9f10q5d148z7bxdzhr22xl7r0000gn/T/munder-codex';
  assert.equal(codexRemoteSocketFits(codexRemoteAliasPath('/h/.codex', 'a', tmpdirStyle)), false);
  assert.equal(codexRemoteSocketFits(codexRemoteAliasPath('/h/.codex', 'a')), true);
});

test('remote endpoint precedes both fresh and resumed Codex invocations', () => {
  const endpoint = 'unix:///tmp/munder-codex/a/app-server-control/app-server-control.sock';
  assert.equal(canUseCodexRemote(['--model', 'gpt-5.6-sol', 'hello']), true);
  assert.deepEqual(
    withCodexRemoteArgs(['--model', 'gpt-5.6-sol', 'hello'], endpoint),
    ['--remote', endpoint, '--model', 'gpt-5.6-sol', 'hello']
  );
  assert.deepEqual(
    withCodexRemoteArgs(['resume', 'session-id', '--model', 'gpt-5.6-sol'], endpoint),
    ['--remote', endpoint, 'resume', 'session-id', '--model', 'gpt-5.6-sol']
  );
  assert.deepEqual(
    withCodexRemoteArgs(['--remote', endpoint, 'resume'], endpoint),
    ['--remote', endpoint, 'resume']
  );
});

test('workspace roots keep fresh and resumed Codex launches local', () => {
  const endpoint = 'unix:///tmp/example.sock';
  for (const prefix of [[], ['resume', 'session-id']]) {
    for (const roots of [
      ['--add-dir', '/tmp/agent home', '--add-dir', '/tmp/hive'],
      ['--add-dir=/tmp/agent home'],
      ['--add-dir', '.']
    ]) {
      const args = [...prefix, '--dangerously-bypass-hook-trust', ...roots,
        '--model', 'gpt-5.6-terra'];
      assert.equal(canUseCodexRemote(args), false);
      assert.deepEqual(withCodexRemoteArgs(args, endpoint), args);
    }
  }
});

test('an explicit local launch does not acquire a conflicting remote flag', () => {
  const args = ['--no-daemon', 'resume', 'session-id'];
  assert.equal(canUseCodexRemote(args), false);
  assert.deepEqual(withCodexRemoteArgs(args, 'unix:///tmp/example.sock'), args);
});
