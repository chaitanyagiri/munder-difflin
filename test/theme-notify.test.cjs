'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// DEC private mode 2031 is how a program asks to be told the terminal's theme
// changed, and CSI ? 997 ; Ps n is the notification. Answering OSC 11 only covers
// STARTUP: a TUI that painted its panels from that answer keeps them until
// something tells it to repaint, which is why flipping the app theme left
// OpenCode's boxes in the old colours.
//
// The sequence is asserted here as a literal because it is a wire format. If it
// changes, it is a protocol change and this test should be the thing that objects.

const notification = (theme) => `\x1b[?997;${theme === 'dark' ? 1 : 2}n`;

test('dark reports Ps=1', () => {
  assert.equal(notification('dark'), '\x1b[?997;1n');
});

test('light reports Ps=2', () => {
  assert.equal(notification('light'), '\x1b[?997;2n');
});

test('the two notifications differ only in Ps', () => {
  const [d, l] = [notification('dark'), notification('light')];
  assert.notEqual(d, l);
  assert.equal(d.replace(';1n', ';Xn'), l.replace(';2n', ';Xn'));
});
