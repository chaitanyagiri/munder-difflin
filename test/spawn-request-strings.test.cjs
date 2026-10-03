'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const { buildWorkerLaunch, normalizeSpawnRequestStrings } = require('./load-ts.cjs')('src/main/workerLaunch.ts');

// Execute the production intake and archive functions without booting Electron.
// Files and JSON decoding are real; CLI launch and external services are stubbed.
const text = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
const source = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true);
const names = ['spawnRequestsDir', 'archiveRequest', 'processSpawnRequest'];
const functions = names.map(name => {
  const node = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, `production function ${name} must exist`);
  return node.getText(source);
}).join('\n');
const output = ts.transpileModule(functions, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;

function harness(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md spawn request '));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const queue = path.join(home, 'spawn-requests');
  fs.mkdirSync(queue);
  const notices = [], launches = [], briefs = [], calls = [];
  const liveWorkers = new Map();
  const deps = {
    ...fs,
    join: path.join,
    basename: path.basename,
    isAbsolute: path.isAbsolute,
    liveWorkers,
    normalizeSpawnRequestStrings,
    buildWorkerLaunch,
    expandTilde: value => value.trim(),
    isSafeCommandName: value => /^[A-Za-z0-9._-]+$/.test(value),
    hive: { root: () => home, send: (...args) => briefs.push(args) },
    informGod: (...args) => notices.push(args),
    readConfig: () => { calls.push('config'); return { defaultCommand: 'claude', autoMode: false }; },
    ptyManager: { isCommandAvailable: () => { calls.push('CLI'); return true; } },
    getBranch: async () => { calls.push('git'); return { current: 'main' }; },
    integrationBroker: { running: () => { calls.push('broker'); return false; }, revoke: () => {} },
    spawnAgentCore: async opts => { launches.push(opts); return { ok: true }; },
    liveWebContents: () => undefined,
    buildAutonomousRequestProtocol: () => 'Slack task: ',
    slackReplyScriptPath: () => 'reply.js',
    console: { log: () => {}, error: () => {} }
  };
  const intake = new Function(...Object.keys(deps), `${output}\nreturn processSpawnRequest;`)(...Object.values(deps));
  const file = path.join(queue, 'demo.json');
  async function submit(extra = {}) {
    fs.writeFileSync(file, JSON.stringify({ objective: 'review the code', cwd: home, isolate: false, ...extra }));
    await intake(file);
  }
  return { home, queue, file, submit, intake, notices, launches, briefs, calls, liveWorkers };
}

async function rejected(t, overrides, field, code) {
  const h = harness(t);
  await h.submit(overrides);
  assert.equal(h.launches.length, 0, 'invalid request must never reach CLI launch');
  assert.equal(h.liveWorkers.size, 0, 'rejected input must not reserve the worker id');
  assert.deepEqual(h.calls, [], 'reject before config, CLI, git, or broker side effects');
  assert.equal(fs.existsSync(path.join(h.queue, '.failed', 'demo.json')), true);
  assert.equal(fs.existsSync(path.join(h.queue, '.done', 'demo.json')), false);
  assert.equal(h.notices.length, 1);
  assert.ok(h.notices[0][0].includes(field), 'diagnostic must name the affected field');
  assert.ok(h.notices[0][0].includes(code), 'diagnostic must identify the control code');
  return h;
}

test('rejects every C0 control except tab/LF, plus DEL, after JSON decoding', async t => {
  const codes = [...Array(32).keys(), 127].filter(code => code !== 9 && code !== 10);
  for (const code of codes) {
    await rejected(t, { objective: `Read C:/work/a${String.fromCharCode(code)}gents/brief.md` },
      'objective', `U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
  }
});

for (const field of ['id', 'cwd', 'name', 'command', 'model', 'provider', 'character', 'accent']) {
  test(`rejects controls in ${field} before starting a worker`, async t => {
    await rejected(t, { [field]: 'broken\u0007value' }, field, 'U+0007');
  });
}

test('checks nested objects and arrays, including unknown request fields', async t => {
  const h = await rejected(t, { extra: [{ options: { path: 'SECRET-PAYLOAD\u0008suffix' } }] },
    'request["extra"][0]["options"]["path"]', 'U+0008');
  assert.doesNotMatch(JSON.stringify(h.notices), /SECRET-PAYLOAD/);
});

test('reports unique control codes without echoing the decoded string', async t => {
  const h = await rejected(t, { objective: 'SECRET\u0007\u0008\u000c\u0007' }, 'objective', 'U+0007');
  const reason = h.notices[0][0];
  assert.match(reason, /U\+0007, U\+0008, U\+000C/);
  assert.equal((reason.match(/U\+0007/g) || []).length, 1);
  assert.doesNotMatch(reason, /SECRET/);
});

test('rejects corrupted Slack coordinates without passing them to the rejection notifier', async t => {
  const h = await rejected(t, { slack: { channel: 'C\u000b123', thread_ts: '123.456' } },
    'channel', 'U+000B');
  assert.equal(h.notices[0][2], undefined);
});

test('valid Slack coordinates still receive the failure for an invalid objective', async t => {
  const slack = { channel: 'C123', thread_ts: '123.456' };
  const h = await rejected(t, { objective: 'broken\u0007brief', slack }, 'objective', 'U+0007');
  assert.deepEqual(h.notices[0][2], slack);
});

test('a corrected request under the same filename can start after rejection', async t => {
  const h = await rejected(t, { objective: 'bad\u0007path' }, 'objective', 'U+0007');
  await h.submit({ objective: 'Read the corrected path' });
  assert.equal(h.launches.length, 1);
  assert.equal(h.launches[0].id, 'worker-demo');
  assert.equal(h.liveWorkers.size, 1);
  assert.equal(fs.existsSync(path.join(h.queue, '.done', 'demo.json')), true);
  assert.equal(h.notices.length, 1, 'corrected request must not be rejected as already running');
  assert.match(h.briefs[0][0].body, /Read the corrected path/);
});

test('allows LF, tabs, Unicode, and literal Windows backslashes while normalizing CRLF', async t => {
  const h = harness(t);
  await h.submit({
    objective: 'Read C:\\work\\agents\\brief.md\r\n然后评审\t✓\nfinish',
    name: 'Worker\r\nReview',
    extra: [{ note: 'one\r\ntwo' }]
  });
  assert.equal(h.launches.length, 1);
  assert.equal(h.notices.length, 0);
  assert.match(h.briefs[0][0].body, /C:\\work\\agents\\brief\.md\n然后评审\t✓\nfinish/);
  assert.equal(h.launches[0].hive.name, 'Worker\nReview');
});

test('clean requests retain command, model, provider, and Slack dispatch behavior', async t => {
  const h = harness(t);
  await h.submit({ command: 'codex --verbose', provider: 'codex', model: 'model-x',
    slack: { channel: 'C123', thread_ts: '123.456' } });
  assert.equal(h.launches[0].command, 'codex');
  assert.deepEqual(h.launches[0].args, ['--verbose', '--model', 'model-x']);
  assert.equal(h.launches[0].provider, 'codex');
  assert.match(h.briefs[0][0].body, /^Slack task: review the code/);
  assert.equal(h.notices.length, 0);
});

test('non-object JSON is archived and reported instead of crashing intake', async t => {
  for (const raw of [null, [], 'text', 42]) {
    const h = harness(t);
    fs.writeFileSync(h.file, JSON.stringify(raw));
    await h.intake(h.file);
    assert.equal(h.launches.length, 0);
    assert.equal(h.notices.length, 1);
    assert.match(h.notices[0][0], /JSON object/);
    assert.equal(fs.existsSync(path.join(h.queue, '.failed', 'demo.json')), true);
  }
});

test('normalizes nested strings without changing non-string values or introducing inherited properties', () => {
  const raw = JSON.parse('{"extra":[{"note":"a\\r\\nb","flag":false,"cap":12,"empty":null}],"__proto__":"a\\r\\nb"}');
  assert.equal(normalizeSpawnRequestStrings(raw), undefined);
  assert.equal(raw.extra[0].note, 'a\nb');
  assert.equal(raw.extra[0].flag, false);
  assert.equal(raw.extra[0].cap, 12);
  assert.equal(raw.extra[0].empty, null);
  assert.equal(raw.__proto__, 'a\nb');
  assert.equal(Object.getPrototypeOf(raw), Object.prototype);
});

test('checks deeply nested JSON without recursive stack overflow', () => {
  const raw = {};
  let leaf = raw;
  for (let i = 0; i < 2000; i++) { leaf.child = {}; leaf = leaf.child; }
  leaf.value = 'bad\u0007text';
  assert.match(normalizeSpawnRequestStrings(raw), /U\+0007/);
});
