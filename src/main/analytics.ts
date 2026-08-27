/**
 * Product analytics (PostHog) — anonymous, allowlisted, opt-out.
 *
 * This is the OUTBOUND product-usage counterpart to telemetry.ts (which is the
 * loopback-only OTel collector and never leaves the machine). Everything here
 * is governed by TELEMETRY.md — the public contract. Keep the two in lockstep:
 * an event or property that isn't in TELEMETRY.md must not be added here, and
 * vice versa.
 *
 * 🔒 Anonymity is BY CONSTRUCTION, same philosophy as telemetry.ts:
 *   - Every event carries `$process_person_profile: false` → PostHog stores it
 *     as an anonymous event and never creates a person profile.
 *   - The distinct id is a RANDOM UUID minted at first run and stored in
 *     userData (`telemetry-install-id`) — not a machine id, not derivable from
 *     anything, gone when the app's data dir is deleted.
 *   - `track()` enforces a per-event property ALLOWLIST (EVENTS below), so a
 *     future call site cannot leak a new property by accident: unknown events
 *     and unknown keys are dropped, never sent.
 *   - No prompts, transcripts, file paths, repo names, hostnames, or agent
 *     output — nothing free-form crosses this seam.
 *
 * Sending is gated on ALL of (checked in this order):
 *   1. A build-time key (__POSTHOG_KEY__, injected from the POSTHOG_KEY env in
 *      release CI). Dev builds and forks compile with '' → this whole module is
 *      a silent no-op for them.
 *   2. The DO_NOT_TRACK env convention (any value except '' / '0') — respected
 *      unconditionally, checked at every send so it can't be raced.
 *   3. The user's `telemetryEnabled` config (Settings → Privacy; default ON,
 *      i.e. opt-out — flipped live via setEnabled()).
 *
 * Deliberately free of any `electron` import (paths/version are injected via
 * init) so it can be smoke-tested as a plain Node module, like telemetry.ts.
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PostHog } from 'posthog-node';

// Injected by electron-vite `define` (electron.vite.config.ts) from the
// POSTHOG_KEY / POSTHOG_HOST env at BUILD time. Empty in dev/fork builds.
declare const __POSTHOG_KEY__: string;
declare const __POSTHOG_HOST__: string;

/** The complete event → allowed-property-keys contract. Mirrors TELEMETRY.md
 *  exactly; `track()` refuses anything outside it. Common props (`app_version`,
 *  `os`, `arch`) are stamped centrally and are not listed per event. */
