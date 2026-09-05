'use strict';

/**
 * The workspace root is the confinement boundary for the file IPC: the renderer
 * may only reach files INSIDE the selected workspace.
 *
 * A purely lexical containment check cannot enforce that. `resolve`/`normalize`/
 * `relative` are string math — they know nothing about symlinks — while the
 * `readFile`/`writeFile`/`readdir` that runs afterwards is resolved by the
 * kernel, which DOES follow them. So a symlink planted inside the workspace
 * (agent-generated content and cloned repos both routinely contain them) reads
 * as an in-root relative name to the guard and as an external file to the sink.
 *
 * These tests pin the boundary against that: every escape below must be refused
 * by the shared guard, on every consumer of it, while ordinary in-workspace
 * reads and writes keep working.
 *
 * The boundary is the workspace, not "no symlinks at all" — a link to a target
 * that is itself inside the workspace is followed — so the legitimate case is
 * pinned here too, in both directions.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { readFileText, readFileBinary, writeFileText, listDir } = loadTs('src/main/fs.ts');
const { getDiff } = loadTs('src/main/git.ts');

const SECRET = 'external-secret-contents\n';

/**
 * A throwaway workspace with an `outside` sibling standing in for the rest of
 * the user's filesystem. Every symlink here points at that sibling — no test
 * touches a real file outside its own temp dir.
 */
