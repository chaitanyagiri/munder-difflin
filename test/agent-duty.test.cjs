'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  AGENT_DUTIES,
  DEFAULT_AGENT_DUTY,
  normalizeDuty,
  mayGate,
  dutyBriefing,
  dutyLabel
} = loadTs('src/shared/agentDuty.ts');

test('the duty set is closed and ordered for the picker', () => {
  assert.deepEqual([...AGENT_DUTIES], ['developer', 'reviewer', 'final-reviewer', 'unassigned']);
  assert.equal(DEFAULT_AGENT_DUTY, 'developer');
});

test('a missing or unknown duty is unassigned, never the default', () => {
  // The distinction matters: a typo in a hand-edited registry.json must not
  // silently enrol an agent as a developer.
  for (const value of [undefined, null, 42, {}, '', '   ', 'sherrif', 'REVIEWERS']) {
    assert.equal(normalizeDuty(value), 'unassigned', String(value));
  }
});

test('the spellings a human or an LLM actually writes are accepted', () => {
  for (const value of ['dev', 'Developer', ' DEVELOPER ', 'engineer']) {
    assert.equal(normalizeDuty(value), 'developer', value);
  }
  for (const value of ['reviewer', 'Review', 'peer_reviewer', 'PEER-REVIEWER']) {
    assert.equal(normalizeDuty(value), 'reviewer', value);
  }
  // "last-reviewer" is what the operator calls it; "final-reviewer" is canonical.
  for (const value of ['final-reviewer', 'last-reviewer', 'last_reviewer', 'lastReviewer'.toLowerCase(), 'final', 'last']) {
    assert.equal(normalizeDuty(value), 'final-reviewer', value);
  }
});

test('only reviewing duties gate a card', () => {
  assert.equal(mayGate('reviewer'), true);
  assert.equal(mayGate('final-reviewer'), true);
  assert.equal(mayGate('developer'), false);
  assert.equal(mayGate('unassigned'), false);
});

test('every gating duty briefs the agent, and unassigned adds no bullet', () => {
  // identity.md is the only place the agent learns its own limits, so a gating
  // duty with no briefing would be a rule nobody told the agent about.
  for (const duty of ['developer', 'reviewer', 'final-reviewer']) {
    const text = dutyBriefing(duty);
    assert.ok(text && text.length > 40, duty);
  }
  assert.equal(dutyBriefing('unassigned'), undefined);

  assert.match(dutyBriefing('reviewer'), /do NOT implement/);
  assert.match(dutyBriefing('final-reviewer'), /LAST/);
  assert.match(dutyBriefing('developer'), /do NOT sign off/i);
});

test('labels are stable strings for the files agents read', () => {
  assert.equal(dutyLabel('final-reviewer'), 'final reviewer');
  assert.equal(dutyLabel('developer'), 'developer');
});

// ── wiring ──────────────────────────────────────────────────────────────────

test('both agent dialogs offer the duty, and neither writes its own picker', () => {
  // Two surfaces create or change an agent. A third one added later without a
  // duty would silently register `unassigned` agents — an operator's "reviewer"
  // that reviews nothing — so this asserts the pair, and asserts they share the
  // one component rather than each hard-coding a list that can drift from
  // AGENT_DUTIES.
  const root = path.resolve(__dirname, '..');
  for (const file of [
    'src/renderer/src/components/AddAgentModal.tsx',
    'src/renderer/src/components/EditAgentModal.tsx'
  ]) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(src, /<DutyPicker\s/, `${file} must offer the duty picker`);
    assert.doesNotMatch(src, /AGENT_DUTIES\s*\.map/,
      `${file} must not render its own duty list — use DutyPicker`);
  }

  const picker = fs.readFileSync(path.join(root, 'src/renderer/src/components/DutyPicker.tsx'), 'utf8');
  // Rendered FROM the shared constant, so a new duty cannot exist in the gate
  // and be missing from the UI.
  assert.match(picker, /AGENT_DUTIES\.map/);
});

test('a duty change reaches the hive registry, not just the roster', () => {
  // The registry is what the review gate reads and what identity.md is written
  // from. Patching the roster alone yields a "reviewer" the gate never counts
  // and that never learns its own limits.
  const root = path.resolve(__dirname, '..');
  const edit = fs.readFileSync(path.join(root, 'src/renderer/src/components/EditAgentModal.tsx'), 'utf8');
  assert.match(edit, /hivePatchAgentDuty\(/);

  // On the create path the duty rides the spawn's hive meta instead. Checked on
  // the submit slice rather than the whole file, so a stray `duty,` elsewhere
  // cannot satisfy it.
  const add = fs.readFileSync(path.join(root, 'src/renderer/src/components/AddAgentModal.tsx'), 'utf8');
  const submit = add.slice(add.indexOf('const submit'), add.indexOf('addAgent(agent)'));
  assert.ok(submit.includes('hive: {'), 'the spawn must provision the agent in the hive');
  assert.ok(submit.includes('duty,'), 'the spawn must carry the duty into the hive registry');
});

test('a respawn carries the duty so a restart cannot demote a reviewer', () => {
  const root = path.resolve(__dirname, '..');
  for (const file of [
    'src/renderer/src/hooks/useHive.ts',
    'src/renderer/src/hooks/useRestoreTeam.ts',
    'src/renderer/src/components/CommandCenterPanel.tsx'
  ]) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(src, /duty:\s*a\.duty/, `${file} must pass the duty when (re)spawning`);
  }
});