const EVENTS: Record<string, ReadonlySet<string>> = {
  /** Once per install, when the install id is first minted. */
  first_run: new Set<string>(),
  /** Every app start. The DAU/retention backbone. */
  app_launched: new Set<string>(),
  /** Once per version change, on the first run after the version moved. Both
   *  values are version strings of the same shape as the `app_version` every
   *  event already carries; `from_version` is `unknown` for an install that
   *  predates version stamping (i.e. anything upgrading INTO the first release
   *  that ships this event). `via` is a fixed three-value enum saying whether
   *  OUR updater moved the version or something else did. */
  update_applied: new Set<string>(['from_version', 'to_version', 'via']),
  /** An agent PTY spawned. `provider` is the CLI engine name only. */
  agent_spawned: new Set<string>(['provider']),
  /** ── The activation funnel (v0.4.6): app_launched → onboarding_completed →
   *  agent_spawn_attempted → {agent_spawned | agent_spawn_failed |
   *  agent_install_started → agent_install_finished}. Every added property is a
   *  closed enum or a closed CLI name — nothing free-form, same allowlist rule. */
  /** Onboarding wizard finished (the install crossed onboardingComplete
   *  false→true). `provider` is the engine chosen, a closed CLI name. The top of
   *  the funnel: what share of installs finish setup, and which engine they pick. */
  onboarding_completed: new Set<string>(['provider']),
  /** A spawn was REQUESTED — every path through spawnAgentCore. Mirrors
   *  agent_spawned; (attempted − spawned) is the activation fallout. */
  agent_spawn_attempted: new Set<string>(['provider']),
  /** A spawn did NOT produce a running agent. `reason` is a fixed enum (see
   *  SpawnFailReason): `cli_missing` (engine absent and no auto-installer, manual
   *  only), `cwd_missing`, `already_running`, `spawn_error`. */
  agent_spawn_failed: new Set<string>(['provider', 'reason']),
  /** The engine CLI was absent, so the auto-installer PTY started. `rung` is a
   *  fixed enum (see InstallRung): `npm`, `node-then-npm`, `native`. */
  agent_install_started: new Set<string>(['provider', 'rung']),
  /** The auto-installer PTY exited. `outcome` is a fixed enum (see
   *  InstallOutcome): `agent_launched` (clean exit, the agent is relaunching) or
   *  `install_failed` (non-zero exit — e.g. an installer that cannot complete
   *  unattended). This is the signal that a first agent never actually started. */
  agent_install_finished: new Set<string>(['provider', 'rung', 'outcome']),
  /** ── The end of the activation funnel (v0.4.6): a HUMAN sent a message to an
   *  agent. Counted at the SUBMIT boundary, never per keystroke — see
   *  MESSAGE_SURFACES for the four places a person can send one. Carries a COUNT
   *  and nothing else: no text, no length, no hash. `surface` is a closed enum. */
  message_sent: new Set<string>(['surface']),
  /** Coarse feature adoption; `feature` is a fixed enum (see FEATURES), fired
   *  at most once per feature per app session. */
  feature_used: new Set<string>(['feature']),
  /** Fired on quit. `duration_bucket` is a coarse label, never raw ms. */
  session_ended: new Set<string>(['duration_bucket'])
};

/** The only values `feature_used.feature` may take. */
export type AnalyticsFeature =
  | 'slack_trigger'
  | 'webhook_trigger'
  | 'hire_install'
  | 'voice_dictation';

/** The only values `agent_spawn_failed.reason` may take. A closed enum so the
 *  "why didn't the agent start" split can never carry a free-form message. */
export type SpawnFailReason = 'cli_missing' | 'cwd_missing' | 'already_running' | 'spawn_error';

/** The only values the install events' `rung` may take. Mirrors
 *  cliInstall.InstallRungKind minus `manual` — a manual rung spawns no installer,
 *  so it never reaches agent_install_started; it is an agent_spawn_failed:cli_missing. */
export type InstallRung = 'npm' | 'node-then-npm' | 'native';

/** The only values `agent_install_finished.outcome` may take. */
export type InstallOutcome = 'agent_launched' | 'install_failed';

/** The only values `message_sent.surface` may take — the four places a HUMAN can
 *  send a message to an agent:
 *
 *   - `terminal` — typed straight into the agent's terminal and submitted with
 *     Enter (terminalPool's submit boundary, NOT `pty:write`, which fires on
 *     every keystroke and would count typing, not messages).
 *   - `composer` — the per-agent message queue composer.
 *   - `steer`    — the steer box on the agent control strip.
 *   - `hive`     — a hive message sent by the human (Command Center dispatch,
 *     a thread reply, an ASK ME answer). Agent-to-agent hive traffic is NOT
 *     counted: `hive:send` carries a `from` and only `'human'` qualifies.
 *
 *  Closed enum, same rule as every other property here. */
export const MESSAGE_SURFACES = ['terminal', 'composer', 'steer', 'hive'] as const;
export type MessageSurface = typeof MESSAGE_SURFACES[number];

/** The subset of MESSAGE_SURFACES the RENDERER is allowed to name over IPC.
 *
 *  `steer` and `hive` are counted in main, at the IPC handlers that already
 *  receive them, so the renderer must not be able to name those two — otherwise
 *  a future renderer call site could double-count a message main has already
 *  counted. `terminal` and `composer` are the only submits main cannot see for
 *  itself, so they are the only ones that cross the bridge. */
