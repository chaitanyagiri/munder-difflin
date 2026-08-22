'use strict';

/**
 * Release-note digest (src/shared/releaseNotes.ts).
 *
 * The update toast is the only notification this app raises, and it now renders
 * whatever this function returns — straight from the GitHub release body, with
 * no chance for a human to look at it first. So the failure modes are all
 * "shipped to every user at once":
 *
 *   - a 200-line RELEASE.md dumped into a 340px toast;
 *   - a digest of the release template's boilerplate (tagline, download links)
 *     instead of the release's actual news;
 *   - raw markdown or a bare URL rendered as text;
 *   - an empty "What's new" heading on the many releases whose body is a
 *     structural stub — the toast has to look untouched in that case.
 *
 * Each of those is pinned below.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  summarizeReleaseNotes,
  stripMarkdown,
  RELEASE_NOTES_MAX_BULLETS,
  RELEASE_NOTES_MAX_CHARS
} = loadTs('src/shared/releaseNotes.ts');

/** Total rendered length, the number the toast's height actually depends on. */
const total = (lines) => lines.join('').length;

test('no body, no digest — the toast must render exactly as it did before', () => {
  assert.deepEqual(summarizeReleaseNotes(undefined), []);
  assert.deepEqual(summarizeReleaseNotes(null), []);
  assert.deepEqual(summarizeReleaseNotes(''), []);
  assert.deepEqual(summarizeReleaseNotes('   \n\n\t\n  '), []);
  // Not a string at all — `releaseNotes` is `string | ReleaseNoteInfo[]` in
  // electron-updater's types and main only forwards the string case, but a
  // renderer must never explode on a shape it didn't expect.
  assert.deepEqual(summarizeReleaseNotes(42), []);
  assert.deepEqual(summarizeReleaseNotes({ note: 'hi' }), []);
});

test('a body of nothing but structure yields nothing', () => {
  assert.deepEqual(summarizeReleaseNotes('# v1.2.3\n\n## Changes\n\n---\n\n***\n'), []);
  assert.deepEqual(summarizeReleaseNotes('---\n\n<!-- release notes go here -->\n\n---'), []);
  // A download table and a compare link are markup, not news.
  assert.deepEqual(summarizeReleaseNotes([
    '## Assets',
    '| Build | File |',
    '|---|---|',
    '| macOS | app.dmg |',
    '',
    '**Full Changelog**: https://github.com/o/r/compare/v1.0.0...v1.1.0'
  ].join('\n')), []);
});

