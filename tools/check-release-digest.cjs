'use strict';
/**
 * What the update toast will actually say, run against GitHub's LIVE feed.
 *
 * Not a unit test and deliberately not in the test run: it makes a network call
 * and its answer changes when someone edits a release. Its job is the one thing
 * a fixture cannot do — tell you what real users are being shown right now.
 *
 * The string it reads is `releases.atom`, because that is what electron-updater
 * hands the digest on the `downloaded` path (GitHubProvider → computeReleaseNotes
 * → the newest entry's <content>). It is GitHub's RENDERED markdown, not the
 * release body, and testing against the body instead is how a CSS reset shipped
 * as 0.4.5's "What's new".
 *
 *   node tools/check-release-digest.cjs          # newest release
 *   node tools/check-release-digest.cjs --all    # every entry in the feed
 */
const https = require('node:https');
const path = require('node:path');
const loadTs = require(path.resolve(__dirname, '..', 'test', 'load-ts.cjs'));
const { summarizeReleaseNotes } = loadTs('src/shared/releaseNotes.ts');

const FEED = 'https://github.com/chaitanyagiri/munder-difflin/releases.atom';
const unescapeXml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, '&');

function get(url, done) {
  https.get(url, { headers: { 'User-Agent': 'munder-difflin-digest-check' } }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      return get(res.headers.location, done);
    }
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { body += d; });
    res.on('end', () => done(null, body));
  }).on('error', (e) => done(e));
}

get(FEED, (err, feed) => {
  if (err) { console.error('could not read the feed:', err.message); process.exit(1); }
  const entries = feed.split('<entry>').slice(1);
  const wanted = process.argv.includes('--all') ? entries : entries.slice(0, 1);
  let leaked = false;
  for (const entry of wanted) {
    const title = (entry.match(/<title>([^<]*)<\/title>/) || [, '?'])[1];
    const m = entry.match(/<content type="html">([\s\S]*?)<\/content>/);
    const digest = summarizeReleaseNotes(m ? unescapeXml(m[1]) : '');
    console.log(`\n${title} — what the toast shows:`);
    if (digest.length === 0) console.log('   (nothing — the toast renders no block at all)');
    digest.forEach((line, i) => console.log(`   ${i + 1}. ${line}`));
    for (const line of digest) {
      if (/\{[^}]*:[^}]*[;}]/.test(line) || /^@(media|keyframes|import|supports)\b/i.test(line)) {
        console.log(`   ^^ CSS reached the toast on line ${digest.indexOf(line) + 1}`);
        leaked = true;
      }
    }
  }
  console.log(leaked ? '\nFAIL: stylesheet text is reaching users.' : '\nOK: no CSS in the digest.');
  process.exit(leaked ? 1 : 0);
});