const RENDERER_MESSAGE_SURFACES: ReadonlySet<string> = new Set<string>(['terminal', 'composer']);

/** Validate a surface arriving from the renderer. Everything crossing that seam
 *  is untrusted input, and `track()`'s allowlist filters property KEYS but not
 *  property VALUES — so without this an unrecognised string would ride along as
 *  a free-form value, exactly what TELEMETRY.md promises never happens. */
export function isRendererMessageSurface(v: unknown): v is MessageSurface {
  return typeof v === 'string' && RENDERER_MESSAGE_SURFACES.has(v);
}

export interface AnalyticsInitOptions {
  /** Directory for the install-id file (userData). Created if missing. */
  stateDir: string;
  /** App version stamped on every event. */
  appVersion: string;
  /** The user's `telemetryEnabled` config at boot (default true = opt-out). */
  enabled: boolean;
}

function dntSet(): boolean {
  const v = process.env.DO_NOT_TRACK;
  return v !== undefined && v !== '' && v !== '0';
}

/** Exported for the unit test only — index.ts uses the `analytics` singleton
 *  below. Constructing a fresh one is the only way to exercise the once-per-
 *  install paths (first_run, update_applied) more than once in a process. */
export class Analytics {
  private client: PostHog | null = null;
  private distinctId = '';
  private enabled = false;
  private firstRun = false;
  /** False when the state dir was unwritable and loadOrMintInstallId fell back
   *  to an ephemeral id. Such an install cannot be recognised across boots, so
   *  it must never report a version transition — it would report one on EVERY
   *  boot and inflate the exact number update_applied exists to produce. */
  private idPersisted = false;
  private startedAt = 0;
  private sessionEnded = false;
  /** Session-scoped dedup for feature_used. */
  private readonly featuresSeen = new Set<string>();
  private common: Record<string, string> = {};

  /** Boot the client (no-op without a build-time key / with DNT set). Returns
   *  whether this boot minted a fresh install id (first run ever). */
  init(opts: AnalyticsInitOptions): void {
    this.enabled = opts.enabled;
    this.startedAt = Date.now();
    this.common = {
      app_version: opts.appVersion,
      os: process.platform,
      arch: process.arch
    };
    if (!__POSTHOG_KEY__ || dntSet()) return; // stay dark: no client, no id file
    try {
      this.distinctId = this.loadOrMintInstallId(opts.stateDir);
      this.client = new PostHog(__POSTHOG_KEY__, {
        host: __POSTHOG_HOST__ || 'https://us.i.posthog.com',
        // Events are rare (a handful per session) — send immediately so quit
        // loses at most the final session_ended, never a whole batch.
        flushAt: 1,
        flushInterval: 10_000,
        // GeoIP stays OFF (posthog-node default). It was explicitly re-enabled
        // here for country-level numbers, but nothing in this codebase ever read
        // a country, and enabling it made PostHog derive city, postal code and
        // lat/long as well — far past the country TELEMETRY.md describes.
        disableGeoip: true
      });
    } catch (e) {
      console.error('[analytics] init failed (telemetry disabled):', e);
      this.client = null;
      return;
    }
    // Version-change detection. Read BEFORE the stamp is refreshed, and stamp
    // BEFORE sending: at-most-once beats at-least-once here, because a
    // duplicated update_applied would corrupt the very count it exists to
    // produce, while a lost one costs a single install out of thousands. The
    // stamp is refreshed for a user who opted out IN THE APP — we record
    // locally and let track() decide whether anything leaves the machine, so
    // turning it back on never back-fills a transition from the dark period.
    // It is NOT refreshed under DO_NOT_TRACK or without a build key, because
    // init() returns above before anything here runs: those installs write no
    // file at all, and a DNT user who later unsets it reports 'unknown' once.
    let transition: VersionTransition | null = null;
    if (this.idPersisted) {
      const previous = readVersionStamp(opts.stateDir);
      transition = updateTransition(previous, opts.appVersion, this.firstRun);
      if (previous !== opts.appVersion) writeVersionStamp(opts.stateDir, opts.appVersion);
    }

    if (this.firstRun) this.track('first_run');
    if (transition) {
      const via = updateVia(readUpdaterLogTail(opts.stateDir), transition.to_version);
      this.track('update_applied', { ...transition, via });
    }
    this.track('app_launched');
  }

