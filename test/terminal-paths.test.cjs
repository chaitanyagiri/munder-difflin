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
  classifyPathToken, isPathToken, pathTokenMatcher, stripPathToken
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
