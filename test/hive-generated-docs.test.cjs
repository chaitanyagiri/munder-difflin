'use strict';

/**
 * Generated hive documents are refreshed during hive-service bootstrap, not as a
 * side effect of ordinary task or agent mutations. These regressions exercise the
 * public HiveManager paths and pin the main-process bootstrap wiring without
 * starting Electron, a PTY, or a CLI.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

const GENERATED_NOTICE_PREFIX = '<!-- Generated and managed by Munder Difflin.';
const GENERATED_DOCS = [
  { filename: 'PROTOCOL.md', sentinel: 'PROTOCOL_SENTINEL\n', heading: '# Hive protocol' },
  { filename: 'COMMANDS.md', sentinel: 'COMMANDS_SENTINEL\n', heading: '# Claude Code commands' }
];

function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-generated-docs-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  return { hive, root: path.join(home, 'hive') };
}

function writeSentinels(root) {
  for (const { filename, sentinel } of GENERATED_DOCS) {
    fs.writeFileSync(path.join(root, filename), sentinel, 'utf8');
  }
}

function assertSentinels(root) {
  for (const { filename, sentinel } of GENERATED_DOCS) {
    assert.equal(fs.readFileSync(path.join(root, filename), 'utf8'), sentinel);
  }
}

function readGeneratedDoc(root, filename) {
  return fs.readFileSync(path.join(root, filename), 'utf8');
}

function assertGenerated(root, docs = GENERATED_DOCS) {
  for (const { filename, heading } of docs) {
    const contents = readGeneratedDoc(root, filename);
    assert.equal(contents.startsWith(GENERATED_NOTICE_PREFIX), true);
    assert.equal(contents.split('\n').includes(heading), true);
  }
}

test('writeTasks preserves existing generated hive docs', (t) => {
  const { hive, root } = floor(t);
  writeSentinels(root);

  hive.writeTasks([]);

  assertSentinels(root);
});

test('ensureAgent preserves existing generated hive docs', async (t) => {
  const { hive, root } = floor(t);
  writeSentinels(root);

  await hive.ensureAgent({ id: 'agent-1', name: 'Agent', provider: 'claude', cwd: root });

  assertSentinels(root);
});

test('refreshGeneratedDocs replaces stale generated hive docs', (t) => {
  const { hive, root } = floor(t);
  writeSentinels(root);

  hive.refreshGeneratedDocs();

  for (const { filename, sentinel } of GENERATED_DOCS) {
    assert.equal(readGeneratedDoc(root, filename).includes(sentinel), false);
  }
  assertGenerated(root);
});

test('hive-service bootstrap refreshes generated hive docs', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const bootstrapBody = source.match(/function bootstrapHiveServices\(\): void \{([\s\S]*?)^\}/m)?.[1];

  assert.ok(bootstrapBody, 'bootstrapHiveServices() is missing');
  assert.match(
    bootstrapBody,
    /hive\.ensureHive\(\);\s*hive\.refreshGeneratedDocs\(\);/,
    'bootstrapHiveServices() must refresh generated docs after ensuring the hive'
  );
  assert.equal(
    source.match(/hive\.refreshGeneratedDocs\(\);/g)?.length,
    1,
    'refreshGeneratedDocs() must have one production caller'
  );
});

test('ensureHive restores missing generated hive docs', (t) => {
  const { hive, root } = floor(t);
  for (const { filename } of GENERATED_DOCS) fs.rmSync(path.join(root, filename));

  hive.ensureHive();

  assertGenerated(root);
});

test('ensureHive restores only the missing generated hive doc', (t) => {
  const { hive, root } = floor(t);
  const [missing, preserved] = GENERATED_DOCS;
  fs.rmSync(path.join(root, missing.filename));
  fs.writeFileSync(path.join(root, preserved.filename), preserved.sentinel, 'utf8');

  hive.ensureHive();

  assertGenerated(root, [missing]);
  assert.equal(readGeneratedDoc(root, preserved.filename), preserved.sentinel);
});