  /** Live opt-in/out from Settings. Turning off stops sends instantly; nothing
   *  needs recreating to turn back on. */
  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  /** Capture one allowlisted event. Silently drops anything not in EVENTS. */
  track(event: string, props: Record<string, string> = {}): void {
    if (!this.client || !this.enabled || dntSet() || this.sessionEnded) return;
    const allowed = EVENTS[event];
    if (!allowed) return;
    const properties: Record<string, unknown> = {
      ...this.common,
      $process_person_profile: false, // anonymous event — no person profile
      // PostHog fills $ip from the connection ONLY when the event does not
      // carry one, so sending it explicitly as null is the one client-side way
      // to stop the IP being stored. Belt and braces with the project-level
      // discard setting: this alone protects every event we send from here.
      $ip: null
    };
    for (const [k, v] of Object.entries(props)) {
      if (allowed.has(k) && typeof v === 'string') properties[k] = v;
    }
    try {
      this.client.capture({ distinctId: this.distinctId, event, properties });
    } catch (e) {
      console.error('[analytics] capture failed:', e);
    }
  }

  /** One human-sent message. NOT deduped — unlike trackFeature this IS a usage
   *  meter, and the count is the whole point. Re-checks the enum at runtime
   *  because the `terminal`/`composer` surfaces originate in the renderer. */
  trackMessageSent(surface: MessageSurface): void {
    if (!(MESSAGE_SURFACES as readonly string[]).includes(surface)) return;
    this.track('message_sent', { surface });
  }

  /** feature_used with per-session dedup (adoption signal, not a usage meter). */
  trackFeature(feature: AnalyticsFeature): void {
    if (this.featuresSeen.has(feature)) return;
    this.featuresSeen.add(feature);
    this.track('feature_used', { feature });
  }

  /** Fire session_ended and flush. Bounded by the caller (will-quit races this
   *  against a timeout) — never assume it completes. Idempotent. */
  async endSession(): Promise<void> {
    if (!this.client || this.sessionEnded) return;
    this.track('session_ended', { duration_bucket: durationBucket(Date.now() - this.startedAt) });
    this.sessionEnded = true;
    try {
      await this.client.shutdown();
    } catch (e) {
      console.error('[analytics] shutdown flush failed:', e);
    }
    this.client = null;
  }

  private loadOrMintInstallId(stateDir: string): string {
    const file = join(stateDir, 'telemetry-install-id');
    try {
      if (existsSync(file)) {
        const id = readFileSync(file, 'utf8').trim();
        if (id) {
          this.idPersisted = true;
          return id;
        }
      }
      const id = randomUUID();
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(file, id + '\n', 'utf8');
      this.firstRun = true;
      this.idPersisted = true;
      return id;
    } catch (e) {
      // Unwritable state dir: use an ephemeral id for this session rather than
      // failing closed on analytics (still anonymous, just not stable).
      console.error('[analytics] install-id persist failed (ephemeral id):', e);
      return randomUUID();
    }
  }
}

/** The version this install last ran, kept beside the install id in userData.
 *  Deleting the app's data dir clears it exactly like the install id. */
const VERSION_STAMP_FILE = 'telemetry-last-version';

/** Semver-shaped and nothing else. The stamp is an ordinary file in userData
 *  that a user can edit, so it is re-validated on the way out — that keeps
 *  `from_version` provably closed-form and honours TELEMETRY.md's "nothing
 *  free-form" promise even against a hand-edited state dir. */
const VERSION_RE = /^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}(?:-[0-9A-Za-z.]{1,32})?$/;

