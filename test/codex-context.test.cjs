'use strict';
/**
 * Codex rollout-log context-gauge backfill (see src/main/codexContext.ts).
 *
 * Claude context updates can arrive through status hooks or the renderer's
 * transcript backfill. Codex rollout logs are a third provider-specific input
 * that can supply the same gauge without changing telemetry accounting.
 *
 * Line shapes below are trimmed/sanitized from a real `rollout-*.jsonl`
 * produced by a live Codex worker (`token_count` event, `info.last_token_usage`
 * / `info.model_context_window`), not invented.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  clearCodexContextCache,
  findLatestCodexRollout,
  readLatestTokenCount,
  readCodexContext,
  readCodexRegistryContexts
} =
  loadTs('src/main/codexContext.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

function tokenCountLine(inputTokens, contextWindow, ts) {
  return JSON.stringify({
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: inputTokens, output_tokens: 10, total_tokens: inputTokens + 10 },
        last_token_usage: { input_tokens: inputTokens, output_tokens: 10, total_tokens: inputTokens + 10 },
        model_context_window: contextWindow
      },
      rate_limits: { limit_id: 'codex' }
    }
  });
}

/** A realistic non-token_count line (a tool call), so tests exercise a mixed
 *  rollout rather than a synthetic file of nothing but token_count events. */
function functionCallLine(name) {
  return JSON.stringify({
    timestamp: '2026-09-15T09:16:30.919Z',
    type: 'response_item',
    payload: { type: 'function_call', name, arguments: '{}', call_id: 'call_x' }
  });
}

const tempDirs = new Set();

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-context-test-'));
  tempDirs.add(dir);
  return dir;
}

test.afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(fs.existsSync(dir), false, `removed temporary directory ${dir}`);
  }
  tempDirs.clear();
  clearCodexContextCache?.();
});

test('findLatestCodexRollout returns null when the agent has no Codex session data yet', () => {
  const cwd = tempRepo();
  assert.equal(findLatestCodexRollout(cwd), null);
});

test('findLatestCodexRollout finds a rollout nested under sessions/YYYY/MM/DD', () => {
  const codexHome = tempRepo();
  const dir = path.join(codexHome, 'sessions', '2026', '09', '15');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'rollout-2026-09-15T08-00-00-abc.jsonl');
  fs.writeFileSync(file, tokenCountLine(1000, 258400, '2026-09-15T08:00:00.000Z') + '\n', 'utf8');
  assert.equal(findLatestCodexRollout(codexHome), file);
});

test('findLatestCodexRollout picks the most recently modified file across multiple sessions', () => {
  const codexHome = tempRepo();
  const day1 = path.join(codexHome, 'sessions', '2026', '09', '14');
  const day2 = path.join(codexHome, 'sessions', '2026', '09', '15');
  fs.mkdirSync(day1, { recursive: true });
  fs.mkdirSync(day2, { recursive: true });
  const older = path.join(day1, 'rollout-2026-09-14T08-00-00-old.jsonl');
  const newer = path.join(day2, 'rollout-2026-09-15T08-00-00-new.jsonl');
  fs.writeFileSync(older, tokenCountLine(500, 258400, '2026-09-14T08:00:00.000Z') + '\n', 'utf8');
  // Force a distinct, later mtime regardless of how fast the two writes ran.
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(older, past, past);
  fs.writeFileSync(newer, tokenCountLine(9000, 258400, '2026-09-15T08:00:00.000Z') + '\n', 'utf8');
  assert.equal(findLatestCodexRollout(codexHome), newer);
});

test('readLatestTokenCount reads the real event shape (payload.info.last_token_usage / model_context_window)', () => {
  const cwd = tempRepo();
  const file = path.join(cwd, 'rollout.jsonl');
  fs.writeFileSync(file, tokenCountLine(17724, 258400, '2026-09-15T08:09:58.124Z') + '\n', 'utf8');
  assert.deepEqual(readLatestTokenCount(file), { tokens: 17724, limit: 258400 });
});

