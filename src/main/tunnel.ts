/**
 * Public-tunnel provider — the one place the app turns a loopback port into a URL an
 * outside service (Slack, a webhook caller) can reach.
 *
 * WHY THIS EXISTS. `SlackWebhookServer` and `WebhookServer` each had their own private
 * `openTunnel()` calling `tunnelmole`, and both carried the same admission in a comment:
 * *"tunnelmole has no documented close handle; teardown is best-effort."* Stopping the
 * bridge closed our HTTP server but left the tunnel process running, so the public URL
 * outlived the thing it pointed at until the app quit. This module fixes that by making
 * the tunnel a HANDLE with a real `close()`, and by defaulting to a provider we can
 * actually kill: a `cloudflared` quick tunnel, which is an ordinary child process.
 *
 * Providers:
 *   - 'cloudflared' — `cloudflared tunnel --url http://127.0.0.1:<port>` prints a
 *     `https://<sub>.trycloudflare.com` URL on stderr. No account, no config, no login.
 *     `close()` kills the child through the same `ensureKilled` ladder the PTYs use.
 *   - 'tunnelmole'  — the previous behaviour, unchanged, as the fallback for a machine
 *     with no `cloudflared`. Its `close()` is a documented no-op.
 *   - 'auto'        — cloudflared when the binary resolves, else tunnelmole.
 *
 * Deliberately free of any `electron` import, and the process-level dependencies
 * (binary resolution, spawn) are injectable, so the URL parsing and provider selection
 * are unit-testable without a network or a real tunnel — the same posture as
 * `integrationBroker.ts`.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { resolveCommand } from './shellEnv';
import { ensureKilled } from './procKill';

export type TunnelProviderId = 'auto' | 'cloudflared' | 'tunnelmole';

export interface TunnelHandle {
  /** The public https URL forwarding to the local port. */
  url: string;
  /** Which provider actually produced it (never 'auto'). */
  provider: Exclude<TunnelProviderId, 'auto'>;
  /** Tear the tunnel down. Idempotent; never throws. A no-op for tunnelmole, which
   *  exposes no handle — callers should still always call it. */
  close(): void;
}

/** How long to wait for a provider to hand back a URL before giving up. */
export const TUNNEL_START_TIMEOUT_MS = 10_000;

/** The quick-tunnel hostname cloudflared prints. Anchored to the real domain so a
 *  hostile-looking line in the log can't be mistaken for the tunnel URL. */
