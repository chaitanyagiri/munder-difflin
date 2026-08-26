'use strict';
/**
 * Per-agent Talk — the LIVE relay return path (transcript → store → relay).
 *
 * A3 ("the human asks, the session answers, the voice speaks the answer") shipped
 * green with 558/558 passing and failed on every real agent. The reason is worth
 * pinning forever: the relay in realtime/agentVoice.ts waits for the store fields
 * `recentAssistantText` + `recentTextTs` to advance, and the ONLY writer of
 * `recentAssistantText` was store/mockEvents.ts. Under mocks the loop closed; in
 * the live app the `hive:activity` stream carries status/tool metadata and never
 * the words, so the relay always ran out its timer and the voice said "still
 * working" to answers that had already landed.
 *
 * So the test that matters is not "does the relay read the field" — it did — but
 * "does anything LIVE produce it". These tests therefore:
 *   1. run the real producer (main/transcript.ts, no mocks) over a real Claude
 *      Code JSONL transcript written to disk, and
 *   2. drive the exact wait condition from agentVoice.ts with the store values
 *      the renderer poll derives from that producer, and
 *   3. assert the wire between them still exists end to end, and that the mock
 *      generator is not the only writer again.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

// Sandbox HOME: transcript.ts resolves ~/.claude/projects per call, and nothing
// here may touch the real one.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

const ROOT = path.join(__dirname, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'talk-relay-'));
for (const name of ['pricing', 'transcript']) {
  const js = ts.transpileModule(fs.readFileSync(path.join(ROOT, 'src', 'main', `${name}.ts`), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
  }).outputText;
  fs.writeFileSync(path.join(out, `${name}.js`), js, 'utf8');
}
const { readLatestAssistantText } = require(path.join(out, 'transcript.js'));

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const agentVoice = read('src/renderer/src/realtime/agentVoice.ts');
const useHive = read('src/renderer/src/hooks/useHive.ts');
const preload = read('src/preload/index.ts');
const mainIndex = read('src/main/index.ts');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

/** A transcript file we can append real Claude Code records to. */
function makeTranscript() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-'));
  return path.join(dir, `${'a'.repeat(8)}-session.jsonl`);
}

/** One real-shaped assistant record: content is a block array, text lives in
 *  `text` blocks, thinking and tool_use blocks sit alongside it. */
function assistantRec(blocks, opts = {}) {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: opts.isSidechain ?? false,
    timestamp: opts.timestamp ?? '2026-08-26T01:40:00.000Z',
    sessionId: 's1',
    message: { model: 'claude-opus-5', role: 'assistant', content: blocks, usage: { input_tokens: 1, output_tokens: 1 } }
  }) + '\n';
}
const textBlock = (text) => ({ type: 'text', text });

/** The renderer poll (useHive 2c-bis), reduced to what it does to the store. */
function pollIntoStore(agent, transcriptPath) {
  const latest = readLatestAssistantText(transcriptPath);
  if (!latest || !latest.text.trim() || !Number.isFinite(latest.ts)) return agent;
  if (agent.recentAssistantText === latest.text && agent.recentTextTs === latest.ts) return agent;
  return { ...agent, recentAssistantText: latest.text, recentTextTs: latest.ts };
}

/** The relay's wait condition, verbatim from agentVoice.ts:168. */
function relaySees(agent, before) {
  return (agent.recentTextTs ?? 0) > before && !!(agent.recentAssistantText && agent.recentAssistantText.trim());
}

// --- 1. the producer reads real transcript text ----------------------------

test('producer lifts the latest assistant text out of a live transcript', () => {
  const tp = makeTranscript();
  fs.writeFileSync(tp, assistantRec([textBlock('First turn.')], { timestamp: '2026-08-26T01:40:00.000Z' }));
  const first = readLatestAssistantText(tp);
  assert.strictEqual(first.text, 'First turn.');
  assert.strictEqual(first.ts, Date.parse('2026-08-26T01:40:00.000Z'));
});

