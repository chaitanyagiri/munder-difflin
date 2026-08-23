'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// analytics.ts reads __POSTHOG_KEY__ (an electron-vite `define`, absent here)
// and constructs a real PostHog client. Both are stubbed BEFORE the module is
// loaded so the class can be driven end to end without a network or a key.
globalThis.__POSTHOG_KEY__ = 'test-key';
globalThis.__POSTHOG_HOST__ = 'https://example.invalid';
delete process.env.DO_NOT_TRACK;

const captured = [];
class FakePostHog {
  capture(payload) { captured.push(payload); }
  async shutdown() {}
}
const posthogPath = require.resolve('posthog-node');
require.cache[posthogPath] = {
  id: posthogPath, filename: posthogPath, loaded: true, exports: { PostHog: FakePostHog }
};

const { updateTransition, readVersionStamp, writeVersionStamp, updateVia, readUpdaterLogTail, Analytics } =
  loadTs('src/main/analytics.ts');

function stateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-update-applied-'));
}

// ── the decision ────────────────────────────────────────────────────────────

test('a brand-new install is never an update', () => {
  // first_run and update_applied must stay disjoint, or every new install
  // double-counts as an upgrade and the auto-update rate is fiction.
  assert.equal(updateTransition(null, '0.4.5', true), null);
  assert.equal(updateTransition('0.4.4', '0.4.5', true), null);
});

test('an ordinary relaunch reports nothing', () => {
  assert.equal(updateTransition('0.4.5', '0.4.5', false), null);
});

test('a version change reports both ends', () => {
  assert.deepEqual(updateTransition('0.4.4', '0.4.5', false), {
    from_version: '0.4.4',
    to_version: '0.4.5'
  });
});

test('an install that predates stamping reports from unknown', () => {
  // This is the case that makes the FIRST release carrying the event
  // measurable: the id file exists (so the app ran before) but no stamp does.
  assert.deepEqual(updateTransition(null, '0.4.5', false), {
    from_version: 'unknown',
    to_version: '0.4.5'
  });
});

test('a downgrade is reported honestly, from > to', () => {
  assert.deepEqual(updateTransition('0.4.6', '0.4.5', false), {
    from_version: '0.4.6',
    to_version: '0.4.5'
  });
});

test('prerelease versions are a legal shape on both ends', () => {
  assert.deepEqual(updateTransition('0.4.5-beta.1', '0.4.5', false), {
    from_version: '0.4.5-beta.1',
    to_version: '0.4.5'
  });
});

// ── the anonymity guarantee ─────────────────────────────────────────────────

test('a hand-edited stamp cannot smuggle a free-form value out', () => {
  // The stamp is an ordinary file in userData. TELEMETRY.md promises nothing
  // free-form is ever sent, so anything not semver-shaped degrades to unknown
  // rather than riding along as a property value.
  for (const junk of ['/Users/someone/secret-repo', 'not a version', '', '0.4', 'x'.repeat(300)]) {
    const out = updateTransition(junk, '0.4.5', false);
    assert.deepEqual(out, { from_version: 'unknown', to_version: '0.4.5' }, `junk: ${junk}`);
  }
});

test('an unnameable current version reports nothing at all', () => {
  // If we cannot say where we landed there is no event worth sending.
  assert.equal(updateTransition('0.4.4', 'main', false), null);
  assert.equal(updateTransition('0.4.4', '', false), null);
});

// ── the stamp on disk ───────────────────────────────────────────────────────

test('a missing stamp reads as null, not as a throw', () => {
  assert.equal(readVersionStamp(stateDir()), null);
  assert.equal(readVersionStamp('/nope/does/not/exist'), null);
});

test('a stamp round-trips and the trailing newline is not part of it', () => {
  const dir = stateDir();
  writeVersionStamp(dir, '0.4.5');
  assert.equal(readVersionStamp(dir), '0.4.5');
  assert.equal(fs.readFileSync(path.join(dir, 'telemetry-last-version'), 'utf8'), '0.4.5\n');
});

test('an empty stamp file reads as null', () => {
  const dir = stateDir();
  fs.writeFileSync(path.join(dir, 'telemetry-last-version'), '\n');
  assert.equal(readVersionStamp(dir), null);
});

test('the stamp lives beside the install id and dies with the data dir', () => {
  const dir = stateDir();
  writeVersionStamp(dir, '0.4.5');
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(readVersionStamp(dir), null);
});

