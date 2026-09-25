'use strict';

// The PR evidence gate must be able to SEE the section it is judging.
//
// The gate shipped with `(?=\n#{1,6}\s|$)` under the 'm' flag. With 'm', `$`
// matches at the end of EVERY line, and the capture group is lazy, so it stopped
// at the blank line that our own template puts after each heading. The captured
// section body was therefore ALWAYS the empty string, `hasEvidence('')` was
// always false, and every PR failed with "Missing evidence: before and after"
// no matter what was attached. It was red on #333, #329, #327 and #326.
//
// These read the regex OUT OF THE WORKFLOW FILE rather than restating it, so
// re-introducing the multiline `$` fails here instead of on a contributor's PR.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const YML = fs.readFileSync(
  path.resolve(__dirname, '..', '.github/workflows/pr-evidence.yml'), 'utf8'
);

/** The section-matcher template literal, taken from the workflow verbatim. */
function sectionTemplateFromWorkflow() {
  const m = YML.match(/`(\^#\{1,6\}[^`]*)`/);
  assert.ok(m, 'the section matcher template literal is still in the workflow');
  return m[1];
}

/** Rebuild the gate's own `section(name)` from the file's template. */
function section(name, body) {
  const src = sectionTemplateFromWorkflow().replace('${name}', name);
  // The YAML carries the JS source, so `\\s` in the file is `\s` in the regex.
  const re = new RegExp(src.replace(/\\\\/g, '\\'), 'im');
  const visible = body.replace(/<!--[\s\S]*?-->/g, '');
  return (visible.match(re) || [, ''])[1];
}

// The EVIDENCE list, also read from the workflow so the policy stays one copy.
const IMG = 'https://github.com/user-attachments/assets/abc-123';

const TEMPLATE_SHAPE = [
  '## Evidence', '', '### Before', '', `![before](${IMG})`, '',
  '### After', '', `![after](${IMG})`, ''
].join('\n');

test('a heading followed by a blank line still captures its section', () => {
  // This is the exact shape our PR template produces, and the shape the
  // multiline `$` reduced to an empty string.
  assert.notEqual(section('before', TEMPLATE_SHAPE).trim(), '', 'before section is not empty');
  assert.notEqual(section('after', TEMPLATE_SHAPE).trim(), '', 'after section is not empty');
});

test('each section stops at the next heading and does not swallow the other', () => {
  const before = section('before', TEMPLATE_SHAPE);
  assert.match(before, /!\[before\]/);
  assert.doesNotMatch(before, /!\[after\]/, 'before must not run into the after section');
});

test('evidence on the line immediately after the heading still works', () => {
  // The one shape the broken regex handled by accident. It must keep working.
  const tight = `### Before\n![b](${IMG})\n### After\n![a](${IMG})\n`;
  assert.match(section('before', tight), /!\[b\]/);
  assert.match(section('after', tight), /!\[a\]/);
});