const QUICK_TUNNEL_RE = /https:\/\/[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*\.trycloudflare\.com/i;

/**
 * Pull the quick-tunnel URL out of a chunk of cloudflared output. It arrives inside a
 * box-drawn banner, padded with spaces and a trailing `|`, and split across lines that
 * may not align with stream chunks — so match on the accumulated buffer, not per line.
 * Returns null when the buffer doesn't (yet) contain a URL.
 */
export function extractQuickTunnelUrl(buffer: string): string | null {
  const m = QUICK_TUNNEL_RE.exec(buffer);
  return m ? m[0] : null;
}

export interface TunnelDeps {
  /** Absolute path for a binary name, or '' when it isn't installed. Injected for tests. */
  resolve?: (cmd: string) => string;
  /** Child spawner. Injected for tests. */
  spawn?: typeof nodeSpawn;
  /** Process killer. Injected for tests so a fake child's pid is never signalled for
   *  real — an arbitrary test pid could belong to something else on the machine. */
  kill?: (pid: number | undefined) => void;
}

/** Is a cloudflared binary present on this machine? */
export function cloudflaredAvailable(deps: TunnelDeps = {}): boolean {
  const resolve = deps.resolve ?? resolveCommand;
  try { return !!resolve('cloudflared'); } catch { return false; }
}

/** Which provider `openTunnel` will actually use for the requested setting. */
export function selectProvider(
  requested: TunnelProviderId = 'auto',
  deps: TunnelDeps = {}
): Exclude<TunnelProviderId, 'auto'> {
  if (requested === 'cloudflared' || requested === 'tunnelmole') return requested;
  return cloudflaredAvailable(deps) ? 'cloudflared' : 'tunnelmole';
}

/**
 * Open a public tunnel to `port`. Rejects (never hangs) when the provider fails, exits,
 * or produces no URL inside the timeout — the caller decides whether that is fatal.
 *
 * An explicit `provider: 'cloudflared'` is honoured even when the binary doesn't
 * resolve, so a misconfiguration surfaces as a clear error instead of silently falling
 * back to the provider the user turned off.
 */
export async function openTunnel(
  port: number,
  opts: { provider?: TunnelProviderId; timeoutMs?: number; deps?: TunnelDeps } = {}
): Promise<TunnelHandle> {
  const timeoutMs = opts.timeoutMs ?? TUNNEL_START_TIMEOUT_MS;
  const provider = selectProvider(opts.provider ?? 'auto', opts.deps);
  return provider === 'cloudflared'
    ? openCloudflaredTunnel(port, timeoutMs, opts.deps ?? {})
    : openTunnelmoleTunnel(port, timeoutMs);
}

function openCloudflaredTunnel(
  port: number,
  timeoutMs: number,
  deps: TunnelDeps
): Promise<TunnelHandle> {
  const resolve = deps.resolve ?? resolveCommand;
  const spawn = deps.spawn ?? nodeSpawn;
  return new Promise<TunnelHandle>((resolveP, reject) => {
    const bin = resolve('cloudflared') || 'cloudflared';
    let child: ChildProcess;
    try {
      child = spawn(
        bin,
        // 127.0.0.1, never localhost: the servers bind IPv4 loopback and a
        // localhost→::1 resolution would forward into a closed port.
        ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } catch (e) {
      reject(new Error(`cloudflared failed to start: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }

    let settled = false;
    // Keep only the tail: the banner is early, and an unbounded buffer would grow for
    // the whole life of a long-running tunnel.
    let buf = '';
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeAllListeners('data');
      child.stderr?.removeAllListeners('data');
      child.removeAllListeners('exit');
      child.removeAllListeners('error');
      fn();
    };
    const killer = deps.kill ?? ((pid?: number) => ensureKilled(pid));
    // One-shot: `stop()` is idempotent and callers may retry it, and after the first
    // kill the pid can have been recycled by the OS — signalling it twice would be
    // signalling somebody else's process.
    let killed = false;
    const kill = (): void => {
      if (killed) return;
      killed = true;
      try { killer(child.pid ?? undefined); } catch { /* noop */ }
    };

    const timer = setTimeout(() => {
      done(() => { kill(); reject(new Error(`cloudflared timed out after ${timeoutMs}ms`)); });
    }, timeoutMs);

    const onChunk = (c: Buffer | string): void => {
      buf = (buf + String(c)).slice(-8192);
      const url = extractQuickTunnelUrl(buf);
      if (!url) return;
      done(() => resolveP({
        url,
        provider: 'cloudflared',
        // The whole point of this module: a tunnel you can actually take down.
        close: () => kill()
      }));
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk); // cloudflared logs the banner to stderr
    child.on('error', (e) => done(() => reject(new Error(`cloudflared failed: ${e.message}`))));
    child.on('exit', (code) => done(() => reject(
      new Error(`cloudflared exited (${code ?? 'signal'}) before printing a URL${buf ? `: ${buf.trim().slice(-300)}` : ''}`)
    )));
  });
}

function openTunnelmoleTunnel(port: number, timeoutMs: number): Promise<TunnelHandle> {
  return new Promise<TunnelHandle>((resolveP, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
    // `tunnelmole` is ESM-only and the main process is bundled as CJS, so a static
    // import would be externalized into require() and throw ERR_REQUIRE_ESM at load.
    // Rollup preserves dynamic import() in CJS output, which can load ESM. Do not
    // hoist this to a top-level import.
    import('tunnelmole')
      .then(({ tunnelmole }) => tunnelmole({ port }))
      .then((url: string) => {
        clearTimeout(timer);
        if (!url) { reject(new Error('tunnelmole returned empty URL')); return; }
        resolveP({
          url,
          provider: 'tunnelmole',
          // tunnelmole exposes no close handle — documented, and the reason
          // cloudflared is preferred whenever it is installed.
          close: () => { /* no-op: tunnelmole has no teardown API */ }
        });
      })
      .catch((e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
  });
}
