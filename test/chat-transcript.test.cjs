'use strict';

/**
 * The Chat tab shows the conversation — what the human typed and what the agent
 * answered — and nothing else. Two things can break that promise, and both are
 * silent when they do:
 *
 *   1. Text the HARNESS types into an agent looks exactly like a human prompt
 *      once it reaches the transcript: the identity/protocol brief injected at
 *      spawn, the inbox-wake nudge, the `/compact` from the context cap. Only a
 *      fixed pattern tells them apart, so each pattern is pinned here together
 *      with the writer that produces it — a reworded brief that stops matching
 *      would put a wall of protocol text back in the user's chat window.
 *
 *   2. The transcript is FULL of tool traffic (file reads, command output). A
 *      reader that stops stripping it does not fail, it just floods the tab.
 *
 * The OpenCode half of the tab cannot be exercised here (its reader opens
 * better-sqlite3, a native module built for Electron's ABI), so what this file
 * can hold for it is the seam the whole feature hangs from: the bridge plugin
 * reporting a session id. Without it there is no way to find the conversation
 * in OpenCode's store, and the tab is empty for every OpenCode agent.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const { isAppGeneratedPrompt, readChatTranscript } = loadTs('src/main/chatTranscript.ts');
const { HIVE_PROTOCOL_HEADING, isHiveIdentityPrompt } = loadTs('src/shared/hivePrompt.ts');
const { inboxNudgeText } = loadTs('src/shared/hiveNudge.ts');

// A brief in the shape buildIdentity() emits: per-agent name/paths around the
// one fixed heading. Two different agents share nothing BUT that heading, which
// is why it is the anchor.
const brief = (name, id) => [
  `You are "${name}" (${id}), an autonomous agent in a collaborating hive of Claude agents.`,
  `Your private workspace is C:\\hive\\agents\\${id}. The shared hive is C:\\hive.`,
  '',
  HIVE_PROTOCOL_HEADING,
  '1. At the START of a task, read memory.md and EVERY file in inbox.',
  'Env vars available to you: AGENT_ID, AGENT_NAME, HIVE_ROOT, AGENT_DIR.'
].join('\n');

// — what the app types is not what the human said —

test('the spawn brief is recognised whatever agent it was built for', () => {
  for (const [name, id] of [['Michael', 'god'], ['Andi', 'dev1-mtsv8xwb'], ['أليكس', 'rev-1']]) {
    assert.equal(isHiveIdentityPrompt(brief(name, id)), true, `${name}/${id}`);
    assert.equal(isAppGeneratedPrompt(brief(name, id)), true, `${name}/${id}`);
  }
});

test('the identity builder takes the heading from the shared marker', () => {
  // The predicate above matches a literal. If hive.ts spells that literal out a
  // second time, the two drift on the first reword and the brief silently
  // reappears in every non-Claude agent's chat window.
  const hive = read('src/main/hive.ts');
  assert.match(hive, /import \{ HIVE_PROTOCOL_HEADING \} from '\.\.\/shared\/hivePrompt'/);
  assert.match(hive, /^\s*HIVE_PROTOCOL_HEADING,$/m);
  assert.equal(hive.includes(`'${HIVE_PROTOCOL_HEADING}'`), false,
    'hive.ts still hardcodes the protocol heading next to the shared marker');
});

test('the nudge and the compaction command are filtered too', () => {
  assert.equal(isAppGeneratedPrompt(inboxNudgeText([])), true);
  assert.equal(isAppGeneratedPrompt(inboxNudgeText(['2026-09-08T13-48-02-836Z-f8d047'])), true);
  assert.equal(isAppGeneratedPrompt('/compact keep the auth decisions'), true);
});

test('an ordinary prompt is never mistaken for one of them', () => {
  for (const human of [
    'bist du bereit ? sind alle agenten am laufen ?',
    'read your inbox please',                 // the nudge's subject, not its text
    'we should compact this function',        // mentions it, does not command it
    'what does the hive protocol say about reviews?'
  ]) {
    assert.equal(isAppGeneratedPrompt(human), false, human);
  }
});

// — the reader itself —

const line = (type, content, ts) => JSON.stringify({
  type, message: { content }, timestamp: new Date(ts).toISOString()
}) + '\n';

function fixture(name, body) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'md-chat-')), name);
  fs.writeFileSync(p, body, 'utf8');
  return p;
}

test('tool traffic is stripped and only real turns survive', () => {
  const p = fixture('t.jsonl', [
    line('user', brief('Michael', 'god'), 1),
    line('user', [{ type: 'text', text: 'wie weit bist du ?' }], 2),
    // A turn that is nothing but a tool call, and a tool result coming back —
    // the bulk of any real transcript, and none of it a conversation turn.
    line('assistant', [{ type: 'tool_use', name: 'Read', input: { file: 'a.ts' } }], 3),
    line('user', [{ type: 'tool_result', content: 'file contents' }], 4),
    line('assistant', [{ type: 'text', text: '11 von 33 Schritten.' }], 5),
    line('user', inboxNudgeText(['abc']), 6),
    line('summary', 'not a turn at all', 7)
  ].join(''));

  assert.deepEqual(readChatTranscript(p).map((m) => [m.role, m.text]), [
    ['user', 'wie weit bist du ?'],
    ['assistant', '11 von 33 Schritten.']
  ]);
});

test('a torn trailing line is picked up once the writer completes it', () => {
  // The reader tails a file another process is appending to, so it must never
  // parse a half-written line — nor lose it.
  const p = fixture('grow.jsonl', line('user', [{ type: 'text', text: 'eins' }], 1));
  fs.appendFileSync(p, '{"type":"assistant","message":{"content":[{"type":"te');
  assert.deepEqual(readChatTranscript(p).map((m) => m.text), ['eins']);

  fs.appendFileSync(p, 'xt","text":"zwei"}]},"timestamp":"2026-09-08T00:00:02.000Z"}\n');
  assert.deepEqual(readChatTranscript(p).map((m) => m.text), ['eins', 'zwei']);
});

test('a missing transcript is an empty conversation, not a crash', () => {
  assert.deepEqual(readChatTranscript(path.join(os.tmpdir(), 'md-chat-nope', 'x.jsonl')), []);
});

// — the OpenCode seam —

test('the bridge plugin reports the session id on every payload it posts', () => {
  // OpenCode keeps its turns in its own store, addressed by session id; the
  // plugin is the only thing that knows which session an agent is in. Dropping
  // the field empties the Chat tab for every OpenCode agent, and nothing else
  // in the app notices, because the id has no other consumer.
  const plugin = read('src/main/hive.ts').split('const OPENCODE_PLUGIN = `')[1] ?? '';
  assert.notEqual(plugin, '', 'OPENCODE_PLUGIN template not found');
  for (const hook of ['tool.execute.before', 'tool.execute.after']) {
    const body = plugin.split(`'${hook}'`)[1]?.slice(0, 400) ?? '';
    assert.match(body, /session_id: input && input\.sessionID/, hook);
  }
  assert.match(plugin, /session\.idle'\) post\(\{ hook_event_name: 'Stop', session_id: sid \}\)/);
});

test('the hook server keeps the session id out of the registry', () => {
  // recordSession() owns the registry's resume key. The chat lane only reads, so
  // it captures the id into its own map — before the Status early-return, so a
  // telemetry-only payload still carries it.
  const hooks = read('src/main/hooks.ts');
  const capture = hooks.indexOf('this.sessionIds.set(agentId, p.session_id)');
  const statusArm = hooks.indexOf("if (event === 'Status')");
  const record = hooks.indexOf('this.hive.recordSession(agentId, p.session_id)');
  assert.ok(capture > 0 && statusArm > 0 && record > 0, 'expected all three call sites');
  assert.ok(capture < statusArm, 'session id must be captured before the Status early-return');
  assert.ok(statusArm < record, 'recordSession must stay behind the Status early-return');
});

test('a provider with no readable conversation is reported, not left waiting', () => {
  const { chatSourceOf } = loadTs('src/shared/agentProvider.ts');
  assert.equal(chatSourceOf('opencode'), 'opencode');
  assert.equal(chatSourceOf('claude'), 'transcript');
  assert.equal(chatSourceOf('antigravity'), 'transcript');  // its shim forwards transcriptPath
  for (const p of ['codex', 'grok', 'kimi', 'gemini', 'qwen', 'crush', 'pi', 'copilot', 'cursor', 'custom']) {
    assert.equal(chatSourceOf(p), null, p);
  }

  // Antigravity is in the readable set ONLY because its shim reports the path.
  // If that ever stops, the tab goes back to a permanently empty "nothing yet".
  const agyShim = read('src/main/hive.ts').split('const AGY_HOOK_SHIM = `')[1] ?? '';
  assert.match(agyShim, /transcript_path: agy\.transcriptPath/);
});
