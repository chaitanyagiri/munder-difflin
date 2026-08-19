# Web UI — the office in a browser

Run Munder Difflin on one machine (an old laptop, a home server, a desktop that never sleeps)
and open **the exact same interface** from any other device's browser — no RDP, no VNC.

The desktop app stays the product; the web UI is a bridge to it. It serves the **built
renderer bundle** and the **built preload bundle** byte-for-byte to the browser and proxies
the whole IPC surface back to the running main process, so there is no second UI to
maintain and nothing to drift: whatever the desktop window can do, the browser can do
(minus the native bits listed under [Limitations](#limitations)).

```
your phone / other laptop              the server (old laptop)
┌───────────────────────┐   HTTP    ┌───────────────────────────────┐
│ browser               │◄─────────►│ Munder Difflin (Electron)     │
│  window.cth (the REAL │  fetch    │  ┌─ WebUiServer (webui.ts)    │
│  preload bundle, over │  + SSE    │  │   invoke → same ipcMain    │
│  a fetch/SSE shim)    │           │  │   events ← webContents.send│
└───────────────────────┘           │  └─ agents, PTYs, hive, …     │
                                    └───────────────────────────────┘
```

## Enable it

Off by default. Two ways to turn it on:

**Config** — in `config.json` (the app's `userData` dir, e.g.
`~/.config/munder-difflin/config.json` on Linux):

```json
{
  "webUi": { "enabled": true, "port": 4820, "host": "0.0.0.0" }
}
```

**Environment** — handy for a server service unit; env wins over config:

```bash
MD_WEBUI=1                      # force on (MD_WEBUI=0 forces off)
MD_WEBUI_PORT=4820              # default 4820
MD_WEBUI_HOST=0.0.0.0           # default 0.0.0.0; 127.0.0.1 = local-only
MD_WEBUI_TOKEN=<secret>         # optional; auto-generated when needed

# e.g. from a source checkout:
npm run build && MD_WEBUI=1 npm run preview
# or with a packaged install:
MD_WEBUI=1 munder-difflin
```

On startup the main process logs the URL to open:

```
[webui] serving the office at http://<this-machine>:4820/?token=a1b2c3…
```

Open that URL once per browser — the token is exchanged for a cookie and stripped from the
address bar. All later visits to `http://<server>:4820/` just work.

> The web UI serves the **built** app. Run `npm run build` first (packaged installs are
> already built). `npm run dev` serves the renderer from Vite's dev server, which the
> bridge intentionally does not proxy.

## Auth

- Binding to anything other than loopback **requires a token**. If you enable the web UI
  without setting one, a random token is generated and persisted to `webUi.token` in
  `config.json`, and included in the logged URL.
- Requests authenticate via the `?token=` query (first visit), an HttpOnly cookie
  (set automatically), or an `Authorization: Bearer <token>` header (for scripting).
- The token check is constant-time. `/__webui/health` is the only unauthenticated route
  (it reveals the app name and version, nothing else).
- The transport is plain HTTP. On a trusted LAN that is usually fine; across the internet
  put it behind a reverse proxy with TLS (Caddy, nginx, Tailscale Serve) — bind the web UI
  to `127.0.0.1` in that setup and let the proxy own the network edge.

## Headless servers

Electron still needs a display to boot its (hidden-behind-the-web) window — the window is
also what keeps event streams flowing. On a server with no desktop session, run under Xvfb:

```bash
xvfb-run -a munder-difflin            # packaged install
xvfb-run -a env MD_WEBUI=1 npm run preview   # source checkout, after npm run build
```

A window manager is not needed. Closing the app window ends the web UI too (they are the
same process).

## How it works

- `src/main/webui.ts` — the whole server. At boot, `installIpcCapture` wraps
  `ipcMain.handle`/`ipcMain.on` and records every channel → handler pair, so a bridged
  browser call runs the **exact same handler** the desktop renderer would.
  `wrapWebContentsSend` (installed via `app.on('web-contents-created')`) mirrors every
  `webContents.send` to connected browsers over one Server-Sent-Events stream.
- `src/main/webui-client/boot.js` — a browser stand-in for the preload's `electron`
  imports: `ipcRenderer.invoke` → `POST /__webui/invoke`, `ipcRenderer.on` ← SSE,
  `ipcRenderer.sendSync` → one synchronous XHR (used exactly twice, both with fallbacks).
  Then the **real** `out/preload/index.js` runs unmodified and exposes `window.cth`,
  and `cleanup.js` removes the CommonJS shim globals.
- Binary payloads (`fs:readBinary`) cross the JSON wire as base64-tagged markers and
  arrive as `Uint8Array`, same as over Electron IPC.

## Limitations

- **Native file/folder pickers** (`Choose folder`, attach-file dialogs) can't open on a
  device the server can't draw on — those channels return a friendly error instead of
  hanging; type paths manually (they are server-side paths, which is what you want).
- **Drag-and-drop attachments** rely on Electron's `webUtils.getPathForFile`, which
  browsers cannot provide — attach by path instead.
- **Clipboard** buttons use the *browser's* clipboard (the server's clipboard would be
  useless remotely); reading may prompt for permission depending on the browser.
- Events reflect what the app window streams: if the (possibly virtual) window is closed,
  the stream stops. Keep the window open (or Xvfb running).
- One office, many viewers: several browsers can connect; they all watch and drive the
  same floor.