test('producer returns null before the session has spoken', () => {
  const tp = makeTranscript();
  assert.strictEqual(readLatestAssistantText(tp), null, 'no transcript yet');
  fs.writeFileSync(tp, JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n');
  assert.strictEqual(readLatestAssistantText(tp), null, 'user records are not the session speaking');
});

test('producer skips thinking, tool_use and sidechain records', () => {
  const tp = makeTranscript();
  fs.writeFileSync(tp, assistantRec([textBlock('The real answer.')], { timestamp: '2026-08-26T01:40:00.000Z' }));
  // A tool-only turn and a subagent's chatter must not shadow the real answer.
  fs.appendFileSync(tp, assistantRec(
    [{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', name: 'Bash', input: {} }],
    { timestamp: '2026-08-26T01:41:00.000Z' }
  ));
  fs.appendFileSync(tp, assistantRec([textBlock('Subagent noise.')], { timestamp: '2026-08-26T01:42:00.000Z', isSidechain: true }));
  assert.strictEqual(readLatestAssistantText(tp).text, 'The real answer.');
});

test('producer joins multiple text blocks and survives a torn trailing line', () => {
  const tp = makeTranscript();
  fs.writeFileSync(tp, assistantRec([textBlock('Part one.'), textBlock('Part two.')]));
  fs.appendFileSync(tp, '{"type":"assistant","message":{"content":[{"type":"tex');
  assert.strictEqual(readLatestAssistantText(tp).text, 'Part one.\n\nPart two.');
});

// --- 2. the full return path: transcript → store → relay condition ---------

test('END TO END: a session reply reaches the relay wait condition', () => {
  const tp = makeTranscript();
  fs.writeFileSync(tp, assistantRec([textBlock('Earlier turn.')], { timestamp: '2026-08-26T01:40:00.000Z' }));

  // The store row as the renderer holds it once the agent is up.
  let agent = pollIntoStore({ id: 'dwight-1' }, tp);
  assert.strictEqual(agent.recentAssistantText, 'Earlier turn.');

  // ask_my_session snapshots recentTextTs, relays, then polls.
  const before = agent.recentTextTs ?? 0;
  assert.strictEqual(relaySees(pollIntoStore(agent, tp), before), false,
    'nothing new said yet — the relay must keep waiting');

  // The session answers. Its record lands in the transcript…
  fs.appendFileSync(tp, assistantRec([textBlock('Yes — the fix is on branch dwight.')], { timestamp: '2026-08-26T01:43:00.000Z' }));
  // …the poll lifts it into the store…
  agent = pollIntoStore(agent, tp);
  // …and the relay's condition now fires with the session's actual words.
  assert.ok(relaySees(agent, before), 'the relay must see the new reply — this is the A3 bug');
  assert.strictEqual(agent.recentAssistantText, 'Yes — the fix is on branch dwight.');
  assert.ok(agent.recentTextTs > before);
});

test('a repeated identical reply still advances the timestamp for the next relay', () => {
  const tp = makeTranscript();
  fs.writeFileSync(tp, assistantRec([textBlock('Still working on it.')], { timestamp: '2026-08-26T01:40:00.000Z' }));
  let agent = pollIntoStore({ id: 'dwight-1' }, tp);
  const before = agent.recentTextTs;
  fs.appendFileSync(tp, assistantRec([textBlock('Still working on it.')], { timestamp: '2026-08-26T01:44:00.000Z' }));
  agent = pollIntoStore(agent, tp);
  assert.ok(relaySees(agent, before), 'same words, later turn — the relay must not stall on it');
});

// --- 3. the wire stays connected ------------------------------------------
// The A3 failure was a MISSING link, not a wrong one; each assertion below is a
// link that, if it disappears, silently returns the feature to "green in mocks,
// dead in the app".

test('the live producer is wired transcript → IPC → preload → store', () => {
  assert.ok(/export function readLatestAssistantText/.test(read('src/main/transcript.ts')),
    'main/transcript.ts must expose the producer');
  assert.ok(mainIndex.includes("ipcMain.handle('hive:agentLatestText'") && mainIndex.includes('readLatestAssistantText('),
    'main must serve the producer over IPC');
  assert.ok(preload.includes('agentLatestText:') && preload.includes("'hive:agentLatestText'"),
    'preload must expose agentLatestText on window.cth');
  assert.ok(/agentLatestText\(/.test(useHive) && /recentAssistantText:/.test(useHive),
    'useHive must poll it and write recentAssistantText into the store');
});

test('mockEvents is not the only writer of recentAssistantText', () => {
  const writers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && /recentAssistantText\s*:/.test(fs.readFileSync(p, 'utf8'))) {
        writers.push(path.relative(ROOT, p));
      }
    }
  };
  walk(path.join(ROOT, 'src', 'renderer', 'src'));
  const live = writers.filter((w) => !w.includes('mockEvents') && !w.includes('store/store.ts'));
  assert.ok(live.length > 0,
    `recentAssistantText is written only by ${writers.join(', ')} — the live relay would time out again`);
});

test('the relay wait is long enough for a real Claude Code turn', () => {
  const m = agentVoice.match(/const RELAY_WAIT_MS = ([\d_]+);/);
  assert.ok(m, 'RELAY_WAIT_MS must be declared');
  const ms = Number(m[1].replaceAll('_', ''));
  assert.ok(ms >= 60_000, `RELAY_WAIT_MS is ${ms}ms — a tool-using turn routinely outlives that`);
});

test('the read side of the relay is unchanged', () => {
  // Pam verified the read side is correct; the fix was the producer. If this
  // condition is ever reworded, the poll above must be re-checked against it.
  assert.ok(
    agentVoice.includes("(now.recentTextTs ?? 0) > before && now.recentAssistantText?.trim()"),
    'the relay wait condition moved — re-verify pollIntoStore/relaySees against it'
  );
});

console.log(failures ? `\n${failures} failure(s)` : '\nall talk-relay live-path tests passed');
process.exit(failures ? 1 : 0);