/** A type alias, NOT an interface: `track()` takes `Record<string, string>` and
 *  TypeScript only gives object *type aliases* an implicit index signature. */
export type VersionTransition = {
  from_version: string;
  to_version: string;
};

/** The single place that decides whether a boot is a version change.
 *
 *  - `firstRun` (the install id was just minted) → a brand-new install, never
 *    an update. This is what keeps update_applied and first_run disjoint.
 *  - no stamp on an install that already had an id → the install predates
 *    version stamping, so it arrived here from SOME earlier version:
 *    `from_version: 'unknown'`. This is what makes the very first release
 *    carrying the event measurable, instead of silent for one whole cycle.
 *  - stamp !== current → a version change (a downgrade reports honestly, with
 *    from > to).
 *  - stamp === current → an ordinary relaunch. Nothing.
 *
 *  Pure and exported so the decision can be unit-tested without PostHog. */
export function updateTransition(
  previous: string | null,
  current: string,
  firstRun: boolean
): VersionTransition | null {
  if (firstRun) return null;
  if (!VERSION_RE.test(current)) return null; // can't name where we landed
  if (previous === current) return null;
  return {
    from_version: previous && VERSION_RE.test(previous) ? previous : 'unknown',
    to_version: current
  };
}

/** Raw stamp, or null when absent/unreadable. Never throws. */
export function readVersionStamp(stateDir: string): string | null {
  try {
    const file = join(stateDir, VERSION_STAMP_FILE);
    if (!existsSync(file)) return null;
    return readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Best-effort. A failed stamp just means the transition may be reported again
 *  next boot; it must never take the app down. */
export function writeVersionStamp(stateDir: string, version: string): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, VERSION_STAMP_FILE), version + '\n', 'utf8');
  } catch (e) {
    console.error('[analytics] version stamp persist failed:', e);
  }
}

/** ── Was it OUR updater, or did the user reinstall by hand? ──────────────────
 *
 *  `update_applied` on its own says the version moved; it cannot say what moved
 *  it, because an auto-update and a manual re-download both keep userData, keep
 *  the install id, and advance the version. The obvious fix is a marker written
 *  by the OLD process when the user clicks restart-to-install — but the old
 *  process is a build already in the wild, so a marker added now would be
 *  useless for exactly the release we need to watch and would only start
 *  telling the truth one cycle later.
 *
 *  It turns out we do not need a new marker: `updater.ts` has appended one to
 *  `updater.log` since v0.3.7, and both lines below are byte-identical in the
 *  shipped v0.4.3 and v0.4.4 builds. An auto-update leaves this ordered pair:
 *
 *      update downloaded: <version> — waiting for the user to restart
 *      quitAndInstall requested by the user
 *
 *  Matching on the version is what makes it trustworthy: a leftover pair from a
 *  PREVIOUS upgrade names that older version, so it cannot be mistaken for this
 *  one. The pair is necessary but not sufficient, because `quitAndInstall()`
 *  can return without installing anything — so a launch that names a different
 *  version after the request, or a refused quit warning, takes it back to
 *  `manual`. That correction matters more from 0.4.5 on than it did before it:
 *  the title-bar badge is now the MANUAL download, so the user whose automatic
 *  install quietly did nothing is exactly the user who then reaches for manual,
 *  and crediting that install to `auto` would flatter the path that failed.
 *  The log is read only to derive the closed enum below — no line, path or
 *  message from it is ever sent, and updater.ts is not modified to support this
 *  (`test/update-applied.test.cjs` asserts the two literals still match, so a
 *  future reword fails the suite instead of silently degrading the metric).
 */
const LOG_FILE = 'updater.log';
const LOG_DOWNLOADED = 'update downloaded: ';
const LOG_QUIT_REQUESTED = 'quitAndInstall requested by the user';
const LOG_QUIT_FAILED = 'quitAndInstall failed:';
/** Written once per packaged launch, naming the version that launched — in
 *  v0.4.3 and v0.4.4 as shipped, so it is readable for the 0.4.5 hop. */
