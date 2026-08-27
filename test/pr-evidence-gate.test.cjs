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