// ── the sequence a real install walks through ───────────────────────────────

test('upgrade sequence: fires once per version change, never on a relaunch', () => {
  const dir = stateDir();
  const fired = [];
  // firstRun is true only on the boot that mints the id.
  const boot = (version, firstRun = false) => {
    const previous = readVersionStamp(dir);
    const t = updateTransition(previous, version, firstRun);
    if (previous !== version) writeVersionStamp(dir, version);
    if (t) fired.push(`${t.from_version}->${t.to_version}`);
  };

  boot('0.4.4', true); // fresh install
  boot('0.4.4');       // relaunch
  boot('0.4.5');       // auto-update lands
  boot('0.4.5');       // relaunch
  boot('0.4.5');       // relaunch
  boot('0.4.6');       // next update

  assert.deepEqual(fired, ['0.4.4->0.4.5', '0.4.5->0.4.6']);
});

test('the 0.4.4 to 0.4.5 fleet: an existing install with no stamp fires exactly once', () => {
  const dir = stateDir();          // has an install id, no stamp — the real world
  const fired = [];
  const boot = (version) => {
    const previous = readVersionStamp(dir);
    const t = updateTransition(previous, version, false);
    if (previous !== version) writeVersionStamp(dir, version);
    if (t) fired.push(`${t.from_version}->${t.to_version}`);
  };

  boot('0.4.5');
  boot('0.4.5');
  boot('0.4.5');

  assert.deepEqual(fired, ['unknown->0.4.5']);
});


// ── end to end, through the real class ──────────────────────────────────────

/** One app boot against a persistent stateDir. Returns the events it sent. */
function bootApp(dir, appVersion, { enabled = true } = {}) {
  const before = captured.length;
  new Analytics().init({ stateDir: dir, appVersion, enabled });
  return captured.slice(before).map((c) => ({ event: c.event, props: c.properties }));
}

test('e2e: a fresh install sends first_run and app_launched, never update_applied', () => {
  const names = bootApp(stateDir(), '0.4.5').map((e) => e.event);
  assert.deepEqual(names, ['first_run', 'app_launched']);
});

test('e2e: an existing 0.4.4 install starting 0.4.5 reports the upgrade once', () => {
  const dir = stateDir();
  bootApp(dir, '0.4.4');                       // the install exists and is stamped
  const second = bootApp(dir, '0.4.5');        // the update lands
  assert.deepEqual(second.map((e) => e.event), ['update_applied', 'app_launched']);
  const props = second[0].props;
  assert.equal(props.from_version, '0.4.4');
  assert.equal(props.to_version, '0.4.5');
  assert.equal(props.app_version, '0.4.5');    // common props still stamped
  assert.equal(props.$process_person_profile, false); // still an anonymous event

  const third = bootApp(dir, '0.4.5');         // relaunch: nothing extra
  assert.deepEqual(third.map((e) => e.event), ['app_launched']);
});

test('e2e: a live 0.4.4 install with no stamp reports unknown, exactly once', () => {
  // The real 0.4.4 -> 0.4.5 fleet: telemetry-install-id exists, no stamp does.
  const dir = stateDir();
  fs.writeFileSync(path.join(dir, 'telemetry-install-id'), 'a-uuid-from-0.4.4\n');

  const first = bootApp(dir, '0.4.5');
  assert.deepEqual(first.map((e) => e.event), ['update_applied', 'app_launched']);
  assert.equal(first[0].props.from_version, 'unknown');

  assert.deepEqual(bootApp(dir, '0.4.5').map((e) => e.event), ['app_launched']);
});

test('e2e: an opted-out install sends nothing and is not back-filled on opting in', () => {
  const dir = stateDir();
  fs.writeFileSync(path.join(dir, 'telemetry-install-id'), 'a-uuid\n');

  assert.deepEqual(bootApp(dir, '0.4.5', { enabled: false }), []);
  // The stamp still advanced locally, so opting back in later does NOT replay a
  // transition that happened while we were dark.
  assert.equal(readVersionStamp(dir), '0.4.5');
  assert.deepEqual(bootApp(dir, '0.4.5').map((e) => e.event), ['app_launched']);
});

