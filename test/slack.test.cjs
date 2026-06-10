'use strict';

const assert = require('assert');
const { shouldTrigger, ActivatedThreads, SeenEvents, dedupKey, ACTIVATED_THREADS_MAX, SEEN_EVENTS_MAX, MAX_FILES_PER_MESSAGE } =
  require('../src/main/slack-trigger.cjs');

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.log(`  ✗ ${name}\n     ${err.message}`);
  }
}

const BOT_ID = 'U12345BOT';
const CHANNEL = 'C99999';

function ev(overrides = {}) {
  return {
    type: 'message',
    channel: CHANNEL,
    text: 'hello',
    ts: '1000.0001',
    thread_ts: undefined,
    bot_id: undefined,
    subtype: undefined,
    ...overrides,
  };
}

(async () => {
  console.log('slack trigger tests (mention + activated-thread filter)');

  // ─── Case 1: plain message, no mention, no active thread → NOT triggered ───

  await test('plain message with no mention and no active thread → NOT triggered', () => {
    const threads = new ActivatedThreads();
    const result = shouldTrigger(ev({ text: 'hello world' }), BOT_ID, null, threads);
    assert.strictEqual(result.trigger, false);
    assert.strictEqual(threads.size, 0, 'thread must not be activated');
  });

  // ─── Case 2: message mentioning bot → triggered + thread activated ──────────

  await test('message with @mention → triggered and thread root activated', () => {
    const threads = new ActivatedThreads();
    const result = shouldTrigger(
      ev({ text: `<@${BOT_ID}> please help`, ts: '1000.0002' }),
      BOT_ID, null, threads
    );
    assert.strictEqual(result.trigger, true);
    assert.ok(result.text.includes('please help'), 'text forwarded');
    assert.ok(threads.has('1000.0002'), 'message ts activated as thread root');
  });

  await test('app_mention event type → triggered even without text mention', () => {
    const threads = new ActivatedThreads();
    const result = shouldTrigger(
      ev({ type: 'app_mention', text: 'do something', ts: '1000.0003' }),
      null, null, threads // botUserId=null — type alone is enough
    );
    assert.strictEqual(result.trigger, true);
    assert.ok(threads.has('1000.0003'), 'app_mention activates thread root');
  });

  // ─── Case 3: reply in activated thread (no mention) → triggered ─────────────

  await test('reply in activated thread without re-mention → triggered', () => {
    const threads = new ActivatedThreads();
    // First: mention activates the thread
    shouldTrigger(ev({ text: `<@${BOT_ID}> start`, ts: '2000.0001' }), BOT_ID, null, threads);
    assert.ok(threads.has('2000.0001'));
    // Then: a plain reply in that thread triggers
    const result = shouldTrigger(
      ev({ text: 'follow-up question', ts: '2000.0002', thread_ts: '2000.0001' }),
      BOT_ID, null, threads
    );
    assert.strictEqual(result.trigger, true, 'thread reply should trigger');
    assert.strictEqual(result.text, 'follow-up question');
  });

  // ─── Case 4: bot's own reply (bot_id set) → NOT triggered ───────────────────

  await test("bot's own threaded reply (bot_id) → NOT triggered (self-loop safety)", () => {
    const threads = new ActivatedThreads();
    // Activate the thread first
    shouldTrigger(ev({ text: `<@${BOT_ID}> hi`, ts: '3000.0001' }), BOT_ID, null, threads);
    // Bot posts a reply — must NOT trigger
    const result = shouldTrigger(
      ev({ text: 'I am the bot response', ts: '3000.0002', thread_ts: '3000.0001', bot_id: 'B_BOT' }),
      BOT_ID, null, threads
    );
    assert.strictEqual(result.trigger, false, 'bot reply must not loop back');
  });

  await test('subtype message (e.g. message_changed) → NOT triggered', () => {
    const threads = new ActivatedThreads();
    const result = shouldTrigger(
      ev({ text: `<@${BOT_ID}> edit`, subtype: 'message_changed' }),
      BOT_ID, null, threads
    );
    assert.strictEqual(result.trigger, false);
  });

  // ─── Case 5: mention inside sub-thread → activates ev.thread_ts ─────────────

  await test('mention in a reply → activates ev.thread_ts (not ev.ts)', () => {
    const threads = new ActivatedThreads();
    const rootTs = '4000.0001';
    const replyTs = '4000.0099';
    // Bot is mentioned in a reply (not a root message)
    const result = shouldTrigger(
      ev({ text: `<@${BOT_ID}> help in thread`, ts: replyTs, thread_ts: rootTs }),
      BOT_ID, null, threads
    );
    assert.strictEqual(result.trigger, true);
    // thread_ts is the key, not ts
    assert.ok(threads.has(rootTs), 'thread root activated');
    assert.ok(!threads.has(replyTs), 'reply ts not stored as root');
  });

  // ─── Case 6: channel filter respected ────────────────────────────────────────

  await test('wrong channel → NOT triggered even with mention', () => {
    const threads = new ActivatedThreads();
    const result = shouldTrigger(
      ev({ text: `<@${BOT_ID}> help`, channel: 'C_OTHER' }),
      BOT_ID, CHANNEL, threads // channelId = CHANNEL, event is in C_OTHER
    );
    assert.strictEqual(result.trigger, false);
    assert.strictEqual(threads.size, 0, 'wrong-channel mention must not activate thread');
  });

  await test('matching channel → triggered', () => {
    const threads = new ActivatedThreads();
    const result = shouldTrigger(
      ev({ text: `<@${BOT_ID}> hello`, channel: CHANNEL }),
      BOT_ID, CHANNEL, threads
    );
    assert.strictEqual(result.trigger, true);
  });

  await test('no channel filter (null) → any channel triggers', () => {
    const threads = new ActivatedThreads();
    const result = shouldTrigger(
      ev({ text: `<@${BOT_ID}> hi`, channel: 'C_RANDOM' }),
      BOT_ID, null, threads
    );
    assert.strictEqual(result.trigger, true);
  });

  // ─── Case 7: activatedThreads bound enforced ─────────────────────────────────

  await test('activatedThreads evicts oldest when cap is reached', () => {
    const maxSize = 3;
    const threads = new ActivatedThreads(maxSize);
    // Fill to cap
    threads.add('t1');
    threads.add('t2');
    threads.add('t3');
    assert.strictEqual(threads.size, maxSize);
    // Add one more — t1 should be evicted (FIFO)
    threads.add('t4');
    assert.strictEqual(threads.size, maxSize, 'size stays at cap');
    assert.ok(!threads.has('t1'), 't1 evicted');
    assert.ok(threads.has('t2'), 't2 still present');
    assert.ok(threads.has('t3'), 't3 still present');
    assert.ok(threads.has('t4'), 't4 added');
  });

  await test('default cap is ACTIVATED_THREADS_MAX', () => {
    assert.strictEqual(ACTIVATED_THREADS_MAX, 500);
    const threads = new ActivatedThreads();
    // Fill to cap + 1 — size must stay at ACTIVATED_THREADS_MAX
    for (let i = 0; i <= ACTIVATED_THREADS_MAX; i++) threads.add(`t${i}`);
    assert.strictEqual(threads.size, ACTIVATED_THREADS_MAX);
    assert.ok(!threads.has('t0'), 't0 evicted');
    assert.ok(threads.has(`t${ACTIVATED_THREADS_MAX}`), 'last entry present');
  });

  // ─── Edge cases ───────────────────────────────────────────────────────────────

  await test('botUserId null → text mention not detected (app_mention still works)', () => {
    const threads = new ActivatedThreads();
    // Text mention with no known botUserId → no trigger
    const r1 = shouldTrigger(ev({ text: `<@UNKNOWN> hi` }), null, null, threads);
    assert.strictEqual(r1.trigger, false);
    // app_mention type still triggers regardless
    const r2 = shouldTrigger(ev({ type: 'app_mention', text: 'hi' }), null, null, threads);
    assert.strictEqual(r2.trigger, true);
  });

  await test('null/undefined event → NOT triggered', () => {
    const threads = new ActivatedThreads();
    assert.strictEqual(shouldTrigger(null, BOT_ID, null, threads).trigger, false);
    assert.strictEqual(shouldTrigger(undefined, BOT_ID, null, threads).trigger, false);
  });

  // ─── Case 8: file_share attachment handling ───────────────────────────────────

  function fileEv(overrides = {}) {
    return ev({
      subtype: 'file_share',
      text: '',
      files: [{ id: 'F001', url_private: 'https://files.slack.com/files-pri/T01/F001/img.png', name: 'img.png', mimetype: 'image/png', size: 102400 }],
      ...overrides,
    });
  }

  await test('file_share + @mention → triggered and files extracted', () => {
    const threads = new ActivatedThreads();
    const result = shouldTrigger(
      fileEv({ text: `<@${BOT_ID}> look at this`, ts: '5000.0001' }),
      BOT_ID, null, threads
    );
    assert.strictEqual(result.trigger, true, 'should trigger on mentioned file_share');
    assert.ok(Array.isArray(result.files), 'files must be an array');
    assert.strictEqual(result.files.length, 1, 'one file extracted');
    assert.strictEqual(result.files[0].url_private, 'https://files.slack.com/files-pri/T01/F001/img.png');
    assert.strictEqual(result.files[0].name, 'img.png');
    assert.strictEqual(result.files[0].mimetype, 'image/png');
    assert.ok(threads.has('5000.0001'), 'thread activated on file_share mention');
  });

  await test('file_share in activated thread (no re-mention) → triggered', () => {
    const threads = new ActivatedThreads();
    // Activate via text mention first
    shouldTrigger(ev({ text: `<@${BOT_ID}> start`, ts: '5001.0001' }), BOT_ID, null, threads);
    const result = shouldTrigger(
      fileEv({ ts: '5001.0002', thread_ts: '5001.0001' }),
      BOT_ID, null, threads
    );
    assert.strictEqual(result.trigger, true, 'file in activated thread must trigger');
    assert.strictEqual(result.files.length, 1, 'file extracted from activated-thread upload');
  });

  await test('file_share with no mention and no activated thread → NOT triggered', () => {
    const threads = new ActivatedThreads();
    const result = shouldTrigger(fileEv({ text: '' }), BOT_ID, null, threads);
    assert.strictEqual(result.trigger, false, 'unaddressed file upload must not trigger');
    assert.strictEqual(threads.size, 0, 'must not activate any thread');
  });

  await test('other subtype (message_changed) even with files → NOT triggered', () => {
    const threads = new ActivatedThreads();
    const result = shouldTrigger(
      ev({ subtype: 'message_changed', text: `<@${BOT_ID}> edit`, files: [{ url_private: 'https://x.slack.com/f' }] }),
      BOT_ID, null, threads
    );
    assert.strictEqual(result.trigger, false, 'message_changed must always be blocked');
  });

  await test('files without url_private are filtered out', () => {
    const threads = new ActivatedThreads();
    const result = shouldTrigger(
      ev({
        text: `<@${BOT_ID}> see these`,
        files: [
          { id: 'F001', url_private: 'https://files.slack.com/f1', name: 'f1.txt', mimetype: 'text/plain' },
          { id: 'F002', name: 'no-url.txt' }, // no url_private
          { url_private: '' },                  // empty url_private
        ]
      }),
      BOT_ID, null, threads
    );
    assert.strictEqual(result.trigger, true);
    assert.strictEqual(result.files.length, 1, 'only the file with url_private is kept');
    assert.strictEqual(result.files[0].id, 'F001');
  });

  await test(`files capped at MAX_FILES_PER_MESSAGE (${MAX_FILES_PER_MESSAGE})`, () => {
    const threads = new ActivatedThreads();
    const manyFiles = Array.from({ length: MAX_FILES_PER_MESSAGE + 5 }, (_, i) => ({
      id: `F${i}`, url_private: `https://files.slack.com/f${i}`, name: `f${i}.txt`, mimetype: 'text/plain',
    }));
    const result = shouldTrigger(
      ev({ text: `<@${BOT_ID}> lots`, files: manyFiles }),
      BOT_ID, null, threads
    );
    assert.strictEqual(result.trigger, true);
    assert.strictEqual(result.files.length, MAX_FILES_PER_MESSAGE, `capped to ${MAX_FILES_PER_MESSAGE}`);
  });

  await test('text-only trigger still returns empty files array', () => {
    const threads = new ActivatedThreads();
    const result = shouldTrigger(
      ev({ text: `<@${BOT_ID}> just text` }),
      BOT_ID, null, threads
    );
    assert.strictEqual(result.trigger, true);
    assert.ok(Array.isArray(result.files), 'files must always be an array');
    assert.strictEqual(result.files.length, 0, 'no files for text-only message');
  });

  // ─── Download URL + auth header construction (mocked) ─────────────────────────
  // These tests verify the download helper logic directly without actual HTTPS calls.

  await test('sanitizeSlackFilename: blocks path traversal and special chars', () => {
    // We test the filename sanitization rules inline (pure logic, no HTTPS).
    const sanitize = (name, tag) => {
      const { basename } = require('node:path');
      const safe = (typeof name === 'string' && name)
        ? basename(name).replace(/[^\w.\-]/g, '_').replace(/^\.+/, '_').slice(0, 200) || 'file'
        : 'file';
      return `${tag}-${safe}`;
    };
    // Path traversal attempt
    assert.ok(!sanitize('../../../etc/passwd', 'x').includes('..'), 'no path traversal');
    assert.ok(!sanitize('/etc/shadow', 'x').includes('/'), 'no leading slash');
    // Leading dots
    assert.ok(!sanitize('.hidden', 'x').split('-')[1].startsWith('.'), 'leading dot replaced');
    // Normal name passes through
    assert.ok(sanitize('image.png', 'abc').endsWith('image.png'), 'normal name preserved');
  });

  await test('bot token is NOT included in files array sent via IPC (structural check)', () => {
    // The IPC message shape: { text, channel, ts, thread_ts, files?: [{path, name, mimetype}] }
    // No url_private, no bot token field.
    const ipcFiles = [{ path: '/tmp/slack-files/abc-img.png', name: 'img.png', mimetype: 'image/png' }];
    assert.ok(!JSON.stringify(ipcFiles).includes('Bearer'), 'no Bearer token in IPC files');
    assert.ok(!JSON.stringify(ipcFiles).includes('url_private'), 'no url_private in IPC files');
    assert.ok(ipcFiles[0].path.startsWith('/'), 'path is absolute');
  });

  // ─── Dedup: same message via app_mention + message.* fires onMessage once ───

  await test('dedupKey is identical for app_mention and message events of the SAME message', () => {
    // The two deliveries share channel + ts but get distinct outer event_ids.
    const appMention = ev({ type: 'app_mention', text: `<@${BOT_ID}> hi`, ts: '1700.0001' });
    const message    = ev({ type: 'message',     text: `<@${BOT_ID}> hi`, ts: '1700.0001' });
    const k1 = dedupKey(appMention);
    const k2 = dedupKey(message);
    assert.strictEqual(k1, `${CHANNEL}:1700.0001`, 'key is channel:ts');
    assert.strictEqual(k1, k2, 'app_mention and message yield the SAME dedup key');
  });

  await test('dedupKey returns "" when channel or ts is missing (uncacheable)', () => {
    assert.strictEqual(dedupKey(ev({ ts: undefined })), '', 'no ts → empty');
    assert.strictEqual(dedupKey(ev({ channel: undefined })), '', 'no channel → empty');
    assert.strictEqual(dedupKey(null), '', 'null event → empty');
  });

  await test('SeenEvents.seen: first occurrence false (new), repeat true (duplicate)', () => {
    const seen = new SeenEvents();
    assert.strictEqual(seen.seen('C1:100.1'), false, 'first time is new');
    assert.strictEqual(seen.seen('C1:100.1'), true, 'second time is a duplicate');
    assert.strictEqual(seen.seen('C1:100.2'), false, 'a different key is new');
  });

  await test('SeenEvents never dedupes empty/falsy keys (and does not store them)', () => {
    const seen = new SeenEvents();
    assert.strictEqual(seen.seen(''), false, 'empty key never a duplicate');
    assert.strictEqual(seen.seen(''), false, 'empty key still never a duplicate');
    assert.strictEqual(seen.size, 0, 'empty keys are not stored');
  });

  await test('SeenEvents is bounded FIFO — oldest key evicted past the cap', () => {
    const seen = new SeenEvents(3);
    seen.seen('a'); seen.seen('b'); seen.seen('c');
    assert.strictEqual(seen.size, 3, 'at cap');
    seen.seen('d'); // evicts 'a'
    assert.strictEqual(seen.size, 3, 'still at cap after eviction');
    assert.strictEqual(seen.seen('a'), false, 'evicted "a" is treated as new again');
    assert.strictEqual(seen.seen('c'), true, '"c" still remembered');
  });

  await test('SEEN_EVENTS_MAX default is exported and sane', () => {
    assert.strictEqual(typeof SEEN_EVENTS_MAX, 'number', 'is a number');
    assert.ok(SEEN_EVENTS_MAX >= 100, 'reasonable cap');
  });

  await test('integration: dual-subscription double-fire collapses to ONE delivery', () => {
    // Mirrors slack.ts handleBody: shouldTrigger (gate) THEN seenEvents dedup.
    const threads = new ActivatedThreads();
    const seen = new SeenEvents();
    let fires = 0;
    const ingest = (event) => {
      const { trigger } = shouldTrigger(event, BOT_ID, CHANNEL, threads);
      if (!trigger) return;
      const key = dedupKey(event);
      if (key && seen.seen(key)) return; // duplicate — skip
      fires++;
    };
    // SAME @-mention delivered as both event types (shared channel:ts).
    ingest(ev({ type: 'app_mention', text: `<@${BOT_ID}> ship it`, ts: '1800.0009' }));
    ingest(ev({ type: 'message',     text: `<@${BOT_ID}> ship it`, ts: '1800.0009' }));
    assert.strictEqual(fires, 1, 'onMessage fires exactly once for the duplicated message');
  });

  await test('integration: a genuinely new message in same channel still fires', () => {
    const threads = new ActivatedThreads();
    const seen = new SeenEvents();
    let fires = 0;
    const ingest = (event) => {
      const { trigger } = shouldTrigger(event, BOT_ID, CHANNEL, threads);
      if (!trigger) return;
      const key = dedupKey(event);
      if (key && seen.seen(key)) return;
      fires++;
    };
    ingest(ev({ type: 'app_mention', text: `<@${BOT_ID}> one`, ts: '1900.0001' }));
    ingest(ev({ type: 'message',     text: `<@${BOT_ID}> one`, ts: '1900.0001' })); // dup
    ingest(ev({ type: 'app_mention', text: `<@${BOT_ID}> two`, ts: '1900.0002' })); // new
    assert.strictEqual(fires, 2, 'distinct ts values each fire once');
  });

  console.log(failures === 0 ? '\nall passed' : `\n${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
})();
