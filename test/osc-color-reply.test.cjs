'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { parseHexColor, oscColorBody, isDarkBackground } =
  loadTs('src/renderer/src/components/termColor.ts');

// A TUI asks the terminal for its colours with OSC 10/11 and styles itself from
// the reply. We answered nothing, so OpenCode fell back to its own default (light)
// and painted near-white panels inside a dark window.

test('#rrggbb parses to bytes', () => {
  assert.deepEqual(parseHexColor('#1a2b3c'), [0x1a, 0x2b, 0x3c]);
});

test('#rgb shorthand expands the way CSS does', () => {
  assert.deepEqual(parseHexColor('#abc'), [0xaa, 0xbb, 0xcc]);
});

test('case and surrounding space do not matter', () => {
  assert.deepEqual(parseHexColor('  #FFFFFF '), [255, 255, 255]);
});

test('anything we cannot read returns null so the query goes UNANSWERED', () => {
  // Silence is the correct failure mode. Replying with a guess is worse than not
  // replying: the TUI then styles itself confidently wrong, which is the exact
  // bug this fixes.
  for (const bad of ['', 'red', 'rgb(0,0,0)', '#12', '#12345', '#gggggg', '1a2b3c']) {
    assert.equal(parseHexColor(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('the reply widens each byte the way xterm does', () => {
  // xterm answers in 16-bit-per-channel form; doubling the byte is the
  // conventional widening, so 0x1a becomes 0x1a1a.
  assert.equal(oscColorBody(parseHexColor('#1a2b3c')), 'rgb:1a1a/2b2b/3c3c');
  assert.equal(oscColorBody(parseHexColor('#000')), 'rgb:0000/0000/0000');
});

// --- light/dark split for the DEC 2031 report ----------------------------
// A program that enables 2031 expects the CURRENT theme immediately. All we hold
// at that moment is the palette, so the answer is derived from its background.

test('the app palettes classify correctly', () => {
  assert.equal(isDarkBackground('#FCFAF0'), false, 'the cream light background');
  assert.equal(isDarkBackground('#1A1A1F'), true, 'the ink dark background');
});

test('an unreadable background assumes dark', () => {
  // Dark is the safer default for a terminal: a light-styled TUI on a dark
  // background is unreadable, the reverse is merely ugly.
  assert.equal(isDarkBackground('not a colour'), true);
});

test('the split sits where you would expect it', () => {
  assert.equal(isDarkBackground('#000000'), true);
  assert.equal(isDarkBackground('#ffffff'), false);
});
