'use strict';

/**
 * Images in the IDE.
 *
 * Opening a .png used to produce a tab that said "binary file (not displayable)"
 * — the text reader rejects anything containing a null byte, and it was the only
 * reader the renderer had. Images now travel as raw bytes over a separate,
 * root-confined, size-capped read and become a blob URL in the renderer.
 *
 * The three things worth pinning down are the ones that are silent when they
 * break: the extension→mime table (three call sites depend on agreeing about
 * it), the path-traversal guard on the new binary read, and the size cap that
 * keeps a huge file from being pulled into the renderer whole.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { extensionOf, imageMimeForPath, isImagePath, isSvgPath, formatBytes } = loadTs('src/shared/imageTypes.ts');
const { readFileBinary } = loadTs('src/main/fs.ts');
const { resolveLocalImageRel, resolveRel } = loadTs('src/renderer/src/markdown/mdLinks.ts');

// ─── extension → mime ───────────────────────────────────────────────────────

test('detects the image formats agents actually produce', () => {
  assert.equal(imageMimeForPath('shot.png'), 'image/png');
  assert.equal(imageMimeForPath('photo.jpg'), 'image/jpeg');
  assert.equal(imageMimeForPath('photo.jpeg'), 'image/jpeg');
  assert.equal(imageMimeForPath('anim.gif'), 'image/gif');
  assert.equal(imageMimeForPath('modern.webp'), 'image/webp');
  assert.equal(imageMimeForPath('icon.svg'), 'image/svg+xml');
  assert.equal(imageMimeForPath('old.bmp'), 'image/bmp');
  assert.equal(imageMimeForPath('fav.ico'), 'image/x-icon');
  assert.equal(imageMimeForPath('new.avif'), 'image/avif');
});

test('extension matching is case-insensitive', () => {
  // macOS screenshots and camera exports both ship upper-case extensions.
  assert.equal(imageMimeForPath('Screenshot.PNG'), 'image/png');
  assert.equal(imageMimeForPath('IMG_0001.JPG'), 'image/jpeg');
  assert.ok(isImagePath('/abs/path/A.WebP'));
});

test('non-images are not images', () => {
  for (const p of ['notes.md', 'index.ts', 'Makefile', 'archive.tar.gz', 'a.png.bak', '']) {
    assert.equal(imageMimeForPath(p), null, `${p} must not be treated as an image`);
    assert.equal(isImagePath(p), false);
  }
});

test('query strings and hashes do not hide the extension', () => {
  // Agent-written markdown carries cache-busters; treating `png?v=2` as the
  // extension would silently drop exactly the screenshots we want to render.
  assert.equal(extensionOf('shot.png?v=2'), 'png');
  assert.equal(extensionOf('shot.png#fig1'), 'png');
  assert.ok(isImagePath('./out/shot.png?v=2'));
});

test('a dotted DIRECTORY name cannot masquerade as an extension', () => {
  assert.equal(extensionOf('v1.2/report'), '');
  assert.equal(isImagePath('release-1.png/report'), false);
});

test('svg is flagged separately — it is the one image that is also source', () => {
  assert.ok(isSvgPath('logo.svg'));
  assert.ok(isSvgPath('a/b/LOGO.SVG'));
  assert.equal(isSvgPath('logo.png'), false);
});

test('formatBytes reads like a status line', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(864), '864 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
  assert.equal(formatBytes(-1), '—');
});

// ─── markdown <img src> resolution ──────────────────────────────────────────

test('local markdown images resolve against the document directory', () => {
  assert.equal(resolveLocalImageRel('docs/report.md', './img/shot.png'), 'docs/img/shot.png');
  assert.equal(resolveLocalImageRel('docs/report.md', 'shot.png'), 'docs/shot.png');
  assert.equal(resolveLocalImageRel('docs/deep/report.md', '../shot.png'), 'docs/shot.png');
  assert.equal(resolveLocalImageRel('report.md', 'out/shot.png?v=3'), 'out/shot.png');
});

test('a leading slash means the WORKSPACE root, not the filesystem root', () => {
  assert.equal(resolveLocalImageRel('docs/report.md', '/assets/shot.png'), 'assets/shot.png');
  // Worst case it names a path that simply does not exist inside the workspace.
  assert.equal(resolveLocalImageRel('docs/report.md', '/etc/secret.png'), 'etc/secret.png');
});

test('anything with a URI scheme is refused', () => {
  // Remote URLs are dead under the CSP anyway; proxying them through the main
  // process would turn a rendered report into a beacon for whoever wrote it.
  for (const src of [
    'https://evil.example/track.png',
    'http://evil.example/track.png',
    'data:image/png;base64,AAAA',
    'file:///etc/passwd.png',
    'javascript:alert(1)'
  ]) {
    assert.equal(resolveLocalImageRel('docs/report.md', src), null, `${src} must not resolve`);
  }
});

test('non-image sources are refused even when local', () => {
  assert.equal(resolveLocalImageRel('docs/report.md', './secrets.env'), null);
  assert.equal(resolveLocalImageRel('docs/report.md', '../../.ssh/id_rsa'), null);
  assert.equal(resolveLocalImageRel('docs/report.md', undefined), null);
  assert.equal(resolveLocalImageRel('docs/report.md', '   '), null);
});

test('`..` can never climb above the workspace root textually', () => {
  // Not the security boundary (safeResolve is), but it must not even try.
  assert.equal(resolveRel('a/b/c.md', '../../../../../etc/passwd'), 'etc/passwd');
  assert.equal(resolveLocalImageRel('a/b.md', '../../../../x.png'), 'x.png');
});

// ─── the binary read itself ─────────────────────────────────────────────────

/** A 1×1 PNG — a real file with a null byte in its header, i.e. exactly what the
 *  text reader refuses. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cth-img-'));
  const root = path.join(dir, 'workspace');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'shot.png'), ONE_PIXEL_PNG);
  // A sibling of the root, i.e. the thing traversal would be reaching for.
  fs.writeFileSync(path.join(dir, 'outside.png'), ONE_PIXEL_PNG);
  return { dir, root };
}

test('reads an image the text reader refuses, with its mime and size', async () => {
  const { dir, root } = makeWorkspace();
  try {
    const res = await readFileBinary(root, 'docs/shot.png');
    assert.equal(res.ok, true, res.ok ? '' : res.error);
    assert.equal(res.mime, 'image/png');
    assert.equal(res.size, ONE_PIXEL_PNG.length);
    assert.ok(Buffer.from(res.bytes).equals(ONE_PIXEL_PNG), 'bytes must round-trip exactly');
    assert.ok(res.bytes.includes(0), 'the null byte is the whole reason this path exists');
    assert.equal(
      res.bytes.byteLength, res.bytes.buffer.byteLength,
      'bytes must be COPIED into their own buffer — a pooled Buffer would ship unrelated file data across IPC'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('path traversal out of the root is rejected', async () => {
  const { dir, root } = makeWorkspace();
  try {
    for (const rel of [
      '../outside.png',
      'docs/../../outside.png',
      path.join(dir, 'outside.png'), // absolute, outside the root
      '/etc/hosts'
    ]) {
      const res = await readFileBinary(root, rel);
      assert.equal(res.ok, false, `${rel} must not be readable`);
      assert.equal(res.error, 'path escapes root');
    }
    // …while an absolute path INSIDE the root is still fine (safeResolve's rule).
    const inside = await readFileBinary(root, path.join(root, 'docs', 'shot.png'));
    assert.equal(inside.ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the size cap is enforced before any bytes are read', async () => {
  const { dir, root } = makeWorkspace();
  try {
    const res = await readFileBinary(root, 'docs/shot.png', 8);
    assert.equal(res.ok, false);
    assert.match(res.error, /too large/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the default cap clears a retina screenshot (the 2 MB text cap did not)', async () => {
  const { dir, root } = makeWorkspace();
  try {
    // 2.5 MB: over the text reader's MAX_READ_BYTES, comfortably under this one.
    const big = path.join(root, 'docs', 'big.png');
    fs.writeFileSync(big, Buffer.concat([ONE_PIXEL_PNG, Buffer.alloc(2.5 * 1024 * 1024)]));
    const res = await readFileBinary(root, 'docs/big.png');
    assert.equal(res.ok, true, res.ok ? '' : res.error);
    assert.ok(res.size > 2 * 1024 * 1024);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('non-regular files are refused rather than opened', async () => {
  const { dir, root } = makeWorkspace();
  try {
    // A directory read would throw; a FIFO would BLOCK FOREVER with no size to
    // check, hanging the IPC call and the renderer's loading state with it.
    const res = await readFileBinary(root, 'docs');
    assert.equal(res.ok, false);
    assert.equal(res.error, 'not a regular file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing file reports an error instead of throwing', async () => {
  const { dir, root } = makeWorkspace();
  try {
    const res = await readFileBinary(root, 'docs/nope.png');
    assert.equal(res.ok, false);
    assert.match(res.error, /ENOENT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown binary types still read, labelled octet-stream', async () => {
  const { dir, root } = makeWorkspace();
  try {
    fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
    const res = await readFileBinary(root, 'blob.bin');
    assert.equal(res.ok, true);
    assert.equal(res.mime, 'application/octet-stream', 'never guess an image mime for an unknown extension');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
