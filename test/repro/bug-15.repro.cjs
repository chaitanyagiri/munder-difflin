'use strict';
// BUG: Manual update download on macOS 404s.
//
// installerUrl (src/shared/updateState.ts) builds
//   Munder-Difflin-<v>-mac-<process.arch>.dmg
// and pickDownloadAsset (src/main/updater.ts) matches /-mac-<arch>\.dmg$/,
// but electron-builder.yml builds the mac dmg target with arch: [universal]
// and artifactName Munder-Difflin-${version}-mac-${arch}.${ext}, so the only
// mac dmg a release ever ships is
//   Munder-Difflin-<v>-mac-universal.dmg
// Neither -mac-arm64.dmg nor -mac-x64.dmg exists.
//
// Consequence on any Mac (Apple Silicon or Intel): when the native updater
// fails its check, fallbackCheck emits 'available-manual' with
// downloadUrl = pickDownloadAsset(realAssets) = null, manualDownloadUrl then
// falls back to installerUrl, and every manual-download entry point
// (toolbar badge click, Settings "Download manually", SettingsHeroCard) opens
// a GitHub release URL that returns 404.
//
// This repro derives the asset set from the REAL electron-builder.yml at the
// repo root (parsed with the app's own js-yaml) instead of hard-coding names:
// it simulates electron-builder's ${arch} substitution the same way
// electron-builder does (universal builds are single-arch and keep the
// literal name "universal" as ${arch}). It then runs the REAL installerUrl,
// REAL manualDownloadUrl, and REAL pickDownloadAsset from src/ against that
// set, for both darwin/arm64 and darwin/x64, and asserts every generated
// manual-download URL is a URL to an asset that actually ships.
//
// FAILS on the current code (404 URLs on macOS).
// PASSES after a correct fix (e.g. emitting/serving -mac-universal.dmg, or
// building per-arch dmgs whose names the matchers expect).
//
// No network, no Electron: pure logic + config parsing, loaded through
// test/load-ts.cjs like the other tests.

const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const loadTs = require(path.join(__dirname, '..', 'load-ts.cjs'));

// --- Real modules under test (from src/, not reimplemented) -----------------
const { installerUrl, manualDownloadUrl } = loadTs('src/shared/updateState.ts');
const { pickDownloadAsset } = loadTs('src/main/updater.ts');

// --- Derive the mac asset names electron-builder actually produces ---------
// Parse the real electron-builder.yml with the app's own yaml dependency so
// the repro tracks config changes instead of pinning a copy of it.
const jsYaml = require(path.join(ROOT, 'node_modules', 'js-yaml'));
const builderCfg = jsYaml.load(
  fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8')
);
const macCfg = builderCfg.mac;
const macArtifactName = macCfg.artifactName;
const macTargets = macCfg.target.map((t) =>
  typeof t === 'string' ? { target: t, arch: ['x64', 'arm64', 'universal'] } : t
);

// Simulate what `npx electron-builder --mac` (the release workflow's exact
// command) writes into dist/. For each target x arch, substitute the
// ${version}/${arch}/${ext} placeholders exactly like electron-builder's
// artifactName does. A "universal" arch build emits a single file whose
// ${arch} literally reads "universal".
function expandArtifactName(template, arch, ext, version) {
  return template
    .replace(/\$\{version\}/g, version)
    .replace(/\$\{arch\}/g, arch)
    .replace(/\$\{ext\}/g, ext);
}

const VERSION = '0.4.7'; // any clean tag; matches the failure scenario
const macAssets = [];
for (const t of macTargets) {
  for (const arch of t.arch) {
    const ext = t.target === 'dmg' ? 'dmg' : 'zip';
    macAssets.push({
      name: expandArtifactName(macArtifactName, arch, ext, VERSION),
      // electron-builder names the download exactly by the artifact name.
      browser_download_url:
        `https://github.com/chaitanyagiri/munder-difflin/releases/` +
        `download/v${VERSION}/${expandArtifactName(macArtifactName, arch, ext, VERSION)}`
    });
  }
}
// The release workflow also uploads the channel files electron-updater reads.
for (const yml of ['latest-mac.yml', 'latest-mac.yml.blockmap']) {
  macAssets.push({
    name: yml,
    browser_download_url:
      `https://github.com/chaitanyagiri/munder-difflin/releases/download/v${VERSION}/${yml}`
  });
}

// --- The failure scenario, end to end ---------------------------------------

test('electron-builder mac config is universal-only (precondition, from the real yml)', () => {
  assert.ok(macArtifactName, 'electron-builder.yml must define mac.artifactName');
  for (const t of macTargets) {
    if (t.target !== 'dmg' && t.target !== 'zip') continue;
    assert.deepEqual(
      t.arch,
      ['universal'],
      'precondition: mac targets build arch [universal] in electron-builder.yml'
    );
  }
});

test('manual update download on macOS resolves to an asset the release actually ships', () => {
  for (const arch of ['arm64', 'x64']) {
    // fallbackCheck emits available-manual with the REAL asset list. On a
    // real mac this is exactly what src/main/updater.ts:246 computes.
    const status = {
      state: 'available-manual',
      version: VERSION,
      url: `https://github.com/chaitanyagiri/munder-difflin/releases/tag/v${VERSION}`,
      reason: 'updater check failed',
      downloadUrl: pickDownloadAsset(macAssets, 'darwin', arch) ?? undefined
    };

    // The renderer (UpdateBadge click, UpdatesSection "Download manually",
    // SettingsHeroCard) resolves the URL the same way:
    const url = manualDownloadUrl(status, 'darwin', arch);

    // The URL must point at an asset name present in the simulated release.
    const assetNames = new Set(macAssets.map((a) => a.name));
    const urlFile = decodeURIComponent(url.split('/').pop());
    assert.ok(
      urlFile && assetNames.has(urlFile),
      `darwin/${arch}: manual download URL names "${urlFile}", which is NOT an asset ` +
        `the release workflow publishes (mac assets: ${[...assetNames].join(', ')}) — ` +
        `the link 404s on GitHub`
    );
    assert.equal(
      url,
      installerUrl(VERSION, 'darwin', arch),
      'sanity: without a downloadUrl the manual path falls back to installerUrl'
    );
  }
});

// The cross-check: on Windows and Linux the same chain yields working URLs,
// proving the breakage is macOS-specific, not a repro artifact.
test('control: windows and linux manual URLs name real assets (chain works there)', () => {
  const winAssets = [{
    name: `Munder-Difflin-${VERSION}-win-x64-setup.exe`,
    browser_download_url: `https://github.com/chaitanyagiri/munder-difflin/releases/download/v${VERSION}/Munder-Difflin-${VERSION}-win-x64-setup.exe`
  }];
  assert.match(
    pickDownloadAsset(winAssets, 'win32', 'x64'),
    /-win-x64-setup\.exe$/,
    'windows asset matcher hits a real artifact'
  );

  const linuxAssets = [{
    name: `Munder-Difflin-${VERSION}-linux-x86_64.AppImage`,
    browser_download_url: `https://github.com/chaitanyagiri/munder-difflin/releases/download/v${VERSION}/Munder-Difflin-${VERSION}-linux-x86_64.AppImage`
  }];
  assert.match(
    pickDownloadAsset(linuxAssets, 'linux', 'x64'),
    /-linux-x86_64\.AppImage$/,
    'linux asset matcher hits a real artifact'
  );
});