test('e2e: DO_NOT_TRACK sends nothing and writes no stamp at all', () => {
  const dir = stateDir();
  process.env.DO_NOT_TRACK = '1';
  try {
    assert.deepEqual(bootApp(dir, '0.4.5'), []);
    assert.equal(readVersionStamp(dir), null);
    assert.equal(fs.existsSync(path.join(dir, 'telemetry-install-id')), false);
  } finally {
    delete process.env.DO_NOT_TRACK;
  }
});

test('e2e: an unwritable state dir reports no transition, on any boot', () => {
  // The ephemeral-id fallback cannot recognise the install across boots, so a
  // version transition here would fire on EVERY launch. It must fire on none.
  // A FIXED name here is shared with every other suite run on the machine, and
  // the collision is destructive: a concurrent run removes this file in its own
  // finally, analytics' mkdirSync(stateDir, {recursive:true}) then recreates the
  // path as a real state DIRECTORY, and the cleanup below throws EISDIR. Worse,
  // the directory outlives the run and every later suite on that machine fails
  // here until someone deletes it by hand. Per-run name, so runs cannot collide.
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'md-update-applied-')), 'file-not-a-dir');
  fs.writeFileSync(dir, 'x');                  // mkdirSync/writeFileSync will throw
  try {
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(bootApp(dir, '0.4.5').map((e) => e.event), ['app_launched']);
    }
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('e2e: the allowlist still drops a property nobody declared', () => {
  const a = new Analytics();
  a.init({ stateDir: stateDir(), appVersion: '0.4.5', enabled: true });
  const before = captured.length;
  a.track('update_applied', { from_version: '0.4.4', to_version: '0.4.5', repo_path: '/Users/me/secret' });
  const props = captured[before].properties;
  assert.equal(props.from_version, '0.4.4');
  assert.equal('repo_path' in props, false);
});


// ── via: was it OUR updater, or a manual reinstall? ─────────────────────────

/** Lines exactly as updater.ts appends them. */
const L = {
  ready: (v) => `[2026-08-20T10:00:00.000Z] native updater ready (current v${v})`,
  downloaded: (v) => `[2026-08-21T10:00:00.000Z] update downloaded: ${v} — waiting for the user to restart`,
  requested: '[2026-08-21T10:05:00.000Z] quitAndInstall requested by the user',
  failed: '[2026-08-21T10:05:00.001Z] quitAndInstall failed: ENOENT',
  cancelled: '[2026-08-21T10:05:30.000Z] quitAndInstall cancelled by the user at the quit warning',
  downloadErr: '[2026-08-21T09:00:00.000Z] download failed: socket hang up'
};
const log = (...lines) => lines.join('\n') + '\n';

test('via: the ordered pair from our own updater reads as auto', () => {
  assert.equal(updateVia(log(L.ready('0.4.4'), L.downloaded('0.4.5'), L.requested), '0.4.5'), 'auto');
});

test('via: downloaded but never restarted is manual, not auto', () => {
  // The update sat there and the user installed 0.4.5 some other way.
  assert.equal(updateVia(log(L.ready('0.4.4'), L.downloaded('0.4.5')), '0.4.5'), 'manual');
});

test('via: a leftover pair from the PREVIOUS upgrade cannot be mistaken for this one', () => {
  // This is the whole reason the match is version-aware. Without it, anyone who
  // ever used restart-to-install would read as auto forever.
  assert.equal(
    updateVia(log(L.downloaded('0.4.4'), L.requested, L.ready('0.4.4')), '0.4.5'),
    'manual'
  );
});

test('via: an attempt that threw is manual — the app never quit', () => {
  assert.equal(
    updateVia(log(L.downloaded('0.4.5'), L.requested, L.failed), '0.4.5'),
    'manual'
  );
});

test('via: a failed attempt followed by a successful one is auto', () => {
  assert.equal(
    updateVia(log(L.downloaded('0.4.5'), L.requested, L.failed, L.requested), '0.4.5'),
    'auto'
  );
});

test('via: a restart that returned cleanly and still did not install is manual', () => {
  // The failure mode the log is FOR: quitAndInstall() reports no outcome, so a
  // silent no-op looked exactly like success. The old build launching again
  // after the request is what gives it away — and this user is precisely the
  // one who then uses the manual badge, so calling it auto would credit the
  // path that failed.
  assert.equal(
    updateVia(log(L.downloaded('0.4.5'), L.requested, L.ready('0.4.4')), '0.4.5'),
    'manual'
  );
});

