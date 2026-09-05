/**
 * Renderer mount smoke test — does the built renderer actually come up?
 *
 * WHY THIS EXISTS. The typecheckers and the unit suite all passed on a build
 * whose renderer mounted to an empty page: every test in test/ exercises logic,
 * none of them renders React, so "746 passing" said nothing about whether the
 * app boots. This is the cheapest thing that does say it.
 *
 * WHAT IT DOES. Serves `out/renderer` over http (file:// is refused for module
 * scripts by CORS, which is why this needs a server at all), injects a stub
 * `window.cth` — the preload bridge does not exist outside Electron, and without
 * it the app dies on its first IPC call for reasons that have nothing to do with
 * the change under test — then loads the page in headless Chrome and asserts
 * that #root has real content and that no uncaught error was raised.
 *
 * The stub sets `cth.skipHivePickerOnce` so the app renders the MAIN UI (floor,
 * command centre, roster) rather than stopping at the launch picker. That is the
 * screen a mount regression actually breaks.
 *
 * LIMITS, stated plainly: this drives the renderer alone. The real main process,
 * the real preload and any behaviour that depends on live IPC data are stubbed
 * away, so a green run means "the renderer mounts and paints", not "the app
 * works". It catches the class of bug where the tree throws during render and
 * leaves the user an empty window.
 *
 *   node scripts/renderer-smoke.mjs [outDir]
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const OUT = resolve(process.argv[2] ?? 'out/renderer');
const PORT = 8790 + (process.pid % 100);

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
];

const STUB = `
window.__err = [];
addEventListener('error', (e) => {
  window.__err.push((e.error && e.error.stack) || e.message);
  document.title = 'ERR|' + window.__err.join(' || ').slice(0, 2000);
});
(function () {
  // A fresh hive: onboarding done, no godRecipe yet. That absent-value case is
  // the one a new optional config field is most likely to get wrong.
  var CONFIG = {
    onboardingComplete: true, harnessHome: '/tmp/hive', recentHives: ['/tmp/hive'],
    registeredRepos: [], autoMode: false, defaultCommand: 'claude',
    defaultModel: 'claude-opus-5', godProvider: 'claude', agentTokenCaps: {},
    webhookTriggers: [], orgTrigger: { apiKey: '', enabled: false },
    knowledgeGraph: { enabled: false }, tvShowOffices: false, officeTheme: 'office'
  };
  var VALUES = {
    getConfig: CONFIG, updateConfig: CONFIG, hiveRegistry: { agents: {} },
    hiveTasks: { tasks: [] }, hiveLog: [], hiveBoard: '', listPtys: [],
    listMissions: [], listWebhooks: [], toolsStatus: [], skillsLocal: [],
    kgStatus: {}, kgList: [], memoryStatus: {}, hiveAgentDirectory: { agents: [] },
    updateCurrent: {}, hiveInbox: [], hiveMemory: ''
  };
  var SYNC = { rosterReadSync: null, harnessHomeSync: '/tmp/hive' };
  try { localStorage.setItem('cth.skipHivePickerOnce', '1'); } catch (e) {}
  window.cth = new Proxy({}, { get: function (_t, k) {
    if (typeof k !== 'string') return undefined;
    if (k in SYNC) return function () { return SYNC[k]; };
    // onX(cb) subscribers must hand back an unsubscribe function.
    if (k.slice(0, 2) === 'on' && k[2] && k[2] === k[2].toUpperCase()) {
      return function () { return function () {}; };
    }
    return function () { return Promise.resolve(k in VALUES ? VALUES[k] : { ok: true }); };
  } });
})();

// md-36 regression: god's OWN panel must offer a way into the character
// creator. The creator shipped reachable only from a panel god never renders
// and from a one-shot nudge, so it was live code no user could open — a class
// of bug no unit test can see, because every piece worked in isolation. This
// clicks the real button in the real tree and waits for the real dialog.
(function () {
  var tries = 0;
  var mark = function (v) { document.documentElement.setAttribute('data-smoke-creator', v); };
  var iv = setInterval(function () {
    var btn = document.querySelector(
      'button[aria-label="Make Michael yours"], button[aria-label="Edit your character"]'
    );
    if (btn) {
      clearInterval(iv);
      btn.click();
      setTimeout(function () {
        mark(document.body.textContent.indexOf('MAKE MICHAEL YOURS') >= 0 ? 'opened' : 'no-dialog');
      }, 400);
    } else if (++tries > 40) {
      clearInterval(iv);
      mark('missing');
    }
  }, 200);
})();
`;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf'
};

function fail(msg) { console.error(`renderer-smoke: FAIL — ${msg}`); process.exit(1); }

if (!existsSync(join(OUT, 'index.html'))) {
  fail(`no built renderer at ${OUT} — run \`npm run build\` first`);
}
const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) fail('no Chrome/Chromium found; install one or set it in CHROME_CANDIDATES');

// The page's own CSP is `script-src 'self'`, so the stub has to be served as a
// same-origin file rather than inlined into the HTML.
const indexHtml = await readFile(join(OUT, 'index.html'), 'utf8');
const probeHtml = indexHtml.replace(
  '<script type="module"',
  '<script src="./__smoke-stub.js"></script>\n    <script type="module"'
);
if (probeHtml === indexHtml) fail('could not inject the stub — index.html shape changed');

const server = createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  try {
    if (path === '/__smoke.html') {
      res.writeHead(200, { 'content-type': 'text/html' }); res.end(probeHtml); return;
    }
    if (path === '/__smoke-stub.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(STUB); return;
    }
    const body = await readFile(join(OUT, path.replace(/^\/+/, '')));
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

/** One headless run. `--dump-dom` is a ONE-SHOT snapshot taken when the virtual
 *  time budget runs out, so a page that has not finished mounting yet dumps
 *  half-painted — which is a racy harness, not a broken app. The caller retries
 *  that case, and only that case: a run that captured an ERROR is a real result
 *  and is never retried. */
