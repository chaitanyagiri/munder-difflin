'use strict';
/**
 * readAgentUsage incremental-cache tests. Self-contained, no framework — run
 * with `node test/transcript-usage.test.cjs` (mirrors test/breaker.test.cjs).
 * transcript.ts + its dependency pricing.ts are transpiled with the bundled
 * `typescript` compiler.
 *
 * The breaker/cost beat calls readAgentUsage every ~30s per agent (transcript
 * fallback); it used to re-read and re-JSON.parse EVERY transcript in the
 * project dir each call. These tests pin the cached implementation to the same
 * observable results across appends, partial writes, rewrites, and session
 * filters — correctness of the incremental path, not just speed.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

// Sandbox HOME so projectDir() maps into a throwaway dir, never the user's
// real ~/.claude/projects. os.homedir() reads $HOME/$USERPROFILE per call.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

const SRC = path.join(__dirname, '..', 'src', 'main');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-'));
for (const name of ['pricing', 'transcript']) {
  const js = ts.transpileModule(fs.readFileSync(path.join(SRC, `${name}.ts`), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
  }).outputText;
  fs.writeFileSync(path.join(out, `${name}.js`), js, 'utf8');
}
const { readAgentUsage, projectDir } = require(path.join(out, 'transcript.js'));

/** A fake cwd whose projectDir we can write transcripts into. */
function makeProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  const dir = projectDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  return { cwd, dir };
}

function rec(output, opts = {}) {
  return JSON.stringify({
    type: 'assistant',
    sessionId: opts.sessionId ?? 's1',
    message: {
      model: opts.model ?? 'claude-haiku-4-5',
      usage: { input_tokens: opts.input ?? 10, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    }
  });
}

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

test('sums usage across records and files', () => {
  const { cwd, dir } = makeProject();
  fs.writeFileSync(path.join(dir, 'a.jsonl'), rec(100) + '\n' + rec(200) + '\n');
  fs.writeFileSync(path.join(dir, 'b.jsonl'), rec(50) + '\n');
  const u = readAgentUsage(cwd);
  assert.equal(u.outputTokens, 350);
  assert.equal(u.inputTokens, 30);
  assert.ok(u.estimatedCostUsd > 0);
});

test('appended records are picked up (incremental tail parse)', () => {
  const { cwd, dir } = makeProject();
  const f = path.join(dir, 'a.jsonl');
  fs.writeFileSync(f, rec(100) + '\n');
  assert.equal(readAgentUsage(cwd).outputTokens, 100); // primes the cache
  fs.appendFileSync(f, rec(25) + '\n' + rec(75) + '\n');
  assert.equal(readAgentUsage(cwd).outputTokens, 200);
});

test('repeat reads with no change are stable', () => {
  const { cwd, dir } = makeProject();
  fs.writeFileSync(path.join(dir, 'a.jsonl'), rec(100) + '\n');
  const a = readAgentUsage(cwd);
  const b = readAgentUsage(cwd);
  assert.deepEqual(b, a);
});

test('a partial trailing line is not counted until completed', () => {
  const { cwd, dir } = makeProject();
  const f = path.join(dir, 'a.jsonl');
  const full = rec(500);
  fs.writeFileSync(f, rec(100) + '\n' + full.slice(0, 40)); // torn mid-write
  assert.equal(readAgentUsage(cwd).outputTokens, 100);
  fs.appendFileSync(f, full.slice(40) + '\n'); // writer finishes the line
  assert.equal(readAgentUsage(cwd).outputTokens, 600, 'completed line counts exactly once');
});

test('a rewritten (shrunk) file is re-parsed from scratch', () => {
  const { cwd, dir } = makeProject();
  const f = path.join(dir, 'a.jsonl');
  fs.writeFileSync(f, rec(100) + '\n' + rec(200) + '\n');
  assert.equal(readAgentUsage(cwd).outputTokens, 300);
  fs.writeFileSync(f, rec(40) + '\n'); // smaller rewrite
  assert.equal(readAgentUsage(cwd).outputTokens, 40);
});

test('a deleted file drops out of the totals', () => {
  const { cwd, dir } = makeProject();
  fs.writeFileSync(path.join(dir, 'a.jsonl'), rec(100) + '\n');
  fs.writeFileSync(path.join(dir, 'b.jsonl'), rec(50) + '\n');
  assert.equal(readAgentUsage(cwd).outputTokens, 150);
  fs.rmSync(path.join(dir, 'b.jsonl'));
  assert.equal(readAgentUsage(cwd).outputTokens, 100);
});

test('sessionId filter sums only that session, incrementally too', () => {
  const { cwd, dir } = makeProject();
  const f = path.join(dir, 'a.jsonl');
  fs.writeFileSync(f, rec(100, { sessionId: 's1' }) + '\n' + rec(999, { sessionId: 's2' }) + '\n');
  assert.equal(readAgentUsage(cwd, { sessionId: 's1' }).outputTokens, 100);
  fs.appendFileSync(f, rec(11, { sessionId: 's1' }) + '\n' + rec(888, { sessionId: 's2' }) + '\n');
  assert.equal(readAgentUsage(cwd, { sessionId: 's1' }).outputTokens, 111);
  assert.equal(readAgentUsage(cwd, { sessionId: 's2' }).outputTokens, 1887);
  assert.equal(readAgentUsage(cwd).outputTokens, 1998, 'unfiltered still sums everything');
});

test('malformed lines and non-assistant records are skipped', () => {
  const { cwd, dir } = makeProject();
  fs.writeFileSync(path.join(dir, 'a.jsonl'),
    'not json\n' + JSON.stringify({ type: 'user' }) + '\n' + rec(70) + '\n\n');
  assert.equal(readAgentUsage(cwd).outputTokens, 70);
});

test('model is the last one seen (per current semantics)', () => {
  const { cwd, dir } = makeProject();
  fs.writeFileSync(path.join(dir, 'a.jsonl'),
    rec(1, { model: 'claude-haiku-4-5' }) + '\n' + rec(2, { model: 'claude-opus-4-8' }) + '\n');
  assert.equal(readAgentUsage(cwd).model, 'claude-opus-4-8');
});

test('missing project dir yields zeros', () => {
  const u = readAgentUsage('/nonexistent/cwd/for/testing');
  assert.equal(u.outputTokens, 0);
  assert.equal(u.estimatedCostUsd, 0);
});

process.exit(failures ? 1 : 0);