test('via: from_version is never needed for that — any version but ours is disproof', () => {
  // Load-bearing, because the version stamp ships WITH this event: every 0.4.5
  // upgrade reports from_version 'unknown', so a from-version-specific check
  // would do nothing for the one release this is being shipped to measure.
  assert.equal(
    updateVia(log(L.downloaded('0.4.5'), L.requested, L.ready('0.3.9')), '0.4.5'),
    'manual'
  );
});

test('via: the target launching after the request is still auto', () => {
  // The new build identifying itself is what success looks like, and updater.ts
  // may well write it before analytics reads the tail in the same process.
  assert.equal(
    updateVia(log(L.downloaded('0.4.5'), L.requested, L.ready('0.4.5')), '0.4.5'),
    'auto'
  );
});

test('via: a launch BEFORE the request says nothing about it', () => {
  assert.equal(
    updateVia(log(L.ready('0.4.4'), L.downloaded('0.4.5'), L.requested), '0.4.5'),
    'auto'
  );
});

test('via: refusing the quit warning is manual', () => {
  assert.equal(
    updateVia(log(L.downloaded('0.4.5'), L.requested, L.cancelled), '0.4.5'),
    'manual'
  );
});

test('via: a refused quit followed by one that stuck is auto', () => {
  assert.equal(
    updateVia(log(L.downloaded('0.4.5'), L.requested, L.cancelled, L.requested), '0.4.5'),
    'auto'
  );
});

test('via: the request must come AFTER the download, not before', () => {
  assert.equal(updateVia(log(L.requested, L.downloaded('0.4.5')), '0.4.5'), 'manual');
});

test('via: no log at all is unknown, never a guess in either direction', () => {
  assert.equal(updateVia(null, '0.4.5'), 'unknown');
  assert.equal(readUpdaterLogTail(stateDir()), null);
  assert.equal(readUpdaterLogTail('/nope/does/not/exist'), null);
});

test('via: an empty log is unknown, a non-empty log with no pair is manual', () => {
  const dir = stateDir();
  fs.writeFileSync(path.join(dir, 'updater.log'), '');
  assert.equal(readUpdaterLogTail(dir), null);
  assert.equal(updateVia(log(L.ready('0.4.4'), L.downloadErr), '0.4.5'), 'manual');
});

test('via: a version prefix does not match a longer version', () => {
  assert.equal(updateVia(log(L.downloaded('0.4.55'), L.requested), '0.4.5'), 'manual');
  assert.equal(updateVia(log(L.downloaded('0.4.5-beta.1'), L.requested), '0.4.5'), 'manual');
  // and the mirror: a stable download is no evidence for a prerelease target
  assert.equal(updateVia(log(L.downloaded('0.4.5'), L.requested), '0.4.5-beta.1'), 'manual');
  assert.equal(updateVia(log(L.downloaded('0.4.5-beta.1'), L.requested), '0.4.5-beta.1'), 'auto');
});

test('via: the log read is bounded and still finds a recent pair', () => {
  const dir = stateDir();
  const filler = Array.from({ length: 20000 }, (_, n) => `[2026-01-01T00:00:00.000Z] noise ${n}`).join('\n');
  fs.writeFileSync(
    path.join(dir, 'updater.log'),
    `${L.downloaded('0.4.4')}\n${filler}\n${L.downloaded('0.4.5')}\n${L.requested}\n`
  );
  const tail = readUpdaterLogTail(dir);
  assert.ok(tail.length <= 128 * 1024);
  assert.ok(tail.length < fs.statSync(path.join(dir, 'updater.log')).size); // actually truncated
  assert.equal(updateVia(tail, '0.4.5'), 'auto');
});

// ── the literals this depends on must stay in updater.ts ────────────────────

test('updater.ts still emits the exact lines via reads', () => {
  // via parses updater.log rather than adding a marker, which is what lets the
  // 0.4.4 -> 0.4.5 hop be measured at all. The cost of that choice is this
  // coupling, so it fails here rather than silently degrading the metric.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/updater.ts'), 'utf8');
  assert.ok(
    src.includes('logLine(`update downloaded: ${info.version}'),
    'updater.ts no longer logs "update downloaded: <version>" — update analytics.ts LOG_DOWNLOADED'
  );
  assert.ok(
    src.includes("logLine('quitAndInstall requested by the user')"),
    'updater.ts no longer logs the restart request — update analytics.ts LOG_QUIT_REQUESTED'
  );
  assert.ok(
    src.includes('logLine(`quitAndInstall failed:'),
    'updater.ts no longer logs the failed attempt — update analytics.ts LOG_QUIT_FAILED'
  );
  assert.ok(
    src.includes('logLine(`native updater ready (current v${app.getVersion()})`)'),
    'updater.ts no longer names the launching version — update analytics.ts LOG_READY'
  );
  assert.ok(
    src.includes("logLine('quitAndInstall cancelled by the user at the quit warning')"),
    'updater.ts no longer logs the refused quit — update analytics.ts LOG_QUIT_CANCELLED'
  );
});

