'use strict';

/**
 * The agent-facing text the hive injects has to be runnable BY THE AGENT, on the
 * platform the agent is running on. Two habits were silently Windows-only breakage:
 *
 *  - POSIX `$VAR` references (`"$HIVE_NODE" "$KG_CLI" search …`, the Slack reply
 *    command). Under cmd.exe `$FOO` expands to nothing and under PowerShell to an
 *    undefined variable, so those instructions were dead on every Windows floor.
 *  - String-concatenated separators (`${dir}/inbox/`), which told a Windows agent
 *    to read `C:\Users\x\hive\agents\god-1/inbox/`.
 *
 * And the prompt itself must survive the spawn: it is passed on argv, is multi-line
 * and paren/quote-heavy, and on Windows now rides node-pty's CRT escaping rather
 * than cmd.exe's parser (see win-cmd-shim.test.cjs for that half).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { argsToCommandLine } = require('node-pty/lib/windowsPtyAgent.js');

const KG_CLI = path.join('/Applications', 'Munder Difflin.app', 'Contents', 'Resources', 'kg.cjs');

async function floor(t, opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-winprompt-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  const inj = await hive.ensureAgent(
    { id: 'god-1', name: 'Michael', provider: opts.provider ?? 'claude', cwd: home, isGod: true },
    { semanticMemory: true, knowledgeGraph: true, kgCliPath: KG_CLI, ...(opts.injectOpts ?? {}) }
  );
  return { home, hive, inj, dir: path.join(home, 'hive', 'agents', 'god-1'), root: path.join(home, 'hive') };
}

/** The injected system prompt, whichever flag this provider carries it on. */
function promptOf(inj) {
  const i = inj.args.findIndex((a) => a === '--append-system-prompt' || a === '--prompt');
  assert.ok(i >= 0, 'the hive protocol must be on argv');
  return inj.args[i + 1];
}

test('no POSIX shell variables survive into agent-facing text', async (t) => {
  const { inj } = await floor(t);
  const prompt = promptOf(inj);
  for (const dead of ['$HIVE_NODE', '$KG_CLI', '$KG_ROOT', '$MEMPALACE_PALACE_PATH']) {
    assert.ok(!prompt.includes(dead), `${dead} expands to nothing under cmd.exe/PowerShell`);
  }
});

test('the knowledge-graph command carries absolute paths, not variables', async (t) => {
  const { inj, hive } = await floor(t);
  const prompt = promptOf(inj);
  assert.ok(prompt.includes(`"${hive.nodeCommand()}" "${KG_CLI}" search`), 'runnable as written');
  assert.ok(path.isAbsolute(hive.nodeCommand()), 'the bundled-node launcher is baked absolute');
});

test('the KG line degrades to the env-var spelling when no path is supplied', async (t) => {
  // Never emit a broken command: with no resolved CLI path we fall back to the
  // old spelling rather than interpolating `undefined` into the instruction.
  const { inj } = await floor(t, { injectOpts: { kgCliPath: undefined } });
  const prompt = promptOf(inj);
  assert.ok(!prompt.includes('undefined'));
  assert.ok(prompt.includes(process.platform === 'win32' ? '%KG_CLI%' : '$KG_CLI'));
});

test('protocol paths use native separators the agent can actually use', async (t) => {
  const { inj, dir, root } = await floor(t);
  const prompt = promptOf(inj);
  for (const p of [
    path.join(dir, 'memory.md'),
    path.join(dir, 'inbox'),
    path.join(dir, 'inbox', '.done'),
    path.join(dir, 'outbox'),
    path.join(root, 'PROTOCOL.md'),
    path.join(root, 'fleet.json'),
    path.join(root, 'registry.json')
  ]) {
    assert.ok(prompt.includes(p), `missing native-separator path: ${p}`);
  }
  // The old form concatenated literal `/` onto a native dir, which on win32 read
  // `C:\…\god-1/inbox/`. Pin the exact old spellings so a regression fails HERE,
  // on macOS, where this code is actually written — they differ from the new text
  // on POSIX too (the trailing slash is gone).
  for (const old of ['/inbox/ (messages', '/inbox/.done/.', '/outbox/ (schema']) {
    assert.ok(!prompt.includes(old), `old mixed-separator form leaked back in: ${old}`);
  }
  if (path.sep === '\\') {
    assert.ok(!prompt.includes(`${dir}/`), 'mixed-separator path leaked back in');
    assert.ok(!prompt.includes(`${root}/`), 'mixed-separator path leaked back in');
  }
});

