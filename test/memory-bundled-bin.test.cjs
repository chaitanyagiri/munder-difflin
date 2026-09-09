'use strict';

/**
 * The app treats mempalace as a prerequisite the USER already installed:
 * bin() asks PATH, probes the common uv/pip spots, and gives up — on a
 * machine that has never seen Python, resolution dead-ends and the memory
 * layer silently no-ops. That install friction is what bundling removes.
 *
 * The bundled copy (electron-builder extraResources → <resourcesPath>/
 * mempalace) is wired as the LAST candidate: a user's own install must always
 * win, so bundling changes nothing on machines that already have mempalace —
 * it only makes a bare machine work out of the box.
 *
 * Determinism note: these rows sandbox every surface bin() consults — HOME/
 * USERPROFILE/LOCALAPPDATA (step 2), PATH (step 1), process.resourcesPath
 * (step 3). That is airtight on Windows, where every candidate derives from
 * env. On POSIX, step 1 goes through a LOGIN shell (whose rc files rebuild
 * PATH) and step 2 probes machine-absolute paths (/opt/homebrew, /usr/local)
 * that no env mutation can hide — so on a machine with a real mempalace these
 * rows would resolve the real one and fail for reasons unrelated to the code.
 * Skipped there rather than made flaky; the resolver logic under test is
 * platform-shared. (Making POSIX testable means injecting the candidate list,
 * deliberately out of scope for this diff.)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { MemoryManager } = loadTs('src/main/memory.ts');

const WIN = process.platform === 'win32';
const EXE = WIN ? 'mempalace.exe' : 'mempalace';

function freshManager(home) {
  return new MemoryManager(
    () => home ?? null,
    () => ({ enabled: true, model: 'minilm' })
  );
}

/**
 * Point every resolution surface bin() consults at a sandbox we control.
 *  - pathInstall: put a fake mempalace on PATH (step 1 hits)
 *  - bundled:     create <resources>/mempalace/<exe> AND set resourcesPath (step 3 hits)
 *  - bundledOnDiskOnly: create the fixture but leave resourcesPath UNSET —
 *    the plain-node/dev shape, where the fallback must stay out of the way.
 */
function sandbox(t, { pathInstall = false, bundled = false, bundledOnDiskOnly = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-bundled-bin-'));
  const saved = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    SHELL: process.env.SHELL,
    hadRes: Object.prototype.hasOwnProperty.call(process, 'resourcesPath'),
    res: process.resourcesPath
  };
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    const put = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    put('PATH', saved.PATH); put('HOME', saved.HOME); put('USERPROFILE', saved.USERPROFILE);
    put('LOCALAPPDATA', saved.LOCALAPPDATA); put('SHELL', saved.SHELL);
    if (saved.hadRes) process.resourcesPath = saved.res; else delete process.resourcesPath;
  });

  // Step-2 territory → an empty sandbox home, so ~/.local/bin etc. miss.
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, 'AppData', 'Local'), { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
  if (!WIN) process.env.SHELL = '/bin/sh';

  // Step-1 territory → keep only what `where`/`which` themselves need to run,
  // plus (optionally) one dir carrying a fake mempalace. bin() only ever
  // existsSync-checks candidates, so an empty file is a complete fixture.
  const sysDirs = WIN
    ? [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')]
    : ['/usr/bin', '/bin'];
  const dirs = [...sysDirs];
  let pathBin = null;
  if (pathInstall) {
    const d = path.join(root, 'on-path');
    fs.mkdirSync(d, { recursive: true });
    pathBin = path.join(d, EXE);
    fs.writeFileSync(pathBin, '');
    if (!WIN) fs.chmodSync(pathBin, 0o755); // `which` requires the x bit
    dirs.unshift(d);
  }
  process.env.PATH = dirs.join(path.delimiter);

  // Step-3 territory → the packaged-app resources dir.
  let bundledBin = null;
  if (bundled || bundledOnDiskOnly) {
    const res = path.join(root, 'app-resources');
    bundledBin = path.join(res, 'mempalace', EXE);
    fs.mkdirSync(path.dirname(bundledBin), { recursive: true });
    fs.writeFileSync(bundledBin, '');
    if (bundled) process.resourcesPath = res;
    else delete process.resourcesPath;
  } else {
    delete process.resourcesPath;
  }

  return { root, home, pathBin, bundledBin };
}

test('a bare machine resolves the BUNDLED copy — the whole point', { skip: !WIN }, (t) => {
  const { home, bundledBin } = sandbox(t, { bundled: true });
  const m = freshManager(home);
  assert.equal(m.bin(), bundledBin, 'no PATH hit, no pip spots — the extraResources copy must be found');
  assert.equal(m.available(), true);
  assert.equal(m.status().bin, bundledBin);
});

test('a user install on PATH beats the bundled copy', { skip: !WIN }, (t) => {
  const { home, pathBin, bundledBin } = sandbox(t, { pathInstall: true, bundled: true });
  const m = freshManager(home);
  const got = m.bin();
  assert.equal(got, pathBin, 'the maintainer requirement: a locally available mempalace always wins');
  assert.notEqual(got, bundledBin, 'bundling must change NOTHING for machines that already have it');
});

test('no user install, no bundle → the documented graceful no-op survives', { skip: !WIN }, (t) => {
  const { home } = sandbox(t);
  const m = freshManager(home);
  assert.equal(m.bin(), null);
  assert.equal(m.available(), false, 'absent CLI still degrades silently — markdown memory keeps working');
  assert.equal(m.status().available, false);
});

test('without Electron resourcesPath (dev / plain node) the fallback stays out of the way', { skip: !WIN }, (t) => {
  const { home } = sandbox(t, { bundledOnDiskOnly: true });
  const m = freshManager(home);
  assert.equal(m.bin(), null,
    'a fixture on disk with no resourcesPath must not resolve — dev behavior is exactly pre-patch');
});
