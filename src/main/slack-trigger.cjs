'use strict';

// Pure trigger-decision logic for the Slack mention filter.
// Extracted as plain CommonJS so test/slack.test.cjs can require() it directly
// without a TypeScript compile step — same pattern as compact-gate.cjs.
//
// Responsibilities:
//   - isMention: ev.type==='app_mention' OR text includes <@botUserId>
//   - activatedThreads: bounded FIFO set of thread roots where the bot was mentioned
//   - shouldTrigger: combines channel filter, self-loop safety, mention/thread check

/** Maximum number of thread roots to remember. FIFO eviction above this limit
 *  prevents unbounded memory growth in long-running bots. */
const ACTIVATED_THREADS_MAX = 500;
/** Per-message file cap — any extras beyond this are silently dropped. */
const MAX_FILES_PER_MESSAGE = 10;
/** Maximum number of recently-seen message identities to remember for dedup.
 *  FIFO eviction above this caps memory in long-running bots. */
const SEEN_EVENTS_MAX = 500;

/**
 * Bounded FIFO set of thread timestamps where the bot was @-mentioned.
 * Once the bot is mentioned in a thread, all subsequent replies in that
 * thread trigger onMessage — until the entry is FIFO-evicted.
 */
class ActivatedThreads {
  constructor(maxSize = ACTIVATED_THREADS_MAX) {
    this.maxSize = maxSize;
    this._set = new Set();
    this._order = []; // FIFO eviction queue — parallel to _set
  }

  add(threadTs) {
    if (this._set.has(threadTs)) return; // already tracked
    if (this._set.size >= this.maxSize) {
      const oldest = this._order.shift();
      if (oldest !== undefined) this._set.delete(oldest);
    }
    this._set.add(threadTs);
    this._order.push(threadTs);
  }

  has(threadTs) { return this._set.has(threadTs); }
  get size()    { return this._set.size; }
}

/**
 * Bounded FIFO set used as an idempotency cache. Remembers recently-processed
 * message identities so the SAME logical Slack message — delivered twice because
 * the app subscribes to BOTH `app_mention` AND `message.*` (an @-mention in a
 * channel fires both), or re-delivered by Slack's retry of an un-acked event —
 * only fires onMessage (and therefore the ack reply) once.
 */
class SeenEvents {
  constructor(maxSize = SEEN_EVENTS_MAX) {
    this.maxSize = maxSize;
    this._set = new Set();
    this._order = []; // FIFO eviction queue — parallel to _set
  }

  /**
   * Record `key` and report whether it was ALREADY present.
   * @returns {boolean} true if `key` was seen before (caller should skip as a
   *          duplicate); false if it is new (now recorded — caller should process).
   *          Empty/falsy keys are never deduped: they always return false and are
   *          not stored (so a malformed event can't poison or fill the cache).
   */
  seen(key) {
    if (!key) return false;
    if (this._set.has(key)) return true;
    if (this._set.size >= this.maxSize) {
      const oldest = this._order.shift();
      if (oldest !== undefined) this._set.delete(oldest);
    }
    this._set.add(key);
    this._order.push(key);
    return false;
  }

  get size() { return this._set.size; }
}

/**
 * Stable identity for a Slack message, shared across the event types that can
 * carry it. The SAME user message arrives as BOTH an `app_mention` and a
 * `message.*` event when the app subscribes to both — two SEPARATE
 * event_callback deliveries. Those two deliveries share `channel` + `ts` (the
 * message timestamp) but each gets its OWN outer `event_id`, and `client_msg_id`
 * is not guaranteed on `app_mention`. So the only reliable cross-type key is
 * `channel:ts` — using event_id or client_msg_id here would let the duplicate
 * through. `channel:ts` also matches Slack's retry of an un-acked event.
 *
 * @returns {string} `"<channel>:<ts>"`, or '' when either is missing (uncacheable).
 */
function dedupKey(ev) {
  if (!ev) return '';
  const channel = typeof ev.channel === 'string' ? ev.channel : '';
  const ts = typeof ev.ts === 'string' ? ev.ts : '';
  return channel && ts ? `${channel}:${ts}` : '';
}

/**
 * Decide whether a Slack event should trigger onMessage.
 *
 * @param ev              - The `payload.event` object (any shape, may be partial)
 * @param botUserId       - Cached bot user id (string) or null if not yet known
 * @param channelId       - Channel filter (string) or null/undefined for any channel
 * @param activatedThreads - Mutable ActivatedThreads instance (mutated on mention)
 * @returns {{ trigger: boolean, text: string, files: object[] }} — trigger: whether to
 *          fire onMessage; text: the raw ev.text string (stripping is done in the caller);
 *          files: raw Slack file metadata extracted from ev.files[] (empty when none).
 */
function shouldTrigger(ev, botUserId, channelId, activatedThreads) {
  if (!ev) return { trigger: false, text: '', files: [] };

  // Channel filter
  const channelOk = !channelId || ev.channel === channelId;
  if (!channelOk) return { trigger: false, text: '', files: [] };

  // Self-loop + subtype safety: never trigger on bot posts, edits, joins, etc.
  // file_share IS allowed through — a file upload is eligible if it @-mentions the
  // bot or lands in an activated thread. All other subtypes remain blocked.
  if (ev.bot_id || (ev.subtype && ev.subtype !== 'file_share')) {
    return { trigger: false, text: '', files: [] };
  }

  const text = typeof ev.text === 'string' ? ev.text : '';

  // Is this an @-mention of the bot?
  const isMention =
    ev.type === 'app_mention' ||
    (ev.type === 'message' && botUserId != null && text.includes(`<@${botUserId}>`)) ||
    (ev.subtype === 'file_share' && botUserId != null && text.includes(`<@${botUserId}>`));

  // Is this a reply inside a thread where the bot was already mentioned?
  const isActivatedThread = !!(ev.thread_ts && activatedThreads.has(ev.thread_ts));

  if (!isMention && !isActivatedThread) return { trigger: false, text: '', files: [] };

  // On mention: activate the thread so future replies in it also trigger.
  // Use thread_ts if the mention is itself a reply, else the message's own ts.
  if (isMention) {
    const threadRoot = ev.thread_ts || ev.ts;
    if (threadRoot) activatedThreads.add(threadRoot);
  }

  // Extract file metadata from the event (file_share events carry ev.files[]).
  // Cap at MAX_FILES_PER_MESSAGE; only include entries that have a downloadable URL.
  const files = (Array.isArray(ev.files) ? ev.files : [])
    .filter((f) => f && typeof f.url_private === 'string' && f.url_private)
    .slice(0, MAX_FILES_PER_MESSAGE)
    .map((f) => ({
      id: f.id,
      url_private: f.url_private,
      name: typeof f.name === 'string' ? f.name : undefined,
      mimetype: typeof f.mimetype === 'string' ? f.mimetype : undefined,
      size: typeof f.size === 'number' ? f.size : undefined,
    }));

  return { trigger: true, text, files };
}

module.exports = {
  shouldTrigger,
  ActivatedThreads,
  SeenEvents,
  dedupKey,
  ACTIVATED_THREADS_MAX,
  SEEN_EVENTS_MAX,
  MAX_FILES_PER_MESSAGE,
};
