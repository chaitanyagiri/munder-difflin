'use strict';
// pickDownloadAsset: the manual-update button should download the one asset
// that installs on this machine, and fall back to the releases page otherwise.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { pickDownloadAsset } = loadTs('src/main/updater.ts');

const assets = [
  { name: 'Munder-Difflin-0.5.0-mac-arm64.dmg', browser_download_url: 'https://github.com/x/y/releases/download/v0.5.0/Munder-Difflin-0.5.0-mac-arm64.dmg' },
  { name: 'Munder-Difflin-0.5.0-mac-arm64.zip', browser_download_url: 'https://github.com/x/y/releases/download/v0.5.0/Munder-Difflin-0.5.0-mac-arm64.zip' },
  { name: 'Munder-Difflin-0.5.0-mac-x64.dmg', browser_download_url: 'https://github.com/x/y/releases/download/v0.5.0/Munder-Difflin-0.5.0-mac-x64.dmg' },
  { name: 'Munder-Difflin-0.5.0-win-x64-setup.exe', browser_download_url: 'https://github.com/x/y/releases/download/v0.5.0/Munder-Difflin-0.5.0-win-x64-setup.exe' },
  { name: 'Munder-Difflin-0.5.0-win-x64-portable.exe', browser_download_url: 'https://github.com/x/y/releases/download/v0.5.0/Munder-Difflin-0.5.0-win-x64-portable.exe' },
  { name: 'Munder-Difflin-0.5.0-linux-x86_64.AppImage', browser_download_url: 'https://github.com/x/y/releases/download/v0.5.0/Munder-Difflin-0.5.0-linux-x86_64.AppImage' },
  { name: 'latest-mac.yml', browser_download_url: 'https://github.com/x/y/releases/download/v0.5.0/latest-mac.yml' }
];

test('picks the dmg for the running mac arch, not the zip', () => {
  assert.match(pickDownloadAsset(assets, 'darwin', 'arm64'), /mac-arm64\.dmg$/);
  assert.match(pickDownloadAsset(assets, 'darwin', 'x64'), /mac-x64\.dmg$/);
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