function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-containment-'));
  const root = path.join(dir, 'workspace');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'dir'), { recursive: true });

  fs.writeFileSync(path.join(outside, 'secret.txt'), SECRET);
  fs.writeFileSync(path.join(outside, 'secret.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  fs.writeFileSync(path.join(outside, 'dir', 'deep.txt'), SECRET);
  fs.writeFileSync(path.join(outside, 'overwrite-me.txt'), 'original\n');

  // Ordinary, legitimate workspace content.
  fs.writeFileSync(path.join(root, 'real.txt'), 'in-workspace\n');
  fs.writeFileSync(path.join(root, 'docs', 'shot.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02]));

  // (a) final-component symlinks to external targets
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'innocent.txt'));
  fs.symlinkSync(path.join(outside, 'secret.bin'), path.join(root, 'innocent.bin'));
  fs.symlinkSync(path.join(outside, 'overwrite-me.txt'), path.join(root, 'notes.txt'));
  // (b) an intermediate directory symlink — the escape is a path COMPONENT
  fs.symlinkSync(path.join(outside, 'dir'), path.join(root, 'sub'));
  // (c) a DANGLING final symlink: its target does not exist yet, so a write
  //     through it CREATES the external file.
  fs.symlinkSync(path.join(outside, 'newly-created.txt'), path.join(root, 'dangling.txt'));
  // (d) links that stay INSIDE the workspace and point at something that exists.
  //     These are the legitimate case — node_modules and monorepo checkouts are
  //     full of them — and they must keep working.
  fs.symlinkSync(path.join(root, 'real.txt'), path.join(root, 'alias.txt'));
  fs.symlinkSync(path.join(root, 'docs'), path.join(root, 'docs-link'));

  return { dir, root, outside };
}

function withWorkspace(fn) {
  const ws = makeWorkspace();
  return Promise.resolve(fn(ws)).finally(() => fs.rmSync(ws.dir, { recursive: true, force: true }));
}

// ─── reads ──────────────────────────────────────────────────────────────────

test('a final-component symlink cannot be read as text', () => withWorkspace(async ({ root }) => {
  const res = await readFileText(root, 'innocent.txt');
  assert.equal(res.ok, false, 'a symlink out of the workspace must not be readable');
  assert.equal(res.content, undefined);
}));

test('a final-component symlink cannot be read as bytes', () => withWorkspace(async ({ root }) => {
  const res = await readFileBinary(root, 'innocent.bin');
  assert.equal(res.ok, false, 'the binary reader shares the boundary and must refuse too');
}));

test('an intermediate directory symlink cannot be read through', () => withWorkspace(async ({ root }) => {
  const res = await readFileText(root, 'sub/deep.txt');
  assert.equal(res.ok, false, 'the escape can be any component, not just the last one');
}));

// ─── writes ─────────────────────────────────────────────────────────────────

test('a final-component symlink cannot be written through', () => withWorkspace(async ({ root, outside }) => {
  const target = path.join(outside, 'overwrite-me.txt');
  const before = fs.readFileSync(target, 'utf8');
  const res = await writeFileText(root, 'notes.txt', 'clobbered\n');
  assert.equal(res.ok, false, 'writing through a symlink must be refused');
  assert.equal(fs.readFileSync(target, 'utf8'), before, 'the external file must be untouched');
}));

test('a dangling symlink cannot be used to create a file outside the workspace', () =>
  withWorkspace(async ({ root, outside }) => {
    // The link target does not exist, so `realpath` cannot see where this leads —
    // canonicalization alone would let the write through and CREATE the external
    // file. Only an lstat walk (and an O_NOFOLLOW open) catches this one.
    const res = await writeFileText(root, 'dangling.txt', 'created outside\n');
    assert.equal(res.ok, false, 'a dangling symlink is still a symlink');
    assert.equal(
      fs.existsSync(path.join(outside, 'newly-created.txt')), false,
      'no file may be created outside the workspace'
    );
  }));

// ─── the other consumers of the same guard ──────────────────────────────────

test('listDir cannot list a directory outside the workspace', () => withWorkspace(async ({ root }) => {
  const res = await listDir(root, 'sub');
  assert.equal(res.ok, false, 'the directory listing shares the boundary');
}));

test('the git diff path check refuses a symlink escape', () => withWorkspace(async ({ root }) => {
  const res = await getDiff(root, 'innocent.txt');
  assert.equal(res.ok, false, 'git path operations validate against the same boundary');
  assert.equal(res.working, undefined, 'the external file contents must never be returned');
}));

// ─── and ordinary workspace use still works ─────────────────────────────────

test('ordinary in-workspace reads and writes still succeed', () => withWorkspace(async ({ root }) => {
  const text = await readFileText(root, 'real.txt');
  assert.equal(text.ok, true, text.ok ? '' : text.error);
  assert.equal(text.content, 'in-workspace\n');

  const bin = await readFileBinary(root, 'docs/shot.bin');
  assert.equal(bin.ok, true, bin.ok ? '' : bin.error);
  assert.equal(bin.size, 6);

  const created = await writeFileText(root, 'docs/new.txt', 'hello\n');
  assert.equal(created.ok, true, created.ok ? '' : created.error);
  assert.equal(fs.readFileSync(path.join(root, 'docs', 'new.txt'), 'utf8'), 'hello\n');

  const overwritten = await writeFileText(root, 'real.txt', 'replaced\n');
  assert.equal(overwritten.ok, true, overwritten.ok ? '' : overwritten.error);
  assert.equal(fs.readFileSync(path.join(root, 'real.txt'), 'utf8'), 'replaced\n');

  const listed = await listDir(root, 'docs');
  assert.equal(listed.ok, true, listed.ok ? '' : listed.error);
  assert.ok(listed.entries.some((e) => e.name === 'shot.bin'));
}));

test('an in-workspace symlink to an in-workspace target is followed, not refused', () =>
  withWorkspace(async ({ root }) => {
    // The boundary is the workspace, not "no symlinks at all": a link whose
    // target is itself inside the workspace reaches nothing the caller could not
    // already reach by its real name. Refusing it would make an ordinary
    // node_modules or monorepo checkout unbrowsable for no security gain. This
    // pins that so the policy cannot be flipped by accident.
    const viaLink = await readFileText(root, 'alias.txt');
    assert.equal(viaLink.ok, true, viaLink.ok ? '' : viaLink.error);
    assert.equal(viaLink.content, 'in-workspace\n');
    assert.equal(
      viaLink.path, path.join(fs.realpathSync(root), 'real.txt'),
      'the link resolves to the canonical path of its target, not to the link'
    );

    const listed = await listDir(root, 'docs-link');
    assert.equal(listed.ok, true, listed.ok ? '' : listed.error);
    assert.ok(listed.entries.some((e) => e.name === 'shot.bin'), 'a directory link lists its target');
  }));

test('the git diff read refuses a final component swapped for a symlink mid-call', {
  skip: process.platform === 'win32' ? 'needs a POSIX shell shim and symlinks' : false
}, () => withWorkspace(async ({ root, outside, dir }) => {
  // Validating a path and then reading it are two separate resolutions, and the
  // kernel redoes the lookup at open time. `getDiff` runs `git show HEAD:<path>`
  // between the two, so shadowing `git` with a script that plants the symlink
  // puts an attacker in exactly that window — deterministically, rather than
  // hoping to win a race. The read must refuse what it is handed, not trust that
  // the earlier check still holds.
  const target = path.join(root, 'real.txt');
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);
  const shim = path.join(binDir, 'git');
  fs.writeFileSync(
    shim,
    `#!/bin/sh\nrm -f '${target}'\nln -s '${path.join(outside, 'secret.txt')}' '${target}'\nexit 1\n`
  );
  fs.chmodSync(shim, 0o755);

  const savedPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${savedPath}`;
  let res;
  try {
    res = await getDiff(root, 'real.txt');
  } finally {
    process.env.PATH = savedPath;
  }

  assert.equal(fs.lstatSync(target).isSymbolicLink(), true, 'the shim must have run inside the window');
  assert.equal(res.ok, true, res.ok ? '' : res.error);
  assert.equal(res.workingExists, false, 'a symlink is not the regular file the guard cleared');
  assert.equal(res.working, '', 'the external file contents must never reach the renderer');
}));

test('lexical traversal out of the root is still rejected', () => withWorkspace(async ({ root, dir }) => {
  for (const rel of ['../outside/secret.txt', 'docs/../../outside/secret.txt', path.join(dir, 'outside', 'secret.txt')]) {
    const res = await readFileText(root, rel);
    assert.equal(res.ok, false, `${rel} must not be readable`);
    assert.equal(res.error, 'path escapes root');
  }
}));