test('markdown is stripped down to what a plain-text toast can render', () => {
  const digest = summarizeReleaseNotes([
    '## Fixed',
    '- Fixed the [crash on launch](https://github.com/o/r/issues/12)',
    '- `DO_NOT_TRACK` and `agent_spawned` are **respected** in _every_ build',
    '- ![badge](https://img.shields.io/x.svg) Signed builds on ~~Windows~~ macOS'
  ].join('\n'));

  assert.deepEqual(digest, [
    'Fixed the crash on launch',
    'DO_NOT_TRACK and agent_spawned are respected in every build',
    'Signed builds on macOS'
  ]);
  // The regression this guards: a URL that eats the whole character budget.
  for (const line of digest) assert.doesNotMatch(line, /https?:\/\//);
  // `_` is excluded on purpose — it is a real character in DO_NOT_TRACK, and
  // stripping it as emphasis is the bug the next test pins.
  for (const line of digest) assert.doesNotMatch(line, /[*`~[\]]/);
});

test('emphasis markers go, snake_case identifiers stay', () => {
  assert.equal(stripMarkdown('**Bold lead.** then _italic_ text'), 'Bold lead. then italic text');
  assert.equal(stripMarkdown('set `DO_NOT_TRACK=1` to opt out'), 'set DO_NOT_TRACK=1 to opt out');
  assert.equal(stripMarkdown('events: first_run, app_launched'), 'events: first_run, app_launched');
  assert.equal(stripMarkdown('see [the contract](https://x/TELEMETRY.md)'), 'see the contract');
  assert.equal(stripMarkdown('![shield](https://img.shields.io/v.svg)'), '');
});

test("the 'What's new' section wins over the release template's preamble", () => {
  // This is the shape of RELEASE.md: a tagline and a site link come first, and
  // taking "the first lines" of the body would digest the boilerplate the user
  // has already read instead of the release's news.
  const body = [
    '# Munder Difflin v0.4.4',
    '',
    '**A local hive of agents that run themselves** — the product tagline.',
    '',
    '### → [**munderdiffl.in**](https://munderdiffl.in/) — see it in action',
    '',
    '---',
    '',
    "## What's new in 0.4.4 — *the toast says something*",
    '',
    '- The update toast shows what changed.',
    '- The star ask is shown once, ever.',
    '',
    '---',
    '',
    '## Still new in 0.4.3 — *Michael is the logo*',
    '',
    '- The mark is a face now.'
  ].join('\n');

  assert.deepEqual(summarizeReleaseNotes(body), [
    'The update toast shows what changed.',
    'The star ask is shown once, ever.'
  ]);
});

test('a body with no "what\'s new" heading digests from the top', () => {
  const body = [
    '## Highlights',
    '',
    '- Agents restart cleanly after a GPU context loss',
    '- Slack triggers respect the queue'
  ].join('\n');
  assert.deepEqual(summarizeReleaseNotes(body), [
    'Agents restart cleanly after a GPU context loss',
    'Slack triggers respect the queue'
  ]);
});

test('bullets are the summary when a release has them; prose is the fallback', () => {
  const withBullets = [
    'This release is mostly about the updater and how it talks to you.',
    '',
    '- The toast shows release notes',
    '- Settings shows them too'
  ].join('\n');
  assert.deepEqual(summarizeReleaseNotes(withBullets), [
    'The toast shows release notes',
    'Settings shows them too'
  ]);

  // A one-liner body still says something rather than nothing.
  assert.deepEqual(summarizeReleaseNotes('Fixes the crash on launch.'), ['Fixes the crash on launch.']);
});

test('a bullet wrapped across source lines is folded back into one', () => {
  // Clipping at the author's line break would cut the sentence at an arbitrary
  // column that has nothing to do with the toast's width.
  const body = [
    "## What's new",
    '',
    '- **One mark, everywhere.** The dock icon on macOS, Windows and',
    '  Linux, the site favicon, and the README all render the same',
    '  portrait.',
    '- Second bullet.'
  ].join('\n');
  const digest = summarizeReleaseNotes(body);
  assert.equal(digest.length, 2);
  assert.match(digest[0], /^One mark, everywhere\. The dock icon on macOS, Windows and Linux/);
  assert.equal(digest[1], 'Second bullet.');
});

test('bullets are capped in count', () => {
  const body = `## Changes\n${Array.from({ length: 20 }, (_, i) => `- Change number ${i}`).join('\n')}`;
  const digest = summarizeReleaseNotes(body);
  assert.ok(digest.length <= RELEASE_NOTES_MAX_BULLETS, `${digest.length} bullets`);
  assert.equal(digest[0], 'Change number 0');
});

test('a long body is truncated to the character budget, on a word boundary', () => {
  const body = [
    "## What's new",
    '',
    ...Array.from({ length: 12 }, (_, i) =>
      `- Bullet ${i}: ${'a fairly wordy sentence that keeps going and going '.repeat(4)}`)
  ].join('\n');

  const digest = summarizeReleaseNotes(body);
  assert.ok(digest.length > 0, 'a long body must still produce something');
  assert.ok(digest.length <= RELEASE_NOTES_MAX_BULLETS);
  assert.ok(total(digest) <= RELEASE_NOTES_MAX_CHARS, `${total(digest)} chars over budget`);
  assert.match(digest[0], /…$/);
  // Word boundary, not mid-word: the char before the ellipsis is never a
  // half-typed word followed by a space-less cut of the next one.
  assert.doesNotMatch(digest[0], /\s…$/);
});

test('one enormous bullet is clipped rather than dropped', () => {
  const digest = summarizeReleaseNotes(`- ${'word '.repeat(400)}`);
  assert.equal(digest.length, 1);
  assert.ok(total(digest) <= RELEASE_NOTES_MAX_CHARS);
  assert.match(digest[0], /…$/);
});

test('code fences, comments and quoted callouts are handled', () => {
  const body = [
    "## What's new",
    '',
    '> [!NOTE]',
    '> **Appearance only.** No functional change in this release.',
    '',
    '```bash',
    'npm install && npm run dev',
    '```'
  ].join('\n');
  const digest = summarizeReleaseNotes(body);
  assert.deepEqual(digest, ['Appearance only. No functional change in this release.']);
  for (const line of digest) assert.doesNotMatch(line, /npm install/);
});

test("the project's own RELEASE.md digests to something a toast can hold", () => {
  // The body electron-updater actually hands us is this file (see
  // .github/workflows/release.yml → `body_path: RELEASE.md`), so it is the one
  // fixture guaranteed to stay realistic.
  const body = fs.readFileSync(path.resolve(__dirname, '..', 'RELEASE.md'), 'utf8');
  const digest = summarizeReleaseNotes(body);

  assert.ok(digest.length > 0, 'the shipped release notes must produce a digest');
  assert.ok(digest.length <= RELEASE_NOTES_MAX_BULLETS);
  assert.ok(total(digest) <= RELEASE_NOTES_MAX_CHARS, `${total(digest)} chars over budget`);
  for (const line of digest) {
    assert.doesNotMatch(line, /https?:\/\//, 'a raw URL reached the toast');
    assert.doesNotMatch(line, /\]\(/, 'an unparsed markdown link reached the toast');
    assert.doesNotMatch(line, /^\s*[-*#|]/, 'a markdown marker reached the toast');
  }
  // The tagline and the download table live above/below the news; neither is
  // what "What's new" should say.
  assert.ok(!digest.some((l) => /Downloads|Requirements|Build from source/i.test(l)));
});

test('options are honoured so a roomier surface can ask for more', () => {
  const body = `## Changes\n${Array.from({ length: 10 }, (_, i) => `- Change ${i}`).join('\n')}`;
  assert.equal(summarizeReleaseNotes(body, { maxBullets: 2 }).length, 2);
  assert.ok(total(summarizeReleaseNotes(body, { maxChars: 60 })) <= 60);
});

/**
 * The CSS leak, pinned against GitHub's REAL rendered output.
 *
 * v0.4.5 shipped a restart prompt that read `{ box-sizing: border-box; }` and
 * nothing else. Every test above passes on hand-written markdown and every one
 * of them passed while that was live, because the string that reaches this
 * function on the updater's own path is not markdown at all: electron-updater
 * builds its notes from `releases.atom`, which is GitHub's RENDERED html.
 *
 * So the fixture is a genuine slice of that feed, saved verbatim, not written
 * by hand. Anything hand-written here would reproduce the same blind spot that
 * let this ship twice.
 */
test('a real rendered release feed never digests to CSS', () => {
  const rendered = fs.readFileSync(
    path.resolve(__dirname, 'fixtures', 'release-atom-v0.4.5.html'), 'utf8'
  );
  const digest = summarizeReleaseNotes(rendered);

  assert.ok(digest.length > 0, 'the feed has prose in it; something must come out');
  for (const line of digest) {
    assert.doesNotMatch(line, /box-sizing/, 'the 0.4.5 bug, verbatim');
    assert.doesNotMatch(line, /\{[^}]*:[^}]*[;}]/, `a CSS declaration reached the toast: ${line}`);
    assert.doesNotMatch(line, /^@(media|keyframes|import|supports)\b/i, `an at-rule reached the toast: ${line}`);
    assert.doesNotMatch(line, /^<?style>?/i, `the style tag itself reached the toast: ${line}`);
    assert.doesNotMatch(line, /&(amp|lt|gt|quot|#39);/, `an unresolved html entity reached the toast: ${line}`);
  }
});

test('CSS is dropped by structure, in every shape the renderer produces', () => {
  const news = '## What\'s new\n\nThe thing you wanted works now.\n';

  // A whole rule on one line. This exact shape is a markdown bullet, which is
  // why it beat the release: `* ` is the universal selector AND a list marker.
  assert.deepEqual(
    summarizeReleaseNotes(`${news}\n* { box-sizing: border-box; }\n`),
    ['The thing you wanted works now.']
  );
  // A selector opening a block whose declarations are on later lines.
  assert.deepEqual(
    summarizeReleaseNotes(`${news}\n:root {\n  --paper: #FFFDF7;\n  --ink: #1B1B1B;\n}\n`),
    ['The thing you wanted works now.']
  );
  // Nested at-rules: a single "skip to the next }" stops one rule too early.
  assert.deepEqual(
    summarizeReleaseNotes(`${news}\n@media (min-width: 40em) {\n  .p1 { display: flex; }\n}\n`),
    ['The thing you wanted works now.']
  );
  // GitHub renders `@media` as a USER MENTION, so on that path an at-rule never
  // starts its own line — it starts with an anchor. Tags are stripped for the
  // structural test, which is the only reason this one is caught.
  assert.deepEqual(
    summarizeReleaseNotes(`${news}\n<a class="user-mention" href="/media">@media</a> (min-width: 40em) {\n  .p1 { display: flex; }\n}\n`),
    ['The thing you wanted works now.']
  );
  // Comments read as sentences ("Two pages, no JavaScript…") and span lines, so
  // they are the one kind of CSS that looks exactly like release prose.
  assert.deepEqual(
    summarizeReleaseNotes(`${news}\n/* Self-contained on purpose.\n   Two pages, no JavaScript. */\n`),
    ['The thing you wanted works now.']
  );
});

test('prose that merely mentions CSS is not mistaken for it', () => {
  // The filter is structural on purpose. A release note is allowed to talk
  // about the code it changed, and this is the line the narrow rules protect.
  const digest = summarizeReleaseNotes(
    "## What's new\n\n- Panels now use `display: flex`, so a long agent name wraps instead of clipping.\n"
  );
  assert.equal(digest.length, 1);
  assert.match(digest[0], /display: flex/);
});

test('html entities are resolved, and resolved once', () => {
  // `&` in the product tagline reached the toast as `&amp;` for two releases.
  assert.equal(stripMarkdown('Codex, Grok &amp; Copilot'), 'Codex, Grok & Copilot');
  // Entities are decoded BEFORE tags are stripped, so an escaped tag becomes a
  // tag again and then goes — otherwise `<style>` survives as literal text.
  assert.equal(stripMarkdown('&lt;style&gt;body{color:red}'), 'body{color:red}');
  // Decoding must not run twice: `&amp;lt;` is a literal `&lt;`, not a `<`.
  assert.equal(stripMarkdown('&amp;lt;'), '&lt;');
});
