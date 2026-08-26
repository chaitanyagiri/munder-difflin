'use strict';

const { copyFileSync, mkdirSync, statSync } = require('node:fs');
const { dirname, join } = require('node:path');

const ROOT = join(__dirname, '..');
const MAIN_ASSETS = [
  ['src/main/slack-trigger.cjs', 'out/main/slack-trigger.cjs'],
  // Knowledge Graph core (pure-JS, no native deps) — required by knowledge.ts.
  ['src/main/kg-core.cjs', 'out/main/kg-core.cjs'],
  // Web UI browser shims — served verbatim to browsers by webui.ts.
  ['src/main/webui-client/boot.js', 'out/main/webui-client/boot.js'],
  ['src/main/webui-client/cleanup.js', 'out/main/webui-client/cleanup.js'],
];

for (const [fromRel, toRel] of MAIN_ASSETS) {
  const from = join(ROOT, fromRel);
  const to = join(ROOT, toRel);

  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);

  const copied = statSync(to);
  if (!copied.isFile() || copied.size === 0) {
    throw new Error(`Failed to copy required main-process asset: ${fromRel} -> ${toRel}`);
  }
  console.log(`[copy-main-assets] ${fromRel} -> ${toRel}`);
}
