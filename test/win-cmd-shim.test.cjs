'use strict';

/**
 * WINDOWS AGENT-TO-AGENT MESSAGING — the argv path.
 *
 * On Windows a `.cmd` cannot be handed to CreateProcess, so every npm-installed
 * engine CLI (OpenCode always; `claude.cmd` whenever there is no native
 * `claude.exe`) used to be spawned as `cmd.exe /d /s /c "<one big string>"`. The
 * hive protocol is injected on argv (`--append-system-prompt <prompt>` /
 * `--prompt <prompt>`) and that prompt is MULTI-LINE, paren-heavy and quote-heavy.
 * cmd.exe treats CR/LF as a statement separator before quoting is even considered,
 * so the prompt was truncated at its first newline: the agent booted looking
 * perfectly healthy, never received the HIVE PROTOCOL block, never learned that
 * `inbox/`/`outbox/` existed — and therefore no agent ever messaged another.
 *
 * The fix decodes the npm shim to the interpreter + script it wraps and spawns
 * THAT with an argv ARRAY, so node-pty's `argsToCommandLine` (MSDN/CRT escaping)
 * runs and CreateProcess receives the command line directly — no shell parser
 * anywhere. These tests pin both halves: what the shim parser accepts/refuses, and
 * that the array path really does round-trip a hostile prompt.
 *
 * Everything here is host-independent on purpose (win32 path handling and pure
 * string escaping), because the whole Windows build is authored on macOS.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  parseNpmCmdShim,
  buildCmdCommandLine,
  normalizePermissionMode,
  PtyManager
} = loadTs('src/main/pty.ts');
// The REAL escaper node-pty applies to an argv array on Windows. Testing against a
// copy would prove nothing, so we reach into node-pty's own module (the native
// bindings it needs load lazily inside the agent constructor, not on require).
const { argsToCommandLine } = require('node-pty/lib/windowsPtyAgent.js');

const NPM_DIR = 'C:\\Users\\Tester\\AppData\\Roaming\\npm';
const SHIM = `${NPM_DIR}\\opencode.cmd`;

test('cbcode uses auto permission mode without changing Claude arguments', () => {
  const args = ['--model', 'claude-opus-4-8', '--permission-mode', 'bypassPermissions'];
  assert.deepEqual(
    normalizePermissionMode('/opt/homebrew/bin/cbcode', args),
    ['--model', 'claude-opus-4-8', '--permission-mode', 'auto']
  );
  assert.deepEqual(normalizePermissionMode('/usr/local/bin/claude', args), args);
});

// ── real-world npm shim shapes ───────────────────────────────────────────────

/** cmd-shim >= 4 (npm >= 7) — what a 2024+ `npm i -g opencode-ai` writes. */
const MODERN = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\opencode-ai\\bin\\opencode.js" %*'
].join('\r\n');

/** cmd-shim 2/3 (npm 5/6) — IF/ELSE with the exec inlined in both arms. */
const CLASSIC = [
  '@IF EXIST "%~dp0\\node.exe" (',
  '  "%~dp0\\node.exe"  "%~dp0\\node_modules\\opencode-ai\\bin\\opencode.js" %*',
  ') ELSE (',
  '  @SETLOCAL',
  '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
  '  node  "%~dp0\\node_modules\\opencode-ai\\bin\\opencode.js" %*',
  ')'
].join('\r\n');

/** The oldest single-line form. */
const ANCIENT = '@"%~dp0\\node.exe"  "%~dp0\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n';

/** pnpm/yarn write the same family but reach OUT of the bin dir with `..`. */
const PNPM = [
  '@IF EXIST "%~dp0\\node.exe" (',
  '  "%~dp0\\node.exe" "%~dp0\\..\\opencode-ai\\bin\\opencode.js" %*',
  ') ELSE (',
  '  node "%~dp0\\..\\opencode-ai\\bin\\opencode.js" %*',
  ')'
].join('\n');

