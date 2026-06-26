#!/usr/bin/env node
'use strict';
/**
 * agent-env.cjs — query per-agent environment / session metadata for the orchestrator.
 *
 * WHY: the roster surfaces tokens / cost / breaker / status, but not a reliable,
 * validated view of WHERE each agent runs (its cwd) or its session identity. To
 * respawn a worker next to a peer (e.g. put a new agent in the same checkout as
 * Oscar) the orchestrator needs a known-good ABSOLUTE cwd; a bad relative path
 * like "ClaudeTerminalHarness" spawns into a nonexistent dir and fails. This reads
 * the canonical hive state and emits a clean, NON-SENSITIVE record per agent,
 * flagging whether each cwd is actually usable (absolute + exists on disk).
 *
 * The harness now also persists `cwdValid` onto each registry entry at spawn
 * (src/main/hive.ts); this tool prefers that stored flag and otherwise validates
 * the path live, so it is correct against both new and pre-existing registries.
 *
 * DATA SOURCES (read-only, no instrumentation, no log spam):
 *   - registry.json  -> canonical roster: cwd, cwdValid, sessionId, provider, role, status
 *   - fleet.json     -> live telemetry:   breaker, lastTool, lastActiveSecAgo, inboxBacklog
 *
 * SECURITY: reads ONLY registry.json + fleet.json (no secret stores, no process
 * env, no key material). Emits directory PATHS + non-secret session metadata; it
 * never reads or prints file contents, credentials, or API keys. `sessionId` is a
 * non-secret `claude --resume` UUID, already stored plaintext in registry.json.
 *
 * USAGE (run from anywhere; $HIVE_ROOT or --hive locates the hive):
 *   node tools/agent-env.cjs                 # table of live (non-archived) agents
 *   node tools/agent-env.cjs --all           # include archived agents
 *   node tools/agent-env.cjs <agent-id>      # one agent, pretty JSON
 *   node tools/agent-env.cjs --json [--all]  # JSON array to stdout
 *   node tools/agent-env.cjs --snapshot      # also write <hive>/shared/agent-env.json
 *   node tools/agent-env.cjs --hive <dir>    # override the hive root
 *
 * Exit code 2 if a named agent is not found / no hive located; else 0. Never
 * throws on bad/missing input (a corrupt registry/fleet degrades to empty).
 */
const fs = require('fs');
const path = require('path');

function resolveHiveRoot(argv) {
  const i = argv.indexOf('--hive');
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1]);
  if (process.env.HIVE_ROOT) return process.env.HIVE_ROOT;
  return null;
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

/** Validate a cwd the way a spawn would: absolute path that exists as a directory. */
function cwdState(cwd) {
  if (cwd == null || typeof cwd !== 'string' || cwd === '') return { valid: false, issue: 'missing' };
  if (!path.isAbsolute(cwd)) return { valid: false, issue: 'not-absolute' };
  try {
    if (fs.statSync(cwd).isDirectory()) return { valid: true, issue: null };
    return { valid: false, issue: 'not-a-directory' };
  } catch {
    return { valid: false, issue: 'missing-dir' };
  }
}

function buildRecords(hiveRoot) {
  const reg = readJson(path.join(hiveRoot, 'registry.json'), { agents: {} });
  const fleet = readJson(path.join(hiveRoot, 'fleet.json'), { agents: [] });
  const live = new Map();
  for (const a of (fleet.agents || [])) live.set(a.id, a);

  const records = [];
  for (const [id, a] of Object.entries(reg.agents || {})) {
    const f = live.get(id) || {};
    const cwd = a.cwd ?? null;
    const cs = cwdState(cwd);
    // Prefer the harness-persisted cwdValid; fall back to a live check (older registries).
    const valid = typeof a.cwdValid === 'boolean' ? a.cwdValid : cs.valid;
    records.push({
      id,
      name: a.name ?? null,
      provider: a.provider ?? null,        // terminal/CLI engine: claude / codex / crush / ...
      role: a.role ?? null,
      isGod: !!a.isGod,
      archived: !!a.archived,
      // --- environment ---
      cwd,
      cwdValid: valid,
      cwdIssue: valid ? null : cs.issue,
      // --- session ---
      sessionId: a.sessionId ?? null,      // non-secret `claude --resume` key (null = never started)
      status: a.status ?? null,
      lastSeen: a.lastSeen ?? null,
      // --- live telemetry (fleet.json; absent for never-run agents) ---
      breaker: f.breaker ?? null,
      lastTool: f.lastTool ?? null,
      lastActiveSecAgo: f.lastActiveSecAgo ?? null,
      inboxBacklog: f.inboxBacklog ?? null,
    });
  }
  return records;
}

function pad(s, n) { s = String(s ?? ''); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

function printTable(records) {
  const cols = [['ID', 22], ['NAME', 10], ['PROV', 7], ['STATUS', 8], ['CWD?', 13]];
  console.log(cols.map(([h, w]) => pad(h, w)).join(' ') + ' CWD');
  console.log(cols.map(([, w]) => '-'.repeat(w)).join(' ') + ' ' + '-'.repeat(40));
  for (const r of records) {
    const ok = r.cwdValid ? 'ok' : (r.cwdIssue || 'bad');
    console.log(
      pad(r.id, 22) + ' ' + pad(r.name, 10) + ' ' + pad(r.provider, 7) + ' ' +
      pad(r.status, 8) + ' ' + pad(ok, 13) + ' ' + (r.cwd ?? '(none)')
    );
  }
}

function main() {
  const argv = process.argv.slice(2);
  const hiveRoot = resolveHiveRoot(argv);
  if (!hiveRoot) {
    console.error('agent-env: no hive root — set $HIVE_ROOT or pass --hive <dir>');
    process.exit(2);
  }
  const flags = new Set(argv.filter(a => a.startsWith('--')));
  const id = argv.find((a, idx) => !a.startsWith('--') && argv[idx - 1] !== '--hive');
  const includeArchived = flags.has('--all');

  let records = buildRecords(hiveRoot);
  if (!includeArchived && !id) records = records.filter(r => !r.archived);

  if (flags.has('--snapshot')) {
    const snap = { generatedBy: 'tools/agent-env.cjs', ts: Date.now(), agents: records };
    const out = path.join(hiveRoot, 'shared', 'agent-env.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(snap, null, 2) + '\n', 'utf8');
    console.error(`wrote ${path.relative(hiveRoot, out)} (${records.length} agents)`);
  }

  if (id) {
    const rec = records.find(r => r.id === id) || buildRecords(hiveRoot).find(r => r.id === id);
    if (!rec) { console.error(`agent-env: no agent with id "${id}"`); process.exit(2); }
    console.log(JSON.stringify(rec, null, 2));
    return;
  }

  if (flags.has('--json')) { console.log(JSON.stringify(records, null, 2)); return; }
  if (!flags.has('--snapshot')) printTable(records);
}

main();
