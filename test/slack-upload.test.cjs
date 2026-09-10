'use strict';

// Tests for OUTBOUND Slack media upload — the tokenless /upload loopback route
// (SlackReplyServer) + the md-slack-upload.cjs helper's payload building. Slack is
// mocked via the injectable uploadFn (no real HTTP, no token needed).

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { SlackReplyServer } = loadTs('src/main/slack.ts');
const { parseArgs, buildUploadBody } = require('../resources/md-slack-upload.cjs');

const TOKEN = 'sekret-reply-token';

function req(port, { body, token = TOKEN, route = '/upload' } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const r = http.request({
      method: 'POST', hostname: '127.0.0.1', port, path: route, agent: false,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(raw),
        ...(token ? { 'x-md-reply-token': token } : {})
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    r.on('error', reject);
    r.write(raw); r.end();
  });
}

async function startServer(opts) {
  const server = new SlackReplyServer({ token: TOKEN, getBotToken: () => 'xoxb-fake', ...opts });
  const r = await server.start(0);
  assert.equal(r.ok, true);
  return { server, port: r.port };
}

const CH = 'C0EXAMPLE01';
const TS = '1788723887.610069';

function tmpFile(contents = 'hello pdf bytes') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdupload-'));
  const p = path.join(dir, 'report.pdf');
  fs.writeFileSync(p, contents);
  return { dir, p };
}

// ─── helper payload building ─────────────────────────────────────────────────
test('buildUploadBody: requires channel/thread/file; resolves abs path; carries title+comment', () => {
  assert.ok(buildUploadBody(parseArgs(['--channel', CH])).error, 'missing thread/file → error');
  const { body, absPath } = buildUploadBody(parseArgs(['--channel', CH, '--thread', TS, '--file', '/tmp/x.pdf', '--title', 'R', '--comment', 'hi']));
  assert.equal(body.channel, CH);
  assert.equal(body.thread_ts, TS);
  assert.equal(body.path, path.resolve('/tmp/x.pdf'));
  assert.equal(absPath, path.resolve('/tmp/x.pdf'));
  assert.equal(body.title, 'R');
  assert.equal(body.initial_comment, 'hi');
});

// ─── /upload route (Slack mocked via uploadFn) ───────────────────────────────
test('/upload: reads the local file and hands its bytes + target to uploadFn (200)', async () => {
  const { dir, p } = tmpFile('%PDF-1.7 real pdf content');
  let captured = null;
  const uploadFn = async (o) => { captured = o; return { ok: true, file_id: 'F_TEST' }; };
  const { server, port } = await startServer({ uploadFn });
  try {
    const r = await req(port, { body: { channel: CH, thread_ts: TS, path: p, title: 'My Report' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.file_id, 'F_TEST');
    assert.equal(captured.channel, CH);
    assert.equal(captured.thread_ts, TS);
    assert.equal(captured.filename, 'report.pdf', 'filename defaults to basename');
    assert.equal(captured.title, 'My Report');
    assert.equal(captured.buffer.toString('utf8'), '%PDF-1.7 real pdf content', 'main read the real bytes');
    assert.equal(captured.botToken, 'xoxb-fake', 'token supplied by main, never by the caller');
  } finally { server.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('/upload: records the thread as bot-participated (onReplied) on success', async () => {
  const { dir, p } = tmpFile();
  let replied = null;
  const { server, port } = await startServer({
    uploadFn: async () => ({ ok: true, file_id: 'F1' }),
    onReplied: (thread_ts, channel) => { replied = { thread_ts, channel }; }
  });
  try {
    await req(port, { body: { channel: CH, thread_ts: TS, path: p } });
    assert.deepEqual(replied, { thread_ts: TS, channel: CH }, 'upload marks the thread followed like a reply');
  } finally { server.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('/upload: missing file path → 400, uploadFn never called', async () => {
  let called = false;
  const { server, port } = await startServer({ uploadFn: async () => { called = true; return { ok: true }; } });
  try {
    const r = await req(port, { body: { channel: CH, thread_ts: TS } });
    assert.equal(r.status, 400);
    assert.equal(called, false);
  } finally { server.stop(); }
});

test('/upload: nonexistent file → 400 (never a stub upload)', async () => {
  let called = false;
  const { server, port } = await startServer({ uploadFn: async () => { called = true; return { ok: true }; } });
  try {
    const r = await req(port, { body: { channel: CH, thread_ts: TS, path: '/no/such/file-xyz.pdf' } });
    assert.equal(r.status, 400);
    assert.equal(called, false);
  } finally { server.stop(); }
});

test('/upload: wrong reply token → 401', async () => {
  const { dir, p } = tmpFile();
  const { server, port } = await startServer({ uploadFn: async () => ({ ok: true }) });
  try {
    const r = await req(port, { body: { channel: CH, thread_ts: TS, path: p }, token: 'wrong' });
    assert.equal(r.status, 401);
  } finally { server.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('/upload: no bot token configured → 503', async () => {
  const { dir, p } = tmpFile();
  const server = new SlackReplyServer({ token: TOKEN, getBotToken: () => undefined, uploadFn: async () => ({ ok: true }) });
  const started = await server.start(0);
  try {
    const r = await req(started.port, { body: { channel: CH, thread_ts: TS, path: p } });
    assert.equal(r.status, 503);
  } finally { server.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('/reply still works after adding the /upload route (no regression)', async () => {
  // getBotToken returns a fake; postSlackReply will try real Slack and fail — we
  // only assert routing/validation reached the reply branch (not a 404/401).
  const { server, port } = await startServer({ uploadFn: async () => ({ ok: true }) });
  try {
    const r = await req(port, { route: '/reply', body: { channel: CH, thread_ts: TS } }); // missing text
    assert.equal(r.status, 400, 'reply validation still runs (missing text)');
    assert.equal(r.body.error, 'channel, thread, text required');
  } finally { server.stop(); }
});
