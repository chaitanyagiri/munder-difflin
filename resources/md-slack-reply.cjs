#!/usr/bin/env node
/**
 * md-slack-reply.cjs — post a message back into the Slack thread that triggered
 * an office run, WITHOUT ever handling the bot token.
 *
 * The Munder Difflin main process runs a loopback-only HTTP endpoint (bound to
 * 127.0.0.1, never tunneled) and writes its `{ port, token }` to a small
 * discovery file under the app's userData dir. This helper reads that file and
 * POSTs the reply to the endpoint, which holds the bot token and forwards to
 * Slack's chat.postMessage. The token never appears here, in the prompt, or in
 * any transcript.
 *
 * On a SUCCESSFUL post it also UPSERTS the bot-thread follow-ledger
 * (`slack-bot-threads.json`, alongside the app config in userData) that
 * `md-slack-poller.cjs` reads to decide which threads to pull replies for. This
 * is what makes a user's later THREAD REPLY reach the bot with no @-mention:
 * conversations.history only returns top-level messages, so a thread is only
 * followed if it's in this ledger. Every agent/god reply goes through THIS CLI,
 * so writing the ledger here (rather than relying on the MD main process) is what
 * guarantees the ledger actually exists. The ledger holds channel + thread
 * timestamps ONLY — never a token. A ledger write failure never breaks the reply.
 *
 * Usage:
 *   node md-slack-reply.cjs --channel C123 --thread 1700000000.000100 --text "..."
 *   (optional) --config /abs/path/to/slack-reply.json   (else MD_SLACK_REPLY_CONFIG)
 *   (optional) --ledger /abs/path/to/slack-bot-threads.json  (else alongside config)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

/** Parse `--key value` and `--key=value` pairs from argv. */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}

function fail(msg) {
  process.stderr.write(`md-slack-reply: ${msg}\n`);
  process.exit(1);
}

/** Numeric max of two Slack decimal-string timestamps (either may be undefined). */
function tsMaxStr(a, b) {
  if (!a) return b;
  if (!b) return a;
  return Number(b) > Number(a) ? b : a;
}

/** Resolve the follow-ledger path: --ledger, else alongside the discovery config
 *  (MD userData) — the SAME dir `md-slack-poller.cjs` resolves the ledger in, so
 *  the writer here and the reader there always agree. */
function resolveLedgerPath(args, configPath) {
  if (args && args.ledger && args.ledger !== true) return args.ledger;
  return path.join(path.dirname(configPath), 'slack-bot-threads.json');
}

/**
 * Upsert one bot-participated thread into the ledger the poller reads. Merges
 * with existing entries (never drops others), keeps the NEWEST `lastBotTs`, and
 * writes atomically with 0600 perms (mirrors the poller's saveState). Shape
 * matches what `md-slack-poller.cjs` `loadBotThreadRoots` expects:
 *   { "threads": { "<root_ts>": { "channel": "C…", "lastBotTs": "<ts>", … } } }
 * `botMsgTs` (the bot's posted message ts, from the loopback reply response) is
 * the baseline the poller uses so it forwards only replies NEWER than the bot's
 * reply; when unknown it falls back to the thread root ts. NEVER throws — a
 * ledger error must not break a reply that already posted.
 * @returns {boolean} true when the ledger was written.
 */
function upsertBotThread(ledgerPath, { channel, thread_ts, botMsgTs }) {
  if (!channel || !thread_ts) return false;
  try {
    let data = { threads: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.threads && typeof parsed.threads === 'object') data = parsed;
    } catch { /* missing or corrupt → start fresh, preserving nothing we can't read */ }
    if (!data.threads || typeof data.threads !== 'object') data.threads = {};
    const prev = data.threads[thread_ts] || {};
    data.threads[thread_ts] = {
      channel,
      lastBotTs: tsMaxStr(prev.lastBotTs, botMsgTs || thread_ts),
      ts: thread_ts,
      updated: Date.now(),
    };
    const tmp = `${ledgerPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, ledgerPath);
    return true;
  } catch (e) {
    process.stderr.write(`md-slack-reply: warning — could not update follow-ledger: ${e.message}\n`);
    return false;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const channel = args.channel;
  const thread = args.thread || args.thread_ts;
  const text = args.text;

  if (!channel || !thread || !text || text === true) {
    fail('required: --channel <id> --thread <ts> --text "<message>"');
  }

  const configPath = args.config || process.env.MD_SLACK_REPLY_CONFIG;
  if (!configPath) {
    fail('cannot locate the reply endpoint: set MD_SLACK_REPLY_CONFIG or pass --config');
  }

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    fail(`reply endpoint not running (could not read ${configPath}): ${e.message}`);
  }
  if (!cfg || typeof cfg.port !== 'number' || typeof cfg.token !== 'string') {
    fail(`malformed reply config at ${configPath}`);
  }

  const ledgerPath = resolveLedgerPath(args, configPath);
  const body = JSON.stringify({ channel, thread_ts: thread, text });
  const req = http.request(
    {
      method: 'POST',
      host: '127.0.0.1',
      port: cfg.port,
      path: '/reply',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-md-reply-token': cfg.token
      }
    },
    (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = {};
        try { json = JSON.parse(raw); } catch { /* non-JSON body */ }
        if (res.statusCode === 200 && json.ok) {
          // Record this thread in the follow-ledger so the poller pulls the user's
          // FUTURE replies here (no @-mention needed). `json.ts` is the posted
          // message ts when the running MD build returns it; otherwise the upsert
          // baselines on the thread root. Fail-soft: never blocks the success path.
          upsertBotThread(ledgerPath, {
            channel, thread_ts: thread,
            botMsgTs: typeof json.ts === 'string' ? json.ts : undefined
          });
          process.stdout.write('Posted reply to Slack thread.\n');
          process.exit(0);
        }
        fail(`reply failed (HTTP ${res.statusCode}): ${json.error || raw || 'unknown error'}`);
      });
    }
  );
  req.on('error', (e) => fail(`could not reach reply endpoint: ${e.message}`));
  req.write(body);
  req.end();
}

// Run only when invoked directly; exporting the helpers keeps them testable.
if (require.main === module) main();

module.exports = { parseArgs, tsMaxStr, resolveLedgerPath, upsertBotThread };
