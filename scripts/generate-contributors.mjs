#!/usr/bin/env node
// Regenerates CONTRIBUTORS.md from MERGED PULL REQUESTS, plus the pull requests
// listed in .github/contributors-extra.json whose code is in main without the
// merged badge.
//
// Why not just link GitHub's contributors graph? Because that graph keys on the
// COMMIT AUTHOR EMAIL. If a contributor's git email is not attached to their
// GitHub account (a typo, a work address, a local hostname), their merged work
// is filed under an anonymous bucket and they never appear on that page at all.
// It fails silently, and it has already happened here.
//
// A pull request always has a real GitHub account attached to it, so generating
// from pull requests is both complete and stable.
//
// Usage: GH_TOKEN=... node scripts/generate-contributors.mjs [--check]

import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const REPO = process.env.GITHUB_REPOSITORY || 'chaitanyagiri/munder-difflin';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const OUT = 'CONTRIBUTORS.md';
const EXTRA = '.github/contributors-extra.json';
const CHECK = process.argv.includes('--check');

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      'user-agent': 'munder-difflin-contributors'
    }
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

// Bots are not people. Keep this list explicit rather than guessing from the name.
const BOTS = new Set(['github-actions[bot]', 'dependabot[bot]', 'wall-sync']);
const isBot = (u) => !u || u.type === 'Bot' || BOTS.has(u.login);

const people = new Map();
function record(user, date, { badged }) {
  const p = people.get(user.login) || {
    login: user.login, url: user.html_url,
    merged: 0, unbadged: 0, first: date, last: date
  };
  if (badged) p.merged += 1; else p.unbadged += 1;
  if (date < p.first) p.first = date;
  if (date > p.last) p.last = date;
  people.set(user.login, p);
  return p;
}

for (let page = 1; ; page++) {
  const batch = await gh(`/repos/${REPO}/pulls?state=closed&per_page=100&page=${page}`);
  if (!batch.length) break;
  for (const pr of batch) {
    if (!pr.merged_at || isBot(pr.user)) continue;
    record(pr.user, pr.merged_at, { badged: true });
  }
  if (batch.length < 100) break;
}

// Pull requests whose code is in main but which GitHub does not show as merged.
// Identity is read from the API rather than stored, so a rename follows on its own.
const landed = [];
if (existsSync(EXTRA)) {
  for (const entry of JSON.parse(readFileSync(EXTRA, 'utf8')).landed_without_merged_badge) {
    const pr = await gh(`/repos/${REPO}/pulls/${entry.pr}`);
    if (pr.merged_at) {
      throw new Error(`#${entry.pr} is merged on GitHub now. Remove it from ${EXTRA}.`);
    }
    if (isBot(pr.user)) continue;
    const date = pr.closed_at || pr.created_at;
    record(pr.user, date, { badged: false });
    landed.push({ ...entry, login: pr.user.login, url: pr.user.html_url, title: pr.title, date });
  }
}

// Most contributions first, then earliest joiner, then alphabetical. Deterministic,
// so the file only changes when the facts change.
const total = (p) => p.merged + p.unbadged;
const list = [...people.values()].sort((a, b) =>
  total(b) - total(a) || a.first.localeCompare(b.first) || a.login.localeCompare(b.login));

landed.sort((a, b) => a.pr - b.pr);

const day = (iso) => iso.slice(0, 10);
const plural = (n) => (n === 1 ? '1 pull request' : `${n} pull requests`);
const commitLink = (sha) => `[\`${sha}\`](https://github.com/${REPO}/commit/${sha})`;

const row = (p) => {
  const name = `[@${p.login}](${p.url})${p.unbadged ? ' †' : ''}`;
  return `| ${name} | ${total(p)} | ${day(p.first)} | ${day(p.last)} |`;
};

const body = `# Contributors

Everyone on this list has code in Munder Difflin. If that is you, this file is yours to point at.

It is generated from the pull requests themselves rather than from commit metadata, so nobody is
dropped because their git email does not happen to match their GitHub account. It regenerates
whenever a pull request merges, so you appear without having to ask.

**${list.length} people** have contributed so far.

<a href="https://github.com/${REPO}/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=${REPO}" alt="Contributor avatars">
</a>

| Contributor | Contributions | First | Most recent |
|---|---:|---|---|
${list.map(row).join('\n')}

_${plural(list.reduce((n, p) => n + total(p), 0))} from ${list.length} people._

## † Contributions that never got the merged badge

${landed.length} pull requests below are in main and their authors are contributors, but GitHub
shows them as closed rather than merged. On release night the pull requests were closed before the
release branch merged into main, so at the moment they closed, main did not contain their commits
yet. GitHub records the badge at that instant and will not let it be changed afterwards. It was our
sequencing mistake and it is not recoverable, so the record lives here instead. The full account is
in [discussion #353](https://github.com/${REPO}/discussions/353).

Every commit listed here was checked to be in \`main\` before it was added.

| Pull request | Contributor | In main |
|---|---|---|
${landed.map((e) => `| [#${e.pr}](https://github.com/${REPO}/pull/${e.pr}) | [@${e.login}](${e.url}) | ${e.commits.map(commitLink).join(', ')} |`).join('\n')}

${landed.filter((e) => e.note).map((e) => `**#${e.pr}** ${e.note}`).join('\n\n')}

---

**Not on this list yet?** [\`good first issue\`](https://github.com/${REPO}/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
is kept stocked with small, self contained work, and [\`CONTRIBUTING.md\`](./CONTRIBUTING.md) has
everything else. Help that is not code counts too: a bug report with a clean reproduction is often
worth more than a patch, it just cannot be counted automatically here.

<sub>Generated by \`scripts/generate-contributors.mjs\`. Do not edit by hand; your changes will be
overwritten on the next merge. To credit a contribution that is in main without the merged badge,
add its pull request number to \`.github/contributors-extra.json\`.</sub>
`;

if (CHECK) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current !== body) { console.error(`${OUT} is stale. Run: node scripts/generate-contributors.mjs`); process.exit(1); }
  console.log(`${OUT} is up to date (${list.length} contributors).`);
} else {
  writeFileSync(OUT, body);
  console.log(`Wrote ${OUT}: ${list.length} contributors, ${landed.length} unbadged pull requests.`);
}