test('the multiline end-of-line anchor is gone', () => {
  // A bare `$` inside the lookahead is the bug. Assert on the file itself.
  const src = sectionTemplateFromWorkflow();
  assert.doesNotMatch(src, /\|\$\)`?$/, 'no bare `|$)` end anchor');
  assert.match(src, /\(\?!\[\\\\s\\\\S\]\)/, 'uses an absolute end-of-input assertion');
});

test('a body with no Before heading at all still yields an empty section', () => {
  // Fixing the capture must not make a MISSING heading start passing.
  assert.equal(section('before', '## Summary\n\nno headings here\n').trim(), '');
});

// ── the policy itself, documented so a change to it is deliberate ────────────

test('a console transcript is NOT accepted as evidence', () => {
  // PR #333 (cbcode, external contributor) attached real before/after console
  // transcripts and still failed, correctly per the rule as written: EVIDENCE
  // only matches an image or a video. Recorded here so that if we ever decide a
  // terminal transcript should count for a CLI-only change, this test is the
  // place that has to change, deliberately.
  const EVIDENCE = [
    /!\[[^\]]*\]\([^)]+\)/,
    /<img\b[^>]*\bsrc\s*=/i,
    /<video\b/i,
    /https:\/\/github\.com\/user-attachments\/assets\/[\w-]+/i,
    /https:\/\/user-images\.githubusercontent\.com\/\S+/i,
    /https:\/\/\S+\.(png|jpe?g|gif|webp|mp4|mov|webm)\b/i
  ];
  const hasEvidence = (t) => EVIDENCE.some((re) => re.test(t));
  const transcript = '### Before\n\n```console\n$ cbcode --permission-mode bypassPermissions\nSECURITY ERROR\n```\n';
  assert.notEqual(section('before', transcript).trim(), '', 'the section is captured');
  assert.equal(hasEvidence(section('before', transcript)), false, 'but a transcript is not evidence');
});

// ── THE MAINTAINER WAIVER ────────────────────────────────────────────────────
//
// 17 Sep 2026. The `no-visual-change` escape has existed since the gate shipped,
// and nothing tested it. That is the dangerous combination: a branch that lets a
// required check pass, with no test saying when it may and may not fire.
//
// Two ways it could rot, and both are covered below. It could stop working, and
// then a CI tweak or a typo has no way through a required check. Or it could
// start always firing, and then the gate is decorative on every pull request.
//
// Same discipline as the tests above: the label name and the ordering are read
// OUT of the workflow rather than restated here, so changing the workflow
// without meaning to fails in this file rather than on somebody's pull request.

/** The waiver label, taken from the workflow verbatim. */
function waiverLabelFromWorkflow() {
  const m = YML.match(/const WAIVER = '([^']+)'/);
  assert.ok(m, 'the workflow still declares a WAIVER label');
  return m[1];
}

/** The workflow's own guard, taken from the file so a rewrite is caught here. */
function waiverGuardFromWorkflow() {
  const m = YML.match(/if \((labels\.includes\(WAIVER\))\) \{/);
  assert.ok(m, 'the waiver still guards on exact label membership');
  return m[1];
}

/** The workflow's decision, rebuilt: labels are lowercased, then matched. */
function waived(labelNames) {
  const labels = labelNames.map((n) => n.toLowerCase());
  const WAIVER = waiverLabelFromWorkflow();
  waiverGuardFromWorkflow();
  return labels.includes(WAIVER);
}

test('the waiver label is still the one the template and the bot comment name', () => {
  // Three places have to agree or the escape is unreachable: the workflow, the
  // comment the bot posts, and the PR template a contributor reads.
  const label = waiverLabelFromWorkflow();
  assert.equal(label, 'no-visual-change');

  const template = fs.readFileSync(
    path.resolve(__dirname, '..', '.github/PULL_REQUEST_TEMPLATE.md'), 'utf8'
  );
  assert.ok(template.includes(label), 'the PR template names the waiver label');
  assert.ok(YML.includes('${WAIVER}'), 'the comment the bot posts names the waiver label');
});

test('the waiver is checked BEFORE the evidence is computed', () => {
  // Ordering is the whole point. If the waiver moved below the section parsing
  // it would still pass the check, but a waived PR would get a "missing
  // evidence" comment posted on it first, which is how you train people to
  // ignore the bot.
  const waiverAt = YML.indexOf('labels.includes(WAIVER)');
  const sectionAt = YML.indexOf('const before = section(');
  assert.ok(waiverAt > -1, 'the waiver branch is present');
  assert.ok(sectionAt > -1, 'the evidence parsing is present');
  assert.ok(waiverAt < sectionAt, 'the waiver short circuits before any parsing');
});

test('the waiver returns early rather than falling through', () => {
  // Without the `return` the job carries on and fails the PR anyway.
  const m = YML.match(/if \(labels\.includes\(WAIVER\)\) \{[\s\S]{0,200}?\n\s*\}/);
  assert.ok(m, 'the waiver branch is present');
  assert.match(m[0], /\breturn\b/, 'the waiver branch returns');
});

test('the waiver FIRES when a maintainer applies the label', () => {
  assert.equal(waived(['no-visual-change']), true);
  assert.equal(waived(['bug', 'no-visual-change', 'ci']), true, 'position does not matter');
});

test('the waiver is case insensitive, because GitHub labels are typed by hand', () => {
  assert.equal(waived(['No-Visual-Change']), true);
  assert.equal(waived(['NO-VISUAL-CHANGE']), true);
});

test('the waiver does NOT fire without the label', () => {
  // The always-pass failure mode. If this ever goes green for an unlabelled PR,
  // the required check has quietly stopped being required for everyone.
  assert.equal(waived([]), false, 'no labels at all');
  assert.equal(waived(['bug', 'documentation', 'ci']), false, 'unrelated labels');
});

test('the waiver needs the WHOLE label, not something that merely contains it', () => {
  // `includes` on the array is exact membership. A substring match would let
  // anyone invent `needs-no-visual-change` and walk through the gate.
  assert.equal(waived(['no-visual-changes']), false, 'trailing s is a different label');
  assert.equal(waived(['needs-no-visual-change']), false, 'prefixed is a different label');
  assert.equal(waived(['no-visual-change-please']), false, 'suffixed is a different label');
});

test('the unfilled template still FAILS the gate', () => {
  // 17 Sep 2026: the template gained a visible note about the waiver. Visible
  // text sits outside the HTML comments the gate strips, so it is now the first
  // thing under `## Evidence`. Prove it changed nothing: an untouched template
  // must still fail, or opening a PR and attaching nothing would pass.
  const EVIDENCE = [
    /!\[[^\]]*\]\([^)]+\)/,
    /<img\b[^>]*\bsrc\s*=/i,
    /<video\b/i,
    /https:\/\/github\.com\/user-attachments\/assets\/[\w-]+/i,
    /https:\/\/user-images\.githubusercontent\.com\/\S+/i,
    /https:\/\/\S+\.(png|jpe?g|gif|webp|mp4|mov|webm)\b/i
  ];
  const hasEvidence = (t) => EVIDENCE.some((re) => re.test(t));
  const template = fs.readFileSync(
    path.resolve(__dirname, '..', '.github/PULL_REQUEST_TEMPLATE.md'), 'utf8'
  );
  assert.equal(hasEvidence(section('before', template)), false, 'empty Before is not evidence');
  assert.equal(hasEvidence(section('after', template)), false, 'empty After is not evidence');
});

test('the visible waiver note is not itself mistaken for evidence', () => {
  // The note names the label and talks about "a before and an after". Words are
  // not evidence; only an image or a video is.
  const template = fs.readFileSync(
    path.resolve(__dirname, '..', '.github/PULL_REQUEST_TEMPLATE.md'), 'utf8'
  );
  const note = template.split('## Evidence')[1].split('<!--')[0];
  assert.match(note, /no-visual-change/, 'the note is visible, not inside a comment');
  assert.doesNotMatch(note, /!\[|<img|<video|https:\/\//, 'the note carries no image or link');
});