test('modern npm shim → the interpreter and script it really runs', () => {
  assert.deepEqual(parseNpmCmdShim(SHIM, MODERN), {
    interpreter: 'node',
    scriptPath: `${NPM_DIR}\\node_modules\\opencode-ai\\bin\\opencode.js`
  });
});

test('classic npm 5/6 shim resolves through its ELSE arm', () => {
  assert.deepEqual(parseNpmCmdShim(SHIM, CLASSIC), {
    interpreter: 'node',
    scriptPath: `${NPM_DIR}\\node_modules\\opencode-ai\\bin\\opencode.js`
  });
});

test('ancient single-line shim resolves', () => {
  assert.deepEqual(parseNpmCmdShim(`${NPM_DIR}\\npm.cmd`, ANCIENT), {
    interpreter: 'node',
    scriptPath: `${NPM_DIR}\\node_modules\\npm\\bin\\npm-cli.js`
  });
});

test('a `..` in the shim target is normalized, not passed through', () => {
  const shim = `${NPM_DIR}\\node_modules\\.bin\\opencode.cmd`;
  assert.deepEqual(parseNpmCmdShim(shim, PNPM), {
    interpreter: 'node',
    scriptPath: `${NPM_DIR}\\node_modules\\opencode-ai\\bin\\opencode.js`
  });
});

test('LF-only content parses the same as CRLF', () => {
  assert.deepEqual(
    parseNpmCmdShim(SHIM, MODERN.replace(/\r\n/g, '\n')),
    parseNpmCmdShim(SHIM, MODERN)
  );
});

test('bun and deno shims are accepted; other interpreters are not', () => {
  const bun = MODERN.replace(/node\.exe/g, 'bun.exe').replace('_prog=node', '_prog=bun');
  assert.equal(parseNpmCmdShim(SHIM, bun).interpreter, 'bun');

  const python = MODERN.replace(/node\.exe/g, 'python.exe').replace('_prog=node', '_prog=python');
  assert.equal(parseNpmCmdShim(SHIM, python), null, 'not an interpreter we are willing to spawn');
});

// ── everything we refuse to guess at falls back to the cmd.exe path ──────────

test('unrecognised content returns null rather than a guess', () => {
  const cases = {
    'empty': '',
    'not a shim at all': '@echo off\r\necho hello world\r\n',
    'a real batch script with %* but no quoted target': '@echo off\r\nmytool.exe %*\r\n',
    'no exec line': '@ECHO off\r\nSET dp0=%~dp0\r\n',
    'unmodelled variable in the target': '"%_prog%" "%SOMETHING%\\cli.js" %*',
    '%_prog% never assigned': '"%_prog%"  "%dp0%\\node_modules\\x\\cli.js" %*',
    'relative target': 'node "cli.js" %*',
    'non-JS target': '"%_prog%"  "%dp0%\\node_modules\\x\\bin\\tool.ps1" %*',
    'NUL byte': `@ECHO off\0\r\n"%_prog%" "%dp0%\\a.js" %*`,
    'too large to be a shim': `@ECHO off\r\n${'REM padding\r\n'.repeat(900)}"%_prog%" "%dp0%\\a.js" %*`
  };
  for (const [label, content] of Object.entries(cases)) {
    assert.equal(parseNpmCmdShim(SHIM, content), null, `should refuse: ${label}`);
  }
  assert.equal(parseNpmCmdShim('', MODERN), null, 'no shim path');
  assert.equal(parseNpmCmdShim(SHIM, null), null, 'non-string content');
});

test('interpreter flags between program and script are refused, never dropped', () => {
  // A shebang like `#!/usr/bin/env node --experimental-vm-modules` puts flags on
  // the shim's exec line. Silently discarding them would change how the CLI runs,
  // so this shape is handed back to the (unchanged) cmd.exe fallback instead.
  const withFlags = MODERN.replace(
    '"%_prog%"  "%dp0%',
    '"%_prog%" --experimental-vm-modules  "%dp0%'
  );
  assert.equal(parseNpmCmdShim(SHIM, withFlags), null);
});