const LOG_READY = /native updater ready \(current v([^)\s]+)\)/;
/** Only in 0.4.5 and later, so it starts paying off for the 0.4.6 hop. */
const LOG_QUIT_CANCELLED = 'quitAndInstall cancelled by the user at the quit warning';
/** The log grows by a line or two per update, never on a routine check, so this
 *  is years of history — but it is a user-writable file, so the read is bounded
 *  rather than trusting. */
const LOG_TAIL_BYTES = 128 * 1024;

/** `auto` our updater installed it, `manual` something else moved the version,
 *  `unknown` there is no log to read (and therefore no evidence either way). */
export type UpdateVia = 'auto' | 'manual' | 'unknown';

/** Pure: the whole decision, given the log text and where we landed. */
export function updateVia(logText: string | null, toVersion: string): UpdateVia {
  if (logText === null) return 'unknown';
  const lines = logText.split('\n');
  // The lookahead excludes every character a version can CONTINUE with, so
  // `0.4.5` matches neither `0.4.55` nor the prerelease `0.4.5-beta.1` — both
  // are different builds, and a download of one is no evidence about the other.
  const downloaded = new RegExp(
    `${LOG_DOWNLOADED}${toVersion.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}(?![0-9.\\-])`
  );

  // The LAST download of THIS version — anything earlier belongs to a previous
  // upgrade and would name a different version anyway.
  let i = -1;
  for (let n = 0; n < lines.length; n++) if (downloaded.test(lines[n])) i = n;
  if (i < 0) return 'manual';

  // A restart request that came AFTER that download. The log is append-only, so
  // file order is time order.
  let j = -1;
  for (let n = i + 1; n < lines.length; n++) if (lines[n].includes(LOG_QUIT_REQUESTED)) j = n;
  if (j < 0) return 'manual';

  // updater.ts logs the failure from the catch immediately after the request, so
  // an attempt that threw is the very next line — the app never quit, and
  // whatever moved the version afterwards was not us.
  if (lines[j + 1]?.includes(LOG_QUIT_FAILED)) return 'manual';

  // A request that threw is the easy case. The one that matters is the request
  // that returned cleanly and still did not install: `quitAndInstall()` reports
  // no outcome (updater.ts says so in its own header), so a silent no-op and a
  // successful install are the same line. The log tells them apart anyway,
  // because the app that runs NEXT identifies itself:
  //
  //  - a launch naming any version other than the one we landed on means a
  //    build that is not the target ran after the restart was asked for, so
  //    that restart did not install this version;
  //  - the user refusing the quit warning says the same thing outright.
  //
  // Both are disproof only. Their absence is not evidence of success, so this
  // still cannot see an install that failed with nothing running afterwards.
  for (let n = j + 1; n < lines.length; n++) {
    if (lines[n].includes(LOG_QUIT_CANCELLED)) return 'manual';
    const launched = LOG_READY.exec(lines[n]);
    if (launched && launched[1] !== toVersion) return 'manual';
  }
  return 'auto';
}

/** Last LOG_TAIL_BYTES of updater.log, or null when there is none to read.
 *  Never throws — a missing log is an answer ('unknown'), not a failure. */
export function readUpdaterLogTail(stateDir: string): string | null {
  let fd: number | null = null;
  try {
    const file = join(stateDir, LOG_FILE);
    if (!existsSync(file)) return null;
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    if (size === 0) return null;
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buf = Buffer.allocUnsafe(length);
    readSync(fd, buf, 0, length, size - length);
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* nothing left to do */ } }
  }
}

/** Coarse, non-identifying session-length label. */
function durationBucket(ms: number): string {
  const m = ms / 60_000;
  if (m < 5) return '<5m';
  if (m < 30) return '5-30m';
  if (m < 120) return '30m-2h';
  if (m < 480) return '2-8h';
  return '8h+';
}

/** The process-wide singleton, mirroring how index.ts owns other services. */
export const analytics = new Analytics();