async function runOnce() {
  const profile = await mkdtemp(join(tmpdir(), 'cth-smoke-'));
  const dom = await new Promise((resolveDom) => {
    const args = [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=25000',
      `--user-data-dir=${profile}`, '--dump-dom', `http://127.0.0.1:${PORT}/__smoke.html`
    ];
    const child = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    // Headless Chrome writes the DOM and then does not always exit; the output is
    // what matters, so take it on a timer rather than waiting for the exit code.
    const done = () => { try { child.kill(); } catch {} resolveDom(out); };
    child.on('exit', done);
    setTimeout(done, 30_000);
  });
  // Best effort: Chrome may still be flushing its profile as we tear down, and a
  // leftover temp dir must never be the reason a smoke test reports failure.
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  return dom;
}

let dom = '';
for (let attempt = 0; attempt < 3; attempt++) {
  dom = await runOnce();
  const captured = /<title>ERR\|/.test(dom);
  const finished = dom.includes('COMMAND CENTER') || dom.includes('data-smoke-creator');
  if (captured || finished) break;
  console.warn(`renderer-smoke: the page had not finished mounting (attempt ${attempt + 1}) — retrying`);
}

const err = /<title>ERR\|([\s\S]*?)<\/title>/.exec(dom);
if (err) fail(`uncaught error during mount:\n${err[1].replace(/&quot;/g, '"')}`);

server.close();

const root = /<div id="root"[^>]*>([\s\S]*?)$/.exec(dom);
if (!root) fail('no #root in the dumped DOM');
const painted = root[1].replace(/\s+/g, '').length;
if (painted < 2000) {
  fail(`#root is empty or near-empty (${painted} chars) — the tree threw during render`);
}

// A size threshold alone is not an assertion. A run that dumped 12,376 chars
// sailed past the old `> 2000` check while most of the UI was still missing —
// the page had simply not finished. Naming the landmarks turns "something
// painted" into "the screen we care about painted", and turns a half-loaded
// dump into a failure instead of a pass.
for (const marker of ['COMMAND CENTER', 'runs the floor']) {
  if (!dom.includes(marker)) {
    fail(`"${marker}" is missing — god's Command Center never rendered (painted ${painted} chars)`);
  }
}

const creator = /data-smoke-creator="([a-z-]+)"/.exec(dom);
if (!creator) fail("the creator probe never ran — the page did not finish loading in time");
if (creator[1] === 'missing') {
  fail("god's Command Center offers NO way into the character creator (md-36) — "
    + 'no button carrying the "Make Michael yours" / "Edit your character" label');
}
if (creator[1] !== 'opened') {
  fail(`the creator entry point is present but did not open the dialog (${creator[1]})`);
}

console.log(`renderer-smoke: OK — #root painted ${painted} chars, god's Command Center`
  + ' rendered, its creator entry point opens the dialog, no uncaught errors');
