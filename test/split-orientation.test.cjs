'use strict';
// The split is opt-in: vertical remains today's default, horizontal is a
// separate layout, and the two orientations never share a pane size.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
const store = read('src/renderer/src/store/store.ts');
const app = read('src/renderer/src/App.tsx');
const splitter = read('src/renderer/src/components/SidebarSplitter.tsx');

test('vertical remains the default and no existing sidebar size changes on upgrade', () => {
  assert.match(store, /export type SplitOrientation = 'vertical' \| 'horizontal';/);
  assert.match(store, /const initialSplitOrientation[\s\S]*return "vertical";/);
  assert.match(store, /splitOrientation: initialSplitOrientation,/);
});

test('each orientation persists and selects its own pane size', () => {
  assert.match(store, /const LS_SPLIT_ORIENTATION = 'cth\.splitOrientation';/);
  assert.match(store, /const LS_SIDEBAR_HEIGHT = 'cth\.sidebarHeight';/);
  assert.match(store, /const initialSidebarHeight = \(\(\) => \{/);
  assert.match(store, /setSplitOrientation: \(orientation\) => \{[\s\S]*localStorage\.setItem\(LS_SPLIT_ORIENTATION/);
  assert.match(store, /setSidebarHeight: \(px\) => \{[\s\S]*localStorage\.setItem\(LS_SIDEBAR_HEIGHT/);
  assert.match(app, /size=\{splitOrientation === 'horizontal' \? sidebarHeight : sidebarWidth\}/);
  assert.match(app, /onChange=\{splitOrientation === 'horizontal' \? setSidebarHeight : setSidebarWidth\}/);
});

test('horizontal puts the floor above a full-width terminal and keeps title-bar control', () => {
  assert.match(app, /flexDirection: splitOrientation === 'horizontal' \? 'column' : 'row',/);
  assert.match(app, /\{ width: '100%', height: sidebarHeight \}/);
  assert.match(app, /aria-label="Toggle split orientation"/);
  assert.match(app, /<VerticalSplitGlyph \/> : <HorizontalSplitGlyph \/>/);
});

test('the splitter flips its drag axis with the layout', () => {
  assert.match(splitter, /orientation\?:/);
  assert.match(splitter, /ew-resize/);
});
