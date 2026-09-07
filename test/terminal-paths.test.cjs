'use strict';

/**
 * ⌘-click on a path in terminal output. Two jobs, and the matcher is the one
 * that actually breaks: agent output is full of version strings and decimals
 * that look like filenames if the extension rule is loose.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  classifyPathToken, isPathToken, pathTokenMatcher, stripPathToken,
  stripUrlToken, urlTokenMatcher, terminalLinkSpans
} = loadTs('src/shared/terminalPaths.ts');

/** Every token the provider would underline on one line of output. */
function tokensIn(line) {
  const re = pathTokenMatcher();
  const out = [];
  let m;
  while ((m = re.exec(line)) !== null) {
    const p = stripPathToken(m[0]);
    if (isPathToken(p)) out.push(p);
  }
  return out;
}

/* ---------------------------------------------------------------- *
 * classification
 * ---------------------------------------------------------------- */

test('markdown previews, source edits — the v0.3.4 behaviour is unchanged', () => {
  assert.equal(classifyPathToken('RELEASE.md'), 'preview');
  assert.equal(classifyPathToken('docs/drops/v0.4.5.markdown'), 'preview');
  assert.equal(classifyPathToken('src/main/updater.ts'), 'edit');
  assert.equal(classifyPathToken('tools/copy-main-assets.cjs'), 'edit');
  assert.equal(classifyPathToken('electron-builder.yml'), 'edit');
  assert.equal(classifyPathToken('.github/workflows/release.yml'), 'edit');
});

test('images reveal rather than open — a click on a path is a navigation gesture', () => {
  for (const p of ['build/icon.png', 'shot.JPEG', 'a/b/logo.svg', 'anim.webp']) {
    assert.equal(classifyPathToken(p), 'reveal', p);
  }
});

test('anything we cannot honestly render reveals instead of guessing', () => {
  for (const p of ['report.pdf', 'dump.bin', 'archive.zip', 'db.sqlite', 'font.woff2']) {
    assert.equal(classifyPathToken(p), 'reveal', p);
  }
});

test('an executable never classifies as anything but reveal', () => {
  // The whole safety argument: reveal opens a file browser, it never launches.
  for (const p of ['installer.dmg', 'Payload.app', 'setup.exe', 'run.desktop']) {
    assert.equal(classifyPathToken(p), 'reveal', p);
  }
});

/* ---------------------------------------------------------------- *
 * matching — the part that goes wrong
 * ---------------------------------------------------------------- */

test('version strings and decimals are not files', () => {
  assert.deepEqual(tokensIn('bumped to v0.4.5 after 1.5 hours, cost $0.92'), []);
  assert.deepEqual(tokensIn('electron 43.0 and vite 7.1.2'), []);
});

test('a bare unknown extension needs a separator to count as a path', () => {
  // No separator and an extension we do not know: could be prose. Left alone.
  assert.deepEqual(tokensIn('the release is codenamed spring.thaw'), []);
  // Same extension, now unambiguously a path.
  assert.deepEqual(tokensIn('wrote out/spring.thaw'), ['out/spring.thaw']);
});

test('a known extension is a path with or without a separator', () => {
  assert.deepEqual(tokensIn('see RELEASE.md'), ['RELEASE.md']);
  assert.deepEqual(tokensIn('edited package.json'), ['package.json']);
});

test('several tokens on one line all resolve independently', () => {
  assert.deepEqual(
    tokensIn('moved src/main/updater.ts and build/icon.png, see RELEASE.md'),
    ['src/main/updater.ts', 'build/icon.png', 'RELEASE.md']
  );
});

test('shell and prose wrapping comes off, and so does :line', () => {
  assert.equal(stripPathToken('`src/main/index.ts`'), 'src/main/index.ts');
  assert.equal(stripPathToken('"docs/a.md",'), 'docs/a.md');
  assert.equal(stripPathToken('(build/icon.png)'), 'build/icon.png');
  assert.equal(stripPathToken('src/main/updater.ts:165'), 'src/main/updater.ts');
});

test('a :line suffix survives matching and still classifies by extension', () => {
  assert.deepEqual(tokensIn('fails at src/main/updater.ts:165'), ['src/main/updater.ts']);
  assert.equal(classifyPathToken('src/main/updater.ts'), 'edit');
});

test('absolute, home, and Windows paths are all recognised', () => {
  assert.deepEqual(tokensIn('at /Users/x/notes.md'), ['/Users/x/notes.md']);
  assert.deepEqual(tokensIn('at ~/HarnessAgents/board.md'), ['~/HarnessAgents/board.md']);
  assert.deepEqual(tokensIn('at C:\\Users\\x\\a.ts'), ['C:\\Users\\x\\a.ts']);
});

