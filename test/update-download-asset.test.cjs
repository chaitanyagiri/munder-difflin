'use strict';
// pickDownloadAsset: the manual-update button should download the one asset
// that installs on this machine, and fall back to the releases page otherwise.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { pickDownloadAsset } = loadTs('src/main/updater.ts');

const assets = [
  // The release ships ONE mac dmg: electron-builder.yml builds the mac targets
  // with arch: [universal], so the artifact is -mac-universal.dmg/.zip on both
  // Apple Silicon and Intel. There is no -mac-arm64/-mac-x64 asset.
  { name: 'Munder-Difflin-0.5.0-mac-universal.dmg', browser_download_url: 'https://github.com/x/y/releases/download/v0.5.0/Munder-Difflin-0.5.0-mac-universal.dmg' },
  { name: 'Munder-Difflin-0.5.0-mac-universal.zip', browser_download_url: 'https://github.com/x/y/releases/download/v0.5.0/Munder-Difflin-0.5.0-mac-universal.zip' },
  { name: 'Munder-Difflin-0.5.0-win-x64-setup.exe', browser_download_url: 'https://github.com/x/y/releases/download/v0.5.0/Munder-Difflin-0.5.0-win-x64-setup.exe' },
  { name: 'Munder-Difflin-0.5.0-win-x64-portable.exe', browser_download_url: 'https://github.com/x/y/releases/download/v0.5.0/Munder-Difflin-0.5.0-win-x64-portable.exe' },
  { name: 'Munder-Difflin-0.5.0-linux-x86_64.AppImage', browser_download_url: 'https://github.com/x/y/releases/download/v0.5.0/Munder-Difflin-0.5.0-linux-x86_64.AppImage' },
  { name: 'latest-mac.yml', browser_download_url: 'https://github.com/x/y/releases/download/v0.5.0/latest-mac.yml' }
];

test('picks the universal dmg on any mac arch, not the zip', () => {
  // One universal build serves both arches, so both get the same working link.
  assert.match(pickDownloadAsset(assets, 'darwin', 'arm64'), /mac-universal\.dmg$/);
  assert.match(pickDownloadAsset(assets, 'darwin', 'x64'), /mac-universal\.dmg$/);
});
test('picks the installer on windows, never the portable', () => {
  assert.match(pickDownloadAsset(assets, 'win32', 'x64'), /win-x64-setup\.exe$/);
});
test('picks the AppImage on linux', () => {
  assert.match(pickDownloadAsset(assets, 'linux', 'x64'), /AppImage$/);
});
test('null when nothing matches, so the button falls back to the releases page', () => {
  assert.equal(pickDownloadAsset(assets, 'freebsd', 'x64'), null);
  assert.equal(pickDownloadAsset([], 'darwin', 'arm64'), null);
  assert.equal(pickDownloadAsset(undefined, 'darwin', 'arm64'), null);
});