test('the win32 branch is genuinely platform-gated', () => {
  // Proves the macOS/Linux spawn path is untouched: on any non-win32 host the shim
  // probe short-circuits before it ever looks at the filesystem.
  const mgr = new PtyManager();
  const probe = mgr['resolveWindowsShimSpawn'].bind(mgr);
  if (process.platform === 'win32') return; // the guard under test is the negative one
  assert.equal(probe(SHIM), null);
  assert.equal(probe(`${NPM_DIR}\\opencode`), null);
});

// ── the payload: does a hostile prompt actually survive? ─────────────────────

/** Everything about the injected hive prompt that breaks cmd.exe, in miniature:
 *  newlines, parentheses, embedded double quotes, a backslash run, `&`/`|`. */
const HOSTILE_PROMPT = [
  'You are "Michael" (god-1), an autonomous agent in a collaborating hive.',
  'Your private workspace is C:\\Users\\Tester\\.munder\\hive\\agents\\god-1.',
  '',
  'HIVE PROTOCOL — follow it every task:',
  '1. Read EVERY file in C:\\Users\\Tester\\.munder\\hive\\agents\\god-1\\inbox (messages',
  '   other agents sent you) & move handled ones to inbox\\.done.',
  '3. To ask another agent, write ONE message JSON into your outbox\\ (schema in',
  '   PROTOCOL.md) | NEVER write into another agent\'s folder.',
  'Trailing backslash torture: C:\\dir\\'
].join('\n');

/**
 * Parse a Windows command line back into argv the way CommandLineToArgvW / the
 * MSVC CRT does — 2n backslashes before a quote collapse to n and toggle quote
 * state, 2n+1 collapse to n plus a literal quote, and ONLY space/tab delimit.
 * This is the parser every child process on Windows effectively runs.
 */
function parseWindowsCommandLine(line) {
  const argv = [];
  let cur = '';
  let inQuotes = false;
  let started = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '\\') {
      let n = 0;
      while (line[i] === '\\') { n++; i++; }
      if (line[i] === '"') {
        cur += '\\'.repeat(n >> 1);
        if (n % 2 === 1) { cur += '"'; i++; } else { inQuotes = !inQuotes; i++; }
      } else {
        cur += '\\'.repeat(n);
      }
      started = true;
      continue;
    }
    if (c === '"') { inQuotes = !inQuotes; started = true; i++; continue; }
    if (!inQuotes && (c === ' ' || c === '\t')) {
      if (started) { argv.push(cur); cur = ''; started = false; }
      i++;
      continue;
    }
    cur += c;
    started = true;
    i++;
  }
  if (started) argv.push(cur);
  return argv;
}

test('ARRAY args: the whole prompt reaches the child intact', () => {
  const nodeExe = 'C:\\Program Files\\nodejs\\node.exe'; // spaces in argv[0] too
  const script = `${NPM_DIR}\\node_modules\\opencode-ai\\bin\\opencode.js`;
  const argv = [nodeExe, script, '--prompt', HOSTILE_PROMPT];

  const line = argsToCommandLine(nodeExe, argv.slice(1));
  assert.deepEqual(parseWindowsCommandLine(line), argv, 'CRT round-trip must be exact');
  assert.ok(line.includes('\n'), 'the newlines ride through as literal characters');
});