test('the manual-download breadcrumb matches the URL the badge actually opens', () => {
  // Nothing reads this line yet — analytics.ts picks it up in 0.4.6, because a
  // trace of the manual path has to be written by the build being REPLACED. So
  // this is the only thing standing between it and a silent reword, and the
  // only place the two halves are checked against each other: the pattern in
  // updater.ts must match what installerUrl() hands the badge, or the one
  // release we spend waiting for it buys nothing.
  const { installerUrl, REPO } = loadTs('src/shared/updateState.ts');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/updater.ts'), 'utf8');
  assert.ok(
    src.includes('logLine(`manual download opened: ${asset[1]}`)'),
    'updater.ts no longer logs the manual download — 0.4.6 via loses the manual path'
  );
  const pattern = /const asset = (\/.+\/)\.exec\(href\);/.exec(src);
  assert.ok(pattern, 'the breadcrumb no longer derives the version from the href');
  const re = new RegExp(pattern[1].slice(1, -1));

  for (const [platform, arch] of [['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64'], ['linux', 'x64']]) {
    const hit = re.exec(installerUrl('0.4.6', platform, arch));
    assert.ok(hit, `${platform}/${arch} installer URL does not match the breadcrumb pattern`);
    assert.equal(hit[1], '0.4.6');
  }
  assert.equal(re.exec(installerUrl('0.5.0-beta.1', 'darwin', 'arm64'))[1], '0.5.0-beta.1');
  // and the notes link is NOT a download — reading the release page is not
  // choosing the manual path, and counting it as one would inflate manual.
  assert.equal(re.test(`https://github.com/${REPO}/releases/tag/v0.4.6`), false);
  assert.equal(re.test(`https://github.com/${REPO}/releases/latest`), false);
});

// ── via, end to end ─────────────────────────────────────────────────────────

test('e2e: a real 0.4.4 install that auto-updated reports via auto', () => {
  const dir = stateDir();
  fs.writeFileSync(path.join(dir, 'telemetry-install-id'), 'a-uuid-from-0.4.4\n');
  fs.writeFileSync(path.join(dir, 'updater.log'), log(L.downloaded('0.4.5'), L.requested));

  const sent = bootApp(dir, '0.4.5');
  assert.deepEqual(sent.map((e) => e.event), ['update_applied', 'app_launched']);
  assert.equal(sent[0].props.from_version, 'unknown');
  assert.equal(sent[0].props.via, 'auto');
});

test('e2e: the same install reinstalled by hand reports via manual', () => {
  const dir = stateDir();
  fs.writeFileSync(path.join(dir, 'telemetry-install-id'), 'a-uuid-from-0.4.4\n');
  fs.writeFileSync(path.join(dir, 'updater.log'), log(L.ready('0.4.4')));

  assert.equal(bootApp(dir, '0.4.5')[0].props.via, 'manual');
});

test('e2e: an install with no updater.log reports via unknown', () => {
  const dir = stateDir();
  fs.writeFileSync(path.join(dir, 'telemetry-install-id'), 'a-uuid-from-0.4.4\n');
  assert.equal(bootApp(dir, '0.4.5')[0].props.via, 'unknown');
});

test('e2e: via is only ever one of the three enum values', () => {
  const dir = stateDir();
  fs.writeFileSync(path.join(dir, 'telemetry-install-id'), 'a-uuid\n');
  fs.writeFileSync(path.join(dir, 'updater.log'), log(L.downloaded('0.4.5'), L.requested));
  const props = bootApp(dir, '0.4.5')[0].props;
  assert.ok(['auto', 'manual', 'unknown'].includes(props.via));
  // and nothing from the log itself rode along
  assert.deepEqual(Object.keys(props).sort(), [
    '$process_person_profile', 'app_version', 'arch', 'from_version', 'os', 'to_version', 'via'
  ]);
});
