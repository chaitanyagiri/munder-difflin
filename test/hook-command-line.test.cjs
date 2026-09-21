'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { joinCommandLine, tokenizeCommand } = loadTs('src/shared/commandLine.ts');

test('joinCommandLine quotes only the parts that carry a space', () => {
  // The Windows hook line that shipped broken: unquoted is fine until a part
  // contains a space, and the DEFAULT harness home has one.
  assert.equal(
    joinCommandLine(['C:\\hive\\bin\\hive-node.cmd', 'C:\\hive\\bin\\cth-hook.cjs']),
    'C:\\hive\\bin\\hive-node.cmd C:\\hive\\bin\\cth-hook.cjs',
    'nothing to quote - the .cmd shape #350 asked for is preserved verbatim'
  );
  assert.equal(
    joinCommandLine(['C:\\Users\\a\\Documents\\Munder Difflin\\bin\\hive-node.cmd', 'C:\\hive\\bin\\cth-hook.cjs']),
    '"C:\\Users\\a\\Documents\\Munder Difflin\\bin\\hive-node.cmd" C:\\hive\\bin\\cth-hook.cjs'
  );
  assert.equal(joinCommandLine(['node', 'C:\\hive\\bin\\cth-hook.cjs', 'SessionStart']), 'node C:\\hive\\bin\\cth-hook.cjs SessionStart');
});

test('a joined hook command splits back into its original parts', () => {
  const parts = ['C:\\Program Files\\node.exe', 'C:\\Munder Difflin\\hook.cjs', 'Stop'];
  assert.deepEqual(tokenizeCommand(joinCommandLine(parts)), parts);
});
