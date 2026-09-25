'use strict';
/**
 * Upstream issue #481: Shift+Enter at a prompt inside the embedded terminal
 * submits instead of inserting a newline. xterm.js encodes Shift+Enter exactly
 * like Enter — a bare CR — so the TUI cannot tell them apart. Terminals that
 * get this right send ESC CR, which is what Claude Code's `/terminal-setup`
 * installs for iTerm2 and VS Code; nothing configures our pane, so the pane has
 * to send it. These tests pin the mapping, and pin how narrow it is: every other
 * Enter combination is left to xterm and to the TUI.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { terminalKeySequence, NEWLINE_SEQUENCE } = loadTs('src/renderer/src/components/terminalKeys.ts');

/** A KeyboardEvent as the handler sees it. */
const key = (over = {}) => ({
  type: 'keydown', key: 'Enter',
  shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...over
});

test('Shift+Enter sends ESC CR — the sequence /terminal-setup installs', () => {
  assert.equal(terminalKeySequence(key({ shiftKey: true })), '\x1b\r');
  assert.equal(NEWLINE_SEQUENCE, '\x1b\r');
});

test('plain Enter is left alone, so the prompt still submits', () => {
  assert.equal(terminalKeySequence(key()), null);
});

test('Enter with another modifier is left to the TUI', () => {
  // Alt+Enter already produces ESC CR natively — intercepting it would double-encode.
  assert.equal(terminalKeySequence(key({ shiftKey: true, altKey: true })), null);
  assert.equal(terminalKeySequence(key({ altKey: true })), null);
  // Ctrl+Enter / Cmd+Enter belong to the TUI and to the app's own shortcuts.
  assert.equal(terminalKeySequence(key({ shiftKey: true, ctrlKey: true })), null);
  assert.equal(terminalKeySequence(key({ shiftKey: true, metaKey: true })), null);
});

test('only keydown answers, so the newline is not inserted two or three times', () => {
  // xterm's custom-key hook also sees keypress and keyup for the same press.
  assert.equal(terminalKeySequence(key({ shiftKey: true, type: 'keypress' })), null);
  assert.equal(terminalKeySequence(key({ shiftKey: true, type: 'keyup' })), null);
});

test('Shift with any other key is not claimed', () => {
  for (const k of ['a', 'Tab', 'Backspace', 'ArrowUp', 'NumpadEnter']) {
    assert.equal(terminalKeySequence(key({ shiftKey: true, key: k })), null, k);
  }
});
