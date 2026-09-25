'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let cached;

module.exports = function canSymlink() {
  if (cached !== undefined) return cached;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-can-symlink-'));
  try {
    const file = path.join(root, 'file');
    const dir = path.join(root, 'dir');
    fs.writeFileSync(file, 'probe');
    fs.mkdirSync(dir);
    fs.symlinkSync(file, path.join(root, 'file-link'), 'file');
    fs.symlinkSync(dir, path.join(root, 'dir-link'), 'dir');
    cached = true;
  } catch {
    cached = false;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  return cached;
};