test('the Stop-hook drain text uses native separators too', async (t) => {
  const { hive, dir } = await floor(t);
  hive.send({ to: 'god-1', act: 'request', subject: 'ping', body: 'hello' }, 'tester');
  const { block, reason } = hive.drainForStop('god-1');
  assert.equal(block, true);
  assert.ok(reason.includes(path.join(dir, 'inbox')));
  assert.ok(reason.includes(path.join(dir, 'inbox', '.done')));
  assert.ok(!reason.includes('/inbox/ for full detail'), 'old mixed-separator form');
  assert.ok(!reason.includes('inbox/.done/'), 'old mixed-separator form');
});

test('the injected prompt survives the Windows ARRAY argv path byte for byte', async (t) => {
  const { inj } = await floor(t);
  const prompt = promptOf(inj);
  // Sanity: this really is the hostile shape (cmd.exe truncates at the first
  // newline and reads the parens as block delimiters).
  assert.ok(prompt.split('\n').length > 5, 'multi-line');
  assert.ok(prompt.includes('(') && prompt.includes('"'), 'paren- and quote-bearing');

  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const script = 'C:\\Users\\Tester\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.js';
  const line = argsToCommandLine(node, [script, '--prompt', prompt]);
  // Newlines ride through CreateProcess as literal characters inside one quoted
  // CRT argument; nothing is truncated and nothing needs a shell.
  assert.ok(line.includes('\n'));
  assert.ok(line.includes('HIVE PROTOCOL'));
  const quotedArg = line.slice(line.indexOf('--prompt') + '--prompt '.length);
  assert.equal(
    quotedArg.slice(1, -1).replace(/\\"/g, '"'),
    prompt,
    'the child CRT un-escapes back to exactly the prompt we injected'
  );
});

test('the god prompt requires a local human-facing result handoff', async (t) => {
  const { home, hive, inj } = await floor(t);
  const godPrompt = promptOf(inj);
  assert.match(godPrompt, /LOCAL TASK HANDOFF/);
  assert.match(godPrompt, /result/);
  assert.match(godPrompt, /RESULT: DONE/);
  assert.match(godPrompt, /RESULT: BLOCKED/);
  assert.match(godPrompt, /humanQA/);

  const worker = await hive.ensureAgent({
    id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home
  });
  assert.doesNotMatch(promptOf(worker), /LOCAL TASK HANDOFF/);
});

test('the OpenCode plugin lands in BOTH plugin/ and plugins/', async (t) => {
  // Which directory the installed OpenCode scans is version-dependent and the
  // bridge is LIVE-UNVERIFIED; writing both is cheap and removes the coin flip.
  const { dir } = await floor(t, { provider: 'opencode' });
  for (const name of ['plugin', 'plugins']) {
    const p = path.join(dir, '.opencode', name, 'hive-bridge.js');
    assert.ok(fs.existsSync(p), `missing ${p}`);
    assert.ok(fs.readFileSync(p, 'utf8').includes('HIVE_SOCK'), 'must be the real bridge');
  }
});

test('OpenCode carries the protocol on --prompt, so the argv fix is what delivers it', async (t) => {
  const { inj } = await floor(t, { provider: 'opencode' });
  assert.ok(inj.args.includes('--prompt'));
  assert.ok(promptOf(inj).includes('HIVE PROTOCOL'));
});
