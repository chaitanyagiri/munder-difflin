'use strict';

/**
 * WSL2 ROUTING — HarnessConfig.wslDistro, plus projects that live INSIDE a distro
 * (\\wsl.localhost\<distro>\…). Windows only.
 *
 * An agent spawn becomes `wsl.exe -d <distro> --cd <cwd> -e bash -lic
 * 'exec "$0" "$@"' <command> <args…>`. Everything after `-e` is argv, so node-pty's
 * CRT escaping applies and the multi-line hive prompt survives. cwd, args and env
 * values have their Windows paths rewritten for the distro (`C:\…` → `/mnt/c/…`,
 * `\\wsl.localhost\<distro>\…` → `/…`); env crosses the boundary through WSLENV.
 * Host-independent on purpose: the Windows build is authored on Linux/macOS.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { buildWslSpawn, parseWslUnc, toWslPath, toWslPaths } = loadTs('src/main/pty.ts');
const { argsToCommandLine } = require('node-pty/lib/windowsPtyAgent.js');

const PROMPT = 'HIVE PROTOCOL\nread inbox/ (then "reply")\nline 3';

test('parseWslUnc: \\\\wsl.localhost and \\\\wsl$ forms, either slash; nothing else', () => {
  assert.deepEqual(parseWslUnc('\\\\wsl.localhost\\Ubuntu\\home\\q\\proj'), { distro: 'Ubuntu', linuxPath: '/home/q/proj' });
  assert.deepEqual(parseWslUnc('\\\\wsl$\\Debian\\'), { distro: 'Debian', linuxPath: '/' });
  assert.deepEqual(parseWslUnc('//wsl.localhost/Ubuntu/tmp/'), { distro: 'Ubuntu', linuxPath: '/tmp' });
  assert.equal(parseWslUnc('C:\\Users\\q'), null);
  assert.equal(parseWslUnc('\\\\server\\share\\x'), null);
  assert.equal(parseWslUnc('/home/q'), null);
});

test('toWslPath: drive → /mnt, own-distro UNC → linux path, other distro / non-path → null', () => {
  assert.equal(toWslPath('C:\\Users\\Jane Doe\\HarnessAgents', 'Ubuntu'), '/mnt/c/Users/Jane Doe/HarnessAgents');
  assert.equal(toWslPath('D:/x/y', 'Ubuntu'), '/mnt/d/x/y');
  assert.equal(toWslPath('\\\\wsl.localhost\\ubuntu\\home\\q', 'Ubuntu'), '/home/q');
  assert.equal(toWslPath('\\\\wsl.localhost\\Debian\\home\\q', 'Ubuntu'), null);
  assert.equal(toWslPath('claude', 'Ubuntu'), null);
  assert.equal(toWslPath(PROMPT, 'Ubuntu'), null);
});

test('toWslPaths: rewrites paths embedded in prose, leaves the rest alone', () => {
  const s = 'Inbox: C:\\Users\\T\\HarnessAgents\\agents\\jim\\inbox (see \\\\wsl.localhost\\Ubuntu\\home\\q\\proj). Not http://x/y.';
  assert.equal(toWslPaths(s, 'Ubuntu'), 'Inbox: /mnt/c/Users/T/HarnessAgents/agents/jim/inbox (see /home/q/proj). Not http://x/y.');
  assert.equal(toWslPaths('--model', 'Ubuntu'), '--model');
});

test('buildWslSpawn: wsl.exe argv shape, cwd via --cd, CLI exec\'d as $0', () => {
  const w = buildWslSpawn('Ubuntu', 'C:\\Users\\T\\proj', 'claude', ['--model', 'x', '--append-system-prompt', PROMPT]);
  assert.equal(w.file, 'wsl.exe');
  assert.deepEqual(w.args.slice(0, 8), ['-d', 'Ubuntu', '--cd', '/mnt/c/Users/T/proj', '-e', 'bash', '-lic', 'exec "$0" "$@"']);
  assert.deepEqual(w.args.slice(8), ['claude', '--model', 'x', '--append-system-prompt', PROMPT]);
  // The prompt rides argv (newlines intact) through node-pty's CRT escaper — no
  // cmd.exe in the chain to cut it at the first newline.
  const line = argsToCommandLine(w.file, w.args);
  assert.ok(line.includes('HIVE PROTOCOL') && line.includes('\nline 3'));
});

test('buildWslSpawn: a project inside the distro runs at its Linux path', () => {
  const w = buildWslSpawn('Ubuntu', '\\\\wsl.localhost\\Ubuntu\\home\\q\\proj', 'claude', []);
  assert.deepEqual(w.args.slice(2, 4), ['--cd', '/home/q/proj']);
});

test('buildWslSpawn: --settings/--add-dir and prompt-embedded paths are rewritten for the distro', () => {
  const w = buildWslSpawn('Ubuntu', 'C:\\p', 'claude', [
    '--settings', 'C:\\Users\\T\\HarnessAgents\\agents\\jim\\settings.json',
    '--add-dir', '\\\\wsl.localhost\\Ubuntu\\home\\q\\shared',
    '--append-system-prompt', `Inbox at C:\\Users\\T\\HarnessAgents\\agents\\jim\\inbox\n${PROMPT}`
  ]);
  assert.deepEqual(w.args.slice(9), [
    '--settings', '/mnt/c/Users/T/HarnessAgents/agents/jim/settings.json',
    '--add-dir', '/home/q/shared',
    '--append-system-prompt', `Inbox at /mnt/c/Users/T/HarnessAgents/agents/jim/inbox\n${PROMPT}`
  ]);
});

test('buildWslSpawn: WSLENV forwards agent env, values rewritten for the distro', () => {
  const w = buildWslSpawn('Ubuntu', 'C:\\p', 'claude', [], { HIVE_ROOT: 'C:\\Users\\T\\HarnessAgents', HIVE_AGENT: 'jim' }, 'EXISTING/u');
  assert.equal(w.env.WSLENV, 'EXISTING/u:HIVE_ROOT/u:HIVE_AGENT/u');
  assert.equal(w.env.HIVE_ROOT, '/mnt/c/Users/T/HarnessAgents');
  assert.equal(w.env.HIVE_AGENT, 'jim');
});

test('buildWslSpawn: no env → no WSLENV', () => {
  assert.deepEqual(buildWslSpawn('Ubuntu', 'C:\\p', 'claude', []).env, {});
});