test('readLatestTokenCount returns the LAST token_count in a mixed, multi-turn file', () => {
  const cwd = tempRepo();
  const file = path.join(cwd, 'rollout.jsonl');
  const lines = [
    tokenCountLine(17724, 258400, '2026-09-15T08:09:58.124Z'),
    functionCallLine('exec'),
    functionCallLine('apply_patch'),
    tokenCountLine(45000, 258400, '2026-09-15T09:00:00.000Z'),
    functionCallLine('wait'),
    tokenCountLine(90603, 258400, '2026-09-15T14:09:33.383Z')
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  assert.deepEqual(readLatestTokenCount(file), { tokens: 90603, limit: 258400 });
});

test('readLatestTokenCount finds the last reading even when the tail window must be re-scanned', () => {
  // Force a tail window that lands mid-file (smaller than the whole fixture,
  // but comfortably larger than the final line) so the "drop the possibly
  // partial first line of the window" behavior is actually exercised, not
  // just theoretical.
  const cwd = tempRepo();
  const file = path.join(cwd, 'rollout.jsonl');
  const padding = 'x'.repeat(2000);
  const lines = [
    tokenCountLine(1000, 258400, '2026-09-15T08:00:00.000Z'),
    functionCallLine(padding),
    tokenCountLine(2000, 258400, '2026-09-15T08:05:00.000Z')
  ];
  const content = lines.join('\n') + '\n';
  fs.writeFileSync(file, content, 'utf8');
  const lastLineBytes = Buffer.byteLength(lines[lines.length - 1], 'utf8');
  const tailBytes = lastLineBytes + 20; // fits the final line, cuts into the one before it
  assert.ok(tailBytes < Buffer.byteLength(content, 'utf8'), 'the window must actually land mid-file');
  assert.deepEqual(readLatestTokenCount(file, tailBytes), { tokens: 2000, limit: 258400 });
});

test('readLatestTokenCount keeps a complete first line at a tail-window boundary', () => {
  const cwd = tempRepo();
  const file = path.join(cwd, 'rollout.jsonl');
  const latest = tokenCountLine(7777, 258400, '2026-09-15T08:05:00.000Z');
  const content = functionCallLine('x'.repeat(2000)) + '\n' + latest + '\n';
  fs.writeFileSync(file, content, 'utf8');
  const tailBytes = Buffer.byteLength(latest + '\n', 'utf8');
  assert.equal(content.length - tailBytes, Buffer.byteLength(functionCallLine('x'.repeat(2000)) + '\n'));
  assert.deepEqual(readLatestTokenCount(file, tailBytes), { tokens: 7777, limit: 258400 });
});

test('readLatestTokenCount ignores a trailing partial line from a session still being written', () => {
  const cwd = tempRepo();
  const file = path.join(cwd, 'rollout.jsonl');
  const complete = tokenCountLine(5000, 258400, '2026-09-15T08:00:00.000Z');
  // No trailing newline, and the JSON itself is cut off mid-write.
  const partial = tokenCountLine(9999, 258400, '2026-09-15T08:10:00.000Z').slice(0, 40);
  fs.writeFileSync(file, complete + '\n' + partial, 'utf8');
  assert.deepEqual(readLatestTokenCount(file), { tokens: 5000, limit: 258400 });
});

test('readLatestTokenCount returns null for a rollout with no token_count event yet', () => {
  const cwd = tempRepo();
  const file = path.join(cwd, 'rollout.jsonl');
  fs.writeFileSync(file, functionCallLine('exec') + '\n', 'utf8');
  assert.equal(readLatestTokenCount(file), null);
});

test('readLatestTokenCount returns null for a missing file', () => {
  assert.equal(readLatestTokenCount(path.join(tempRepo(), 'does-not-exist.jsonl')), null);
});

test('readLatestTokenCount rejects a non-positive or non-numeric context window', () => {
  const cwd = tempRepo();
  const file = path.join(cwd, 'rollout.jsonl');
  fs.writeFileSync(file, tokenCountLine(1000, 0, '2026-09-15T08:00:00.000Z') + '\n', 'utf8');
  assert.equal(readLatestTokenCount(file), null);
});

test('readCodexContext locates and reads in one call', () => {
  const codexHome = tempRepo();
  const dir = path.join(codexHome, 'sessions', '2026', '09', '15');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'rollout-2026-09-15T08-00-00-abc.jsonl'),
    tokenCountLine(30100, 258400, '2026-09-15T08:00:00.000Z') + '\n',
    'utf8'
  );
  assert.deepEqual(readCodexContext(codexHome), { tokens: 30100, limit: 258400 });
});

test('readCodexContext caches discovery and refreshes the selected rollout when it changes', () => {
  const codexHome = tempRepo();
  const dir = path.join(codexHome, 'sessions', '2026', '09', '15');
  fs.mkdirSync(dir, { recursive: true });
  const selected = path.join(dir, 'rollout-selected.jsonl');
  fs.writeFileSync(selected, tokenCountLine(1000, 258400, '2026-09-15T08:00:00.000Z') + '\n', 'utf8');

  assert.deepEqual(readCodexContext(codexHome, 1000), { tokens: 1000, limit: 258400 });
  fs.appendFileSync(selected, tokenCountLine(2000, 258400, '2026-09-15T08:01:00.000Z') + '\n', 'utf8');
  assert.deepEqual(readCodexContext(codexHome, 2000), { tokens: 2000, limit: 258400 });

  const newer = path.join(dir, 'rollout-newer.jsonl');
  fs.writeFileSync(newer, tokenCountLine(3000, 258400, '2026-09-15T08:02:00.000Z') + '\n', 'utf8');
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(newer, future, future);
  assert.deepEqual(readCodexContext(codexHome, 3000), { tokens: 2000, limit: 258400 });
  assert.deepEqual(readCodexContext(codexHome, 62_000), { tokens: 3000, limit: 258400 });
});

test('registry polling reads the HiveManager CODEX_HOME instead of the project cwd', () => {
  const harnessHome = tempRepo();
  const hiveRoot = path.join(harnessHome, 'hive');
  const projectCwd = path.join(harnessHome, 'project-worktree');
  fs.mkdirSync(projectCwd, { recursive: true });
  fs.mkdirSync(hiveRoot, { recursive: true });
  fs.writeFileSync(path.join(hiveRoot, 'registry.json'), JSON.stringify({
    godId: null,
    agents: {
      'codex-worker': {
        id: 'codex-worker',
        name: 'Codex Worker',
        provider: 'codex',
        cwd: projectCwd,
        status: 'working',
        lastSeen: Date.now()
      }
    }
  }), 'utf8');

  const hive = new HiveManager(() => harnessHome);
  const codexHome = hive.codexHome('codex-worker');
  assert.notEqual(codexHome, null);
  assert.notEqual(codexHome, projectCwd);
  const sessionDir = path.join(codexHome, 'sessions', '2026', '09', '15');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'rollout-real-home.jsonl'),
    tokenCountLine(4242, 258400, '2026-09-15T08:00:00.000Z') + '\n',
    'utf8'
  );

  assert.deepEqual(readCodexRegistryContexts(hive), [
    { agentId: 'codex-worker', reading: { tokens: 4242, limit: 258400 } }
  ]);
});

test('readCodexContext returns null for an agent that was never a Codex worker', () => {
  assert.equal(readCodexContext(tempRepo()), null);
});
