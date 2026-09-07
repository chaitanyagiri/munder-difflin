#!/usr/bin/env node
/**
 * md-slack-upload.cjs — share a LOCAL file into a Slack thread, WITHOUT ever
 * handling the bot token.
 *
 * Mirrors md-slack-reply.cjs: the Munder Difflin main process runs a loopback-only
 * HTTP endpoint (127.0.0.1, never tunneled) that holds the bot token and writes
 * its `{ port, token }` to a discovery file under userData. This helper POSTs the
 * file's LOCAL PATH (not its bytes) + the target channel/thread to that endpoint's
 * `/upload` route; main reads the file and runs Slack's external-upload flow
 * (files.getUploadURLExternal -> PUT bytes -> files.completeUploadExternal). The
 * token never appears here, in the prompt, in argv, or in any transcript.
 *
 * Usage:
 *   node md-slack-upload.cjs --channel C123 --thread 1700000000.000100 --file /abs/path.pdf
 *     [--title "Report"] [--comment "here you go"]
 *   (optional) --config /abs/path/to/slack-reply.json   (else MD_SLACK_REPLY_CONFIG)
 */
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

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
  process.stderr.write(`md-slack-upload: ${msg}\n`);
  process.exit(1);
}

/** Build the JSON payload the /upload endpoint expects (absolute file path). */
function buildUploadBody(args) {
  const channel = args.channel;
  const thread = args.thread || args.thread_ts;
  const file = args.file || args.path;
  if (!channel || !thread || !file || file === true) {
    return { error: 'required: --channel <id> --thread <ts> --file <abs path>' };
  }
  const absPath = path.resolve(String(file));
  const body = { channel, thread_ts: thread, path: absPath };
  if (typeof args.title === 'string') body.title = args.title;
  if (typeof args.filename === 'string') body.filename = args.filename;
  const comment = args.comment || args.initial_comment;
  if (typeof comment === 'string') body.initial_comment = comment;
  return { body, absPath };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const built = buildUploadBody(args);
  if (built.error) fail(built.error);

  // Fail early with a clear message if the file isn't there (main would 400 anyway).
  try {
    const st = fs.statSync(built.absPath);
    if (!st.isFile()) fail(`not a regular file: ${built.absPath}`);
  } catch (e) {
    fail(`cannot read file ${built.absPath}: ${e.message}`);
  }

  const configPath = args.config || process.env.MD_SLACK_REPLY_CONFIG;
  if (!configPath) {
    fail('cannot locate the upload endpoint: set MD_SLACK_REPLY_CONFIG or pass --config');
  }
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (e) { fail(`reply/upload endpoint not running (could not read ${configPath}): ${e.message}`); }
  if (!cfg || typeof cfg.port !== 'number' || typeof cfg.token !== 'string') {
    fail(`malformed reply config at ${configPath}`);
  }

  const payload = JSON.stringify(built.body);
  const req = http.request(
    {
      method: 'POST', host: '127.0.0.1', port: cfg.port, path: '/upload',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
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
          process.stdout.write('Uploaded file to Slack thread.\n');
          process.exit(0);
        }
        fail(`upload failed (HTTP ${res.statusCode}): ${json.error || raw || 'unknown error'}`);
      });
    }
  );
  req.on('error', (e) => fail(`could not reach upload endpoint: ${e.message}`));
  req.write(payload);
  req.end();
}

// Run only when invoked directly; exporting the helpers keeps them testable.
if (require.main === module) main();

module.exports = { parseArgs, buildUploadBody };
