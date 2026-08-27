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
 * The production input, which every test above this line got wrong.
 *
 * electron-updater only falls back to GitHub's releases.atom feed when the
 * channel yml carries no releaseNotes — and that feed's `<content type="html">`
 * is GitHub's RENDERED HTML of RELEASE.md, not its markdown source. Every
 * fixture above feeds markdown, so the suite was green while production was
 * broken: no `##` headings meant no what's-new section, the bullet scan took
 * over, and the only line in 53KB matching the bullet syntax was
 * `* { box-sizing: border-box; }` from RELEASE.md's <style> block, because `*`
 * plus a space IS a markdown bullet. Users saw a CSS rule as the entire list.
 *
 * The shipped fix is releaseInfo.releaseNotesFile (below), which puts markdown
 * in the yml so the feed is never consulted. These pin the fallback anyway, so
 * a release that forgets the yml degrades to correct instead of to CSS.
 */
const RENDERED_ATOM_HTML = [
  '<style>',
  '  * { box-sizing: border-box; }',
  '  .md-body { margin: 0; padding: 0; }',
  '</style>',
  '<h1>Munder Difflin v0.4.6</h1>',
  '<p>A local hive of agents that run themselves.</p>',
  '<h2>What&#39;s new in 0.4.6</h2>',
  '<ul>',
  '<li><strong>The interface speaks Chinese.</strong> Pick zh-CN in Settings.</li>',
  '<li><strong>IME typing no longer sends early.</strong> Enter picks your candidate.</li>',
  '<li><strong>Fonts ship inside the app.</strong> No Google Fonts fetch on launch.</li>',
  '</ul>',
  '<h2>Downloads</h2>',
  '<table><tr><td>macOS</td><td>Apple silicon</td></tr></table>'
].join('\n');

test('rendered HTML from the atom feed never yields CSS', () => {
  const digest = summarizeReleaseNotes(RENDERED_ATOM_HTML);

  // The exact string the founder was shown.
  assert.ok(
    !digest.some((l) => /box-sizing/.test(l)),
    `a CSS rule reached the toast: ${JSON.stringify(digest)}`
  );
  for (const line of digest) {
    assert.doesNotMatch(line, /[{};]/, 'a stylesheet fragment reached the toast');
    assert.doesNotMatch(line, /^\s*</, 'a raw HTML tag reached the toast');
  }
});

test('rendered HTML yields the actual news, not the preamble or the downloads', () => {
  const digest = summarizeReleaseNotes(RENDERED_ATOM_HTML);

  assert.equal(digest.length, 3);
  assert.match(digest[0], /^The interface speaks Chinese\./);
  assert.match(digest[1], /^IME typing no longer sends early\./);
  assert.match(digest[2], /^Fonts ship inside the app\./);
  // `<h2>What&#39;s new` has to be recognised through the entity, or the
  // section marker is missed and the <h1>/<p> preamble leads instead.
  assert.ok(!digest.some((l) => /A local hive|Munder Difflin v/.test(l)));
  // The section has to END at the next <h2>, exactly as it does at `##`.
  assert.ok(!digest.some((l) => /Downloads|Apple silicon/.test(l)));
});

test('a <style> block is dropped even with no what-is-new heading to anchor on', () => {
  const body = [
    '<style>',
    '  * { box-sizing: border-box; }',
    '</style>',
    '<ul><li>Fixes the crash on launch.</li></ul>'
  ].join('\n');
  assert.deepEqual(summarizeReleaseNotes(body), ['Fixes the crash on launch.']);
  // <script> gets the same treatment; it is never prose.
  assert.deepEqual(
    summarizeReleaseNotes('<script>\nvar a = 1;\n</script>\n\n- Real news here.'),
    ['Real news here.']
  );
});

test('the notes file we actually ship fits the toast', () => {
  // Guards the FILE, not the parser: build/release-notes.md is what
  // releaseInfo.releaseNotesFile bakes into latest*.yml, and it is the thing a
  // release runner edits by hand. A bullet that silently falls off the budget
  // is invisible until someone reads a shipped toast.
  const notes = fs.readFileSync(
    path.join(__dirname, '..', 'build', 'release-notes.md'),
    'utf8'
  );
  const digest = summarizeReleaseNotes(notes);
  const bullets = notes.split('\n').filter((l) => /^\s*-\s+/.test(l)).length;

  assert.ok(bullets >= 3 && bullets <= RELEASE_NOTES_MAX_BULLETS, `${bullets} bullets in the file`);
  assert.equal(digest.length, bullets, 'a bullet was dropped by the budget');
  assert.ok(total(digest) <= RELEASE_NOTES_MAX_CHARS, `${total(digest)} chars over budget`);
  assert.ok(!digest.some((l) => l.includes('…')), 'a shipped bullet is clipped mid-sentence');
  assert.doesNotMatch(notes, /<[a-z]/i, 'the notes file must stay free of HTML');
});

test('electron-builder points the release notes at a file that exists', () => {
  // Without this field electron-updater silently falls back to the atom feed,
  // which is the whole bug. A typo here fails open and looks like nothing.
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
  const match = cfg.match(/^releaseInfo:\n\s+releaseNotesFile:\s*(\S+)\s*$/m);

  assert.ok(match, 'releaseInfo.releaseNotesFile is missing from electron-builder.yml');
  assert.ok(
    fs.existsSync(path.join(__dirname, '..', match[1])),
    `releaseNotesFile points at a missing file: ${match[1]}`
  );
});
