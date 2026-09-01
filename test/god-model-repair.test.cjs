'use strict';

/**
 * A stored `godModel` of `gpt-5-codex` must not survive a read.
 *
 * The id is a real OpenAI *API* model but is absent from the codex CLI's catalog,
 * so the CLI answers `404 Model not found`. Onboarding and the Command Center
 * persisted it into `godModel` when Codex was picked, and `godModel` wins over the
 * provider preset wherever the spawn model is read — so correcting the preset alone
 * would leave every existing install spawning an orchestrator that never answers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// config.ts resolves its file through Electron's app.getPath(); point that one
// dependency at a throwaway root so this never touches the real config.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-god-model-repair-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { app: { getPath: () => userData } }
};

const { writeConfig, readConfig } = loadTs('src/main/config.ts');
const { providerPreset } = loadTs('src/shared/agentProvider.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

// Settle the one-shot trigger migration first, as a real app start would.
writeConfig({});
readConfig();

test('a stored gpt-5-codex godModel is repaired on read', () => {
  writeConfig({ godProvider: 'codex', godModel: 'gpt-5-codex' });
  assert.equal(readConfig().godModel, providerPreset('codex').recommendedOrchestratorModel);
});

test('the repair SETS the id — a codex god must never inherit the Claude default', () => {
  // Deleting the key instead would let readConfig's DEFAULTS merge supply
  // `claude-opus-4-8`, quietly handing a Claude model to a codex spawn.
  writeConfig({ godProvider: 'codex', godModel: 'gpt-5-codex' });
  const model = readConfig().godModel;
  assert.notEqual(model, 'claude-opus-4-8');
  assert.match(model, /^gpt-/);
});

test('any other stored godModel is left untouched', () => {
  for (const keep of ['claude-opus-4-8', 'gpt-5.6-terra', 'some-future-id']) {
    writeConfig({ godModel: keep });
    assert.equal(readConfig().godModel, keep, `${keep} should not be rewritten`);
  }
});