test('cmd.exe: the same prompt is destroyed — which is the bug', () => {
  const line = buildCmdCommandLine(`${NPM_DIR}\\opencode.cmd`, ['--prompt', HOSTILE_PROMPT]);

  // cmd.exe ends a statement at CR/LF regardless of quote state, so only the text
  // before the first newline is ever part of the command that runs.
  const firstStatement = line.split('\n')[0];
  assert.ok(line.includes('\n'), 'the argument really is multi-line');
  assert.ok(
    !firstStatement.includes('HIVE PROTOCOL'),
    'the protocol block never reaches the agent — this is why Windows agents could not message each other'
  );
  assert.ok(
    !firstStatement.includes('inbox'),
    'the agent is never told its inbox exists'
  );
  // Second, independent defect: cmd.exe has NO backslash escape. `\"` does not
  // embed a quote — the `\` is literal and the `"` TOGGLES quote state, so text
  // meant to be inside the quoted argument is actually parsed bare (where `&`,
  // `|`, `(`, `)` are live metacharacters). Model cmd's toggling directly: `/s`
  // strips the outer pair, then every `"` flips state.
  const inner = firstStatement.slice('/d /s /c "'.length);
  const atName = inner.indexOf('Michael');
  assert.ok(atName > 0);
  const quotesBefore = (inner.slice(0, atName).match(/"/g) || []).length;
  assert.equal(
    quotesBefore % 2,
    0,
    'the \\" produced here left cmd OUTSIDE quote state — it is not an escape, whatever the old comment claimed'
  );
});

test('single-line args still go through cmd.exe unchanged (fallback preserved)', () => {
  // The legacy path is untouched for everything the shim parser cannot decode.
  assert.equal(
    buildCmdCommandLine('C:\\Program Files\\x\\tool.cmd', ['--model', 'gpt-5-codex']),
    '/d /s /c ""C:\\Program Files\\x\\tool.cmd" --model gpt-5-codex"'
  );
});

/**
 * DIRECT-EXECUTABLE shims — the shape that broke OpenCode on Windows.
 *
 * npm writes an interpreter-less shim whenever a package's `bin` target has no
 * shebang, which is the norm for a compiled CLI. `opencode-ai` is exactly that:
 * its bin is `./bin/opencode.exe`, a real binary. The resolver only modelled
 * "interpreter + script", so it returned null for every Windows OpenCode install
 * and the spawn fell back to cmd.exe — which truncates the multi-line hive
 * protocol at its first newline. Agents booted looking healthy and had no idea
 * they had an inbox.
 *
 * The shim body below is not hand-written: it is the verbatim output of npm's own
 * `cmd-shim` package for a binary target.
 */
const DIRECT_EXE_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '"%dp0%\\..\\opencode-ai\\bin\\opencode.exe"   %*'
].join('\r\n');

test('a direct-executable shim resolves to the binary, with no interpreter', () => {
  const t = parseNpmCmdShim('C:\\Users\\r\\AppData\\Roaming\\npm\\opencode.cmd', DIRECT_EXE_SHIM);
  assert.ok(t, 'the shape npm generates for a binary bin must be understood');
  assert.equal(t.interpreter, null, 'null interpreter marks "run this directly"');
  assert.equal(
    t.scriptPath,
    'C:\\Users\\r\\AppData\\Roaming\\npm\\..\\opencode-ai\\bin\\opencode.exe'
      .replace(/\\[^\\]+\\\.\./, ''),
    'the target is expanded and normalized to an absolute path'
  );
});

test('the hive prompt survives a direct-executable shim, where cmd.exe destroys it', () => {
  const prompt = 'You are "Michael" (god-1), an autonomous agent.\n\nHIVE PROTOCOL\n- inbox\n- outbox';
  // What the fixed path does: spawn the binary with an ARRAY, escaped by node-pty.
  const line = argsToCommandLine('C:\\x\\opencode-ai\\bin\\opencode.exe', ['--prompt', prompt]);
  assert.ok(line.includes('HIVE PROTOCOL'), 'the protocol block reaches the child intact');
  assert.ok(line.includes('outbox'), 'including everything after the first newline');
  // What the old fallback did: one pre-escaped string handed to cmd.exe, which
  // treats the first newline as a statement separator.
  const viaCmd = buildCmdCommandLine('C:\\x\\opencode.cmd', ['--prompt', prompt]);
  assert.ok(viaCmd.split(/\r?\n/)[0].length < viaCmd.length, 'cmd.exe form is cut at a newline');
});

test('an interpreter-less shim pointing at a NON-executable is still refused', () => {
  const odd = DIRECT_EXE_SHIM.replace('opencode.exe', 'opencode.txt');
  assert.equal(parseNpmCmdShim('C:\\npm\\opencode.cmd', odd), null);
});
