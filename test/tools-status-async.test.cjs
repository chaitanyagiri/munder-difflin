/**
 * Onboarding used to resolve every CLI through one synchronous interactive login
 * shell per binary. This suite holds the batched, asynchronous replacement: one
 * child for the whole catalog, and no blocking resolver inside `tools:status`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { buildLoginShellLookupScript, parseLoginShellLookup, resolveCommands } =
  loadTs('src/main/shellEnv.ts');
const readSrc = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

test('one fenced lookup script covers every command in one shell', () => {
  const script = buildLoginShellLookupScript(['node', 'git']);
  assert.match(script, /for __MD_COMMAND in node git; do/);
  assert.match(script, /command -v -- "\$__MD_COMMAND"/);
  assert.equal(script.split('__MD_SHELL_FENCE__').length, 3, 'the result is fenced on both ends');
});

test('fenced command=path results ignore rc-file noise and missing commands', () => {
  const output = [
    'Restored session: zsh noise',
    '__MD_SHELL_FENCE__',
    'node=/usr/local/bin/node',
    'git=',
    '__MD_SHELL_FENCE__',
    'more shell noise'
  ].join('\n');
  const found = parseLoginShellLookup(output, ['node', 'git']);
  assert.equal(found.get('node'), '/usr/local/bin/node');
  assert.equal(found.get('git'), null);
});

test('the async batch resolver resolves a bundled runtime command', async () => {
  const found = await resolveCommands(['node']);
  const path = found.get('node');
  assert.ok(path, 'node should resolve on the test machine');
  assert.notEqual(path, 'node', 'a successful lookup returns a concrete path');
  assert.ok(fs.existsSync(path), 'the resolver must return an existing path');
});

test('memory status can consume a path resolved by the batch probe', () => {
  const { MemoryManager } = loadTs('src/main/memory.ts');
  const memory = new MemoryManager(() => null, () => ({ enabled: true, model: 'minilm' }));
  const status = memory.statusWithBin('/usr/local/bin/mempalace');
  assert.equal(status.available, true);
  assert.equal(status.bin, '/usr/local/bin/mempalace');
  assert.equal(status.enabled, true);
  assert.equal(status.active, false, 'no harness home yet');
});

test('tools:status is async and uses the batch resolver, not one blocking probe per tool', () => {
  const src = readSrc('src/main/index.ts');
  const handlerAt = src.indexOf("ipcMain.handle('tools:status'");
  const nextBraceAt = src.indexOf('\n', handlerAt);
  const endAt = src.indexOf('\nipcMain.handle(', nextBraceAt);
  const handler = src.slice(handlerAt, endAt);
  assert.match(handler, /async \(\): Promise<ToolStatus\[\]>/);
  assert.match(handler, /resolveCliCommands\(/);
  assert.doesNotMatch(handler, /resolveCliCommand\(spec\.bin\)/);
  assert.doesNotMatch(handler, /spawnSync/);
  const shellEnv = readSrc('src/main/shellEnv.ts');
  const batchAt = shellEnv.indexOf('export async function resolveCommands');
  const batchEndAt = shellEnv.indexOf('export function resolveCommand', batchAt);
  const batch = shellEnv.slice(batchAt, batchEndAt);
  assert.doesNotMatch(batch, /spawnSync/);
});

