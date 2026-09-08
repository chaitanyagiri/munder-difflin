'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// ensureClaudePermissionsAccepted() writes below os.homedir(). Redirect both
// home variables before loading config.ts so this test can never touch the
// user's real Claude configuration.
const realHome = process.env.HOME;
const realUserProfile = process.env.USERPROFILE;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-claude-config-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
assert.equal(os.homedir(), home, 'home redirect failed; refusing to run against the real home');

const userData = path.join(home, 'user-data');
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { app: { getPath: () => userData } }
};

const { ensureClaudePermissionsAccepted } = loadTs('src/main/config.ts');
const settingsDir = path.join(home, '.claude');
const settingsPath = path.join(settingsDir, 'settings.json');
const projectConfigPath = path.join(home, '.claude.json');
const cwd = path.join(home, 'workspace', 'project');

// Claude Code reads projects[] under a path normalised to forward slashes, so
// the trust flag is written under every spelling it might look up. On Windows
// that is two keys; on macOS and Linux the two are the same string and this
// collapses to the single key these tests have always asserted.
const cwdKeys = Array.from(new Set([cwd.replace(/\\/g, '/'), cwd]));
const trustedCwd = (entry = { hasTrustDialogAccepted: true }) =>
  Object.fromEntries(cwdKeys.map((k) => [k, k === cwd ? entry : { hasTrustDialogAccepted: true }]));

function writeSettings(contents) {
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(settingsPath, contents, 'utf8');
}

function resetConfigs() {
  fs.rmSync(settingsDir, { recursive: true, force: true });
  fs.rmSync(projectConfigPath, { force: true });
}

test.beforeEach(resetConfigs);
test.after(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = realUserProfile;
  fs.rmSync(home, { recursive: true, force: true });
});

test('preserves malformed Claude config files byte-for-byte', () => {
  const malformedSettings = '{\n  "env": {\n    "CUSTOM_VALUE": "preserve-me"\n  },\n';
  const malformedProjectConfig = '{\n  "projects": {\n';
  const warnings = [];
  const originalWarn = console.warn;
  writeSettings(malformedSettings);
  fs.writeFileSync(projectConfigPath, malformedProjectConfig, 'utf8');

  console.warn = (...args) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    ensureClaudePermissionsAccepted(cwd);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(fs.readFileSync(settingsPath, 'utf8'), malformedSettings);
  assert.equal(fs.readFileSync(projectConfigPath, 'utf8'), malformedProjectConfig);
  assert.ok(warnings.some((line) => line.includes(settingsPath)));
  assert.ok(warnings.some((line) => line.includes(projectConfigPath)));
});

test('merges required fields into valid configs without losing unrelated data', () => {
  writeSettings(JSON.stringify({
    env: { CUSTOM_VALUE: 'preserve-me' },
    hooks: { example: true }
  }, null, 2));
  fs.writeFileSync(projectConfigPath, JSON.stringify({
    numStartups: 7,
    projects: {
      [cwd]: { allowedTools: ['Read'], custom: 'keep' },
      '/another/project': { hasTrustDialogAccepted: false }
    }
  }, null, 2));

  ensureClaudePermissionsAccepted(cwd);

  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), {
    env: { CUSTOM_VALUE: 'preserve-me' },
    hooks: { example: true },
    skipDangerousModePermissionPrompt: true,
    skipAutoPermissionPrompt: true
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(projectConfigPath, 'utf8')), {
    numStartups: 7,
    projects: {
      ...trustedCwd({
        allowedTools: ['Read'],
        custom: 'keep',
        hasTrustDialogAccepted: true
      }),
      '/another/project': { hasTrustDialogAccepted: false }
    }
  });
});

test('creates minimal config files when they are missing', () => {
  ensureClaudePermissionsAccepted(cwd);

  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), {
    skipDangerousModePermissionPrompt: true,
    skipAutoPermissionPrompt: true
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(projectConfigPath, 'utf8')), {
    projects: trustedCwd()
  });
});

test('a malformed settings file does not prevent safe project trust updates', () => {
  const malformedSettings = '{ "preserve": true,';
  writeSettings(malformedSettings);
  fs.writeFileSync(projectConfigPath, JSON.stringify({ custom: 'keep' }), 'utf8');

  ensureClaudePermissionsAccepted(cwd);

  assert.equal(fs.readFileSync(settingsPath, 'utf8'), malformedSettings);
  assert.deepEqual(JSON.parse(fs.readFileSync(projectConfigPath, 'utf8')), {
    custom: 'keep',
    projects: trustedCwd()
  });
});

test('does not rewrite configs that already contain every required field', () => {
  const settings = '{"skipDangerousModePermissionPrompt":true,"skipAutoPermissionPrompt":true}\n';
  const projectConfig = JSON.stringify({ projects: trustedCwd() }) + '\n';
  writeSettings(settings);
  fs.writeFileSync(projectConfigPath, projectConfig, 'utf8');

  ensureClaudePermissionsAccepted(cwd);
  ensureClaudePermissionsAccepted(cwd);

  assert.equal(fs.readFileSync(settingsPath, 'utf8'), settings);
  assert.equal(fs.readFileSync(projectConfigPath, 'utf8'), projectConfig);
});

test('preserves existing config files with unsafe JSON root shapes', () => {
  writeSettings('null\n');
  fs.writeFileSync(projectConfigPath, '["keep"]\n', 'utf8');

  ensureClaudePermissionsAccepted(cwd);

  assert.equal(fs.readFileSync(settingsPath, 'utf8'), 'null\n');
  assert.equal(fs.readFileSync(projectConfigPath, 'utf8'), '["keep"]\n');
});

test('repairs a config trusted only under the raw path spelling', () => {
  // The bug this guards: on Windows the raw path is "C:\…" while Claude Code
  // looks the entry up as "C:/…". A config trusted only under the raw spelling
  // left the folder untrusted as far as Claude was concerned, so the agent hit
  // the interactive trust dialog it cannot answer and exited 1.
  fs.writeFileSync(projectConfigPath, JSON.stringify({
    projects: { [cwd]: { hasTrustDialogAccepted: true } }
  }), 'utf8');

  ensureClaudePermissionsAccepted(cwd);

  const projects = JSON.parse(fs.readFileSync(projectConfigPath, 'utf8')).projects;
  assert.equal(projects[cwd.replace(/\\/g, '/')]?.hasTrustDialogAccepted, true);
  assert.equal(projects[cwd]?.hasTrustDialogAccepted, true);
});
