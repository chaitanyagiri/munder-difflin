'use strict';

/**
 * Install/uninstall guards.
 *
 * These bound real damage. Install writes files the user did not author into a
 * directory their agents load from; uninstall deletes directories. Both are
 * driven by a public list anyone can open a PR against, so the REFUSALS are the
 * feature — each test below is a way the app could have destroyed or executed
 * something it should not have.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { parseGitHubSourceUrl, resolveRepoRootSkillDir, safeSkillDirName, uninstallSkill } =
  loadTs('src/main/skills.ts');

const tmpdir = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'md-skill-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

test('a GitHub tree URL is split into owner/repo/ref/path', () => {
  assert.deepEqual(
    parseGitHubSourceUrl('https://github.com/mongodb/agent-skills/tree/main/skills/mongodb-mcp-setup'),
    { owner: 'mongodb', repo: 'agent-skills', ref: 'main', path: 'skills/mongodb-mcp-setup' }
  );
  assert.equal(parseGitHubSourceUrl('https://officialskills.sh/mongodb/skills/x'), null);
  // A repo ROOT is also a valid source — 81 catalog entries are shaped that way.
  assert.deepEqual(parseGitHubSourceUrl('https://github.com/zarazhangrui/frontend-slides'),
    { owner: 'zarazhangrui', repo: 'frontend-slides', ref: '', path: '' });
  assert.equal(parseGitHubSourceUrl('https://github.com/orgs/anthropics'), null);
});

test('a skill folder name that could escape its directory is refused', () => {
  assert.equal(safeSkillDirName('redis-development'), 'redis-development');
  assert.equal(safeSkillDirName('skills/redis-development'), 'redis-development');
  for (const bad of ['..', '.', '', '.hidden', 'x y', '-leading', 'a b/../c d']) {
    assert.equal(safeSkillDirName(bad), null, 'must refuse ' + JSON.stringify(bad));
  }
  // A traversal reduces to its LAST segment, which is a plain, safe folder name —
  // the caller joins it onto the skills root, so there is nothing left to escape.
  assert.equal(safeSkillDirName('a/../../b'), 'b');
});

// ── repo-root skill resolution (issue #385) ─────────────────────────────────
// A root URL used to mean "walk the whole repository": every file counted
// against MAX_FILES / MAX_TOTAL_BYTES, so a tiny skill inside a normal-sized
// repo failed with "larger than this installer will fetch". The resolver finds
// the directory that actually holds SKILL.md before anything is fetched.

/** A fake GitHub contents API: {'': [...], 'skills/foo': [...]}. Missing key = 404. */
const lister = (dirs) => async (p) => {
  if (!(p in dirs)) throw new Error('Not Found (404)');
  return dirs[p];
};
const file = (name) => ({ name, path: name, type: 'file', size: 10, download_url: 'x' });
const dir = (name) => ({ name, path: name, type: 'dir' });

test('a repo whose root holds SKILL.md is the skill itself (the 81 well-formed entries)', async () => {
  const resolved = await resolveRepoRootSkillDir(lister({ '': [file('SKILL.md'), file('README.md')] }), 'demo');
  assert.deepEqual(resolved, { path: '' });
});

test('a repo-root entry resolves to skills/<name> instead of walking the whole repo', async () => {
  const resolved = await resolveRepoRootSkillDir(
    lister({
      '': [dir('skills'), dir('src'), file('README.md')],
      'skills/frontend-slides': [{ name: 'SKILL.md', path: 'skills/frontend-slides/SKILL.md', type: 'file', size: 10, download_url: 'x' }]
    }),
    'frontend-slides'
  );
  assert.deepEqual(resolved, { path: 'skills/frontend-slides' });
});

test('.claude/skills/<name> and a bare <name> directory are probed as fallbacks', async () => {
  const viaClaude = await resolveRepoRootSkillDir(
    lister({
      '': [dir('.claude'), file('README.md')],
      '.claude/skills/demo': [{ name: 'SKILL.md', path: '.claude/skills/demo/SKILL.md', type: 'file', size: 1, download_url: 'x' }]
    }),
    'demo'
  );
  assert.deepEqual(viaClaude, { path: '.claude/skills/demo' });

  const viaBare = await resolveRepoRootSkillDir(
    lister({
      '': [dir('demo'), file('README.md')],
      demo: [{ name: 'SKILL.md', path: 'demo/SKILL.md', type: 'file', size: 1, download_url: 'x' }]
    }),
    'demo'
  );
  assert.deepEqual(viaBare, { path: 'demo' });
});

test('a candidate that 404s or lacks SKILL.md is skipped, not fatal', async () => {
  const resolved = await resolveRepoRootSkillDir(
    lister({
      '': [dir('skills'), dir('demo')],
      // skills/demo missing entirely (404); bare demo/ has the skill.
      demo: [{ name: 'SKILL.md', path: 'demo/SKILL.md', type: 'file', size: 1, download_url: 'x' }]
    }),
    'demo'
  );
  assert.deepEqual(resolved, { path: 'demo' });
});

test('no SKILL.md anywhere is a refusal, before a single file downloads', async () => {
  const resolved = await resolveRepoRootSkillDir(
    lister({ '': [dir('src'), dir('docs'), file('README.md')] }),
    'demo'
  );
  assert.equal(resolved.unsupported, true);
  assert.match(resolved.error, /SKILL\.md/);
});

test('a root listing failure is reported, and an unsafe entry name cannot crash the probe', async () => {
  const failed = await resolveRepoRootSkillDir(async () => { throw new Error('API rate limit exceeded'); }, 'demo');
  assert.match(failed.error, /rate limit/);
  const unsafe = await resolveRepoRootSkillDir(lister({ '': [dir('src')] }), '../../etc');
  assert.equal(unsafe.unsupported, true);
});

test('uninstall refuses anything outside a managed skills root', (t) => {
  const tmp = tmpdir(t);
  const victim = path.join(tmp, 'important-work');
  fs.mkdirSync(victim, { recursive: true });
  const res = uninstallSkill(victim, { cwds: [] });
  assert.equal(res.ok, false);
  assert.match(res.error, /not inside a skills directory/i);
  assert.ok(fs.existsSync(victim), 'the folder must still be there');
});

test('uninstall refuses a folder inside a skills root with no SKILL.md', (t) => {
  const tmp = tmpdir(t);
  const notASkill = path.join(tmp, '.claude', 'skills', 'src');
  fs.mkdirSync(notASkill, { recursive: true });
  fs.writeFileSync(path.join(notASkill, 'index.ts'), 'export {}');
  const res = uninstallSkill(notASkill, { cwds: [tmp] });
  assert.equal(res.ok, false);
  assert.match(res.error, /SKILL/i);
  assert.ok(fs.existsSync(notASkill));
});

test('uninstall removes a real skill folder inside a project root', (t) => {
  const tmp = tmpdir(t);
  const skill = path.join(tmp, '.claude', 'skills', 'demo');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: demo\n---\n');
  assert.equal(uninstallSkill(skill, { cwds: [tmp] }).ok, true);
  assert.ok(!fs.existsSync(skill));
});

test('uninstall will not delete the skills root itself', (t) => {
  const tmp = tmpdir(t);
  const root = path.join(tmp, '.claude', 'skills');
  fs.mkdirSync(root, { recursive: true });
  assert.equal(uninstallSkill(root, { cwds: [tmp] }).ok, false);
  assert.ok(fs.existsSync(root));
});