test('a dotted directory name cannot masquerade as an extension', () => {
  // extOf looks at the LAST segment only, so v1.2 here is not the extension.
  assert.equal(classifyPathToken('reports/v1.2/summary.md'), 'preview');
});

test('case does not decide the verdict', () => {
  assert.equal(classifyPathToken('README.MD'), 'preview');
  assert.equal(classifyPathToken('src/App.TSX'), 'edit');
});

/* ---------------------------------------------------------------- *
 * URLs (issue #281)
 * ---------------------------------------------------------------- */

/** Every URL the provider would underline on one line of output. */
function urlsIn(line) {
  const re = urlTokenMatcher();
  const out = [];
  let m;
  while ((m = re.exec(line)) !== null) {
    const u = stripUrlToken(m[0]);
    if (u) out.push(u);
  }
  return out;
}

test('a bare https URL in agent output is matched', () => {
  assert.deepEqual(urlsIn('docs at https://example.com/guide'), ['https://example.com/guide']);
});

test('prose punctuation after a URL is not part of it', () => {
  assert.deepEqual(urlsIn('(see https://a.io/b).'), ['https://a.io/b']);
  assert.deepEqual(urlsIn('read https://a.io/b, then stop'), ['https://a.io/b']);
});

test('http is deliberately not matched — the opener would refuse it', () => {
  // app:openExternal accepts https (plus the two settings schemes) and nothing
  // else, so underlining http:// would promise a click that cannot work.
  assert.deepEqual(urlsIn('http://insecure.example/x'), []);
});

test('a plain path is not a URL, and a URL is not a path token', () => {
  assert.deepEqual(urlsIn('fails at src/main/updater.ts:165'), []);
  // The bug: the path matcher's Windows-drive branch reads the `s:/` inside
  // `https://` as drive `s:`, so the URL matches as an absolute path. That is
  // why the provider must scan URLs first and skip their spans — otherwise the
  // URL underlines as a path, resolves nowhere, and the click does nothing.
  assert.deepEqual(tokensIn('https://x.com/docs/guide.html'), ['s://x.com/docs/guide.html']);
});

test('a dotless host still matches, so localhost URLs are clickable', () => {
  assert.deepEqual(urlsIn('serving https://localhost:3000/app'), ['https://localhost:3000/app']);
});

/* ---------------------------------------------------------------- *
 * span composition — URLs must win overlaps with path tokens
 * ---------------------------------------------------------------- */

const kinds = (line) => terminalLinkSpans(line).map((s) => `${s.kind}:${s.token}`);

test('a URL yields exactly one span, and it is a url — not a path', () => {
  // Without the URL-first ordering the path matcher claims this same text as
  // drive `s:`, which is the whole defect: one underline that goes nowhere.
  assert.deepEqual(kinds('https://x.com/docs/guide.html'), ['url:https://x.com/docs/guide.html']);
});

test('a path and a URL on one line both survive, in reading order', () => {
  assert.deepEqual(
    kinds('edit src/app.ts:12 then read https://x.com/g.html'),
    ['path:src/app.ts', 'url:https://x.com/g.html']
  );
});

test('spans never overlap each other', () => {
  const spans = terminalLinkSpans('see https://a.io/b.html and src/x.ts:1 now');
  for (let i = 1; i < spans.length; i++) {
    assert.ok(spans[i].start >= spans[i - 1].end, 'spans must be disjoint and ordered');
  }
});

test('a line with neither yields nothing', () => {
  assert.deepEqual(terminalLinkSpans('just some prose, nothing to click'), []);
});

test('an uppercase scheme is still a URL, and reaches the opener lowercased', () => {
  // HTTPS:// used to fall through to the path matcher as drive `S:` — the exact
  // #281 symptom. The scheme is lowercased because the main-process opener
  // matches `^https://` case-sensitively; the rest of the URL is left alone.
  assert.deepEqual(kinds('HTTPS://UPPER.COM/x'), ['url:https://UPPER.COM/x']);
  assert.deepEqual(kinds('Https://Mixed.com/a'), ['url:https://Mixed.com/a']);
});

test('a balanced bracket belongs to the URL, an unbalanced one is prose', () => {
  assert.deepEqual(urlsIn('https://en.wikipedia.org/wiki/Foo_(bar)'),
    ['https://en.wikipedia.org/wiki/Foo_(bar)']);
  assert.deepEqual(urlsIn('(see https://a.io/b)'), ['https://a.io/b']);
  assert.deepEqual(urlsIn('(see https://en.wikipedia.org/wiki/Foo_(bar)).'),
    ['https://en.wikipedia.org/wiki/Foo_(bar)']);
});

test('a bare scheme with nothing after it is not a link', () => {
  assert.deepEqual(kinds('see https://)'), []);
  assert.deepEqual(kinds('https://'), []);
});
