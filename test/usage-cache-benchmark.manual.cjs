'use strict';
/**
 * Before/after benchmark for the usage-cache cross-agent amplification fix.
 * Simulates a DUMMY hive (throwaway HOME, fake transcripts) — never touches
 * a real floor. Builds N agents sharing one project dir, each with its own
 * transcript file, then runs W rounds of "everyone is active": every file
 * gets a new record appended, then every agent's own ~30s usage beat fires
 * (readAgentUsage(cwd, {sessionId})).
 *
 * Prints per-round progress live (for recorded before/after demos) plus a
 * final summary: wall-clock time AND total JSON.parse() calls (a direct
 * proxy for "how many times was a line reprocessed").
 *
 * Usage: node usage-cache-benchmark.cjs <path-to-transcript.ts> <label>
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const [, , transcriptTsPath, label] = process.argv;
if (!transcriptTsPath || !label) {
  console.error('usage: node usage-cache-benchmark.cjs <transcript.ts> <label>');
  process.exit(1);
}

// Workload size. An unparseable value is an error, not a silent fallback: a
// benchmark that quietly ignores the size you asked for reports a number for
// the wrong workload.
function benchCount(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`${name} must be a positive integer, got: ${raw}`);
    process.exit(1);
  }
  return n;
}

const N_AGENTS = benchCount('BENCH_AGENTS', 10);
const N_ROUNDS = benchCount('BENCH_ROUNDS', 30);

// Sandbox HOME so projectDir() never touches the real ~/.claude/projects.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-home-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

const srcDir = path.dirname(transcriptTsPath);
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-out-'));
for (const name of ['pricing', path.basename(transcriptTsPath, '.ts')]) {
  const srcFile = path.join(srcDir, `${name}.ts`);
  const js = ts.transpileModule(fs.readFileSync(srcFile, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
  }).outputText;
  fs.writeFileSync(path.join(outDir, `${name}.js`), js, 'utf8');
}
const { readAgentUsage, projectDir } = require(path.join(outDir, path.basename(transcriptTsPath, '.ts') + '.js'));

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-proj-'));
const dir = projectDir(cwd);
fs.mkdirSync(dir, { recursive: true });

const agents = Array.from({ length: N_AGENTS }, (_, i) => ({
  sessionId: `agent-${i}-session`,
  file: path.join(dir, `agent-${i}-session.jsonl`)
}));
for (const a of agents) fs.writeFileSync(a.file, '');

function record(sessionId, n) {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    message: { model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: n, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
  }) + '\n';
}

// Count JSON.parse calls globally as a direct proxy for "lines reprocessed".
let parseCount = 0;
const realParse = JSON.parse;
JSON.parse = (...args) => { parseCount++; return realParse(...args); };

console.log(`=== ${label} ===  ${N_AGENTS} agents sharing a dummy project dir, ${N_ROUNDS} rounds of "everyone active"\n`);
const t0 = process.hrtime.bigint();
for (let round = 1; round <= N_ROUNDS; round++) {
  // Everyone is active: each agent's own file grows by one record.
  for (const a of agents) fs.appendFileSync(a.file, record(a.sessionId, round));
  // Everyone's ~30s usage beat fires, filtered to their own session.
  for (const a of agents) readAgentUsage(cwd, { sessionId: a.sessionId });
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  round ${String(round).padStart(2)}/${N_ROUNDS}   elapsed ${elapsedMs.toFixed(1).padStart(7)}ms   JSON.parse() calls so far: ${parseCount}`);
}
const t1 = process.hrtime.bigint();
JSON.parse = realParse;

const ms = Number(t1 - t0) / 1e6;
console.log(`\n${label} TOTAL: ${ms.toFixed(1)}ms wall-clock, ${parseCount} JSON.parse() calls\n`);
