/*
 * Web UI browser boot (classic script, runs before the preload bundle).
 *
 * The web UI serves the REAL built preload (out/preload/index.js, a CJS
 * bundle) straight into the browser, so `window.cth` never drifts from the
 * desktop app. That bundle expects a CommonJS environment and the 'electron'
 * module; this script supplies both:
 *
 *   - `window.require('electron')` → a browser stand-in where
 *       ipcRenderer.invoke   = POST /__webui/invoke   (fetch)
 *       ipcRenderer.on       = SSE  /__webui/events   (EventSource, auto-reconnect)
 *       ipcRenderer.sendSync = sync XHR /__webui/sendSync (used twice, both
 *                              wrapped in try/catch fallbacks by preload)
 *       contextBridge.exposeInMainWorld(k, v) = `window[k] = v`
 *   - `window.module` / `window.exports` for the bundle's CJS prologue.
 *
 * cleanup.js deletes the shim globals right after the preload runs, so the
 * renderer bundle never sees a fake `require` (AMD/UMD sniffers, Monaco).
 *
 * Binary values cross the JSON wire as { $mdWebUiBytes: base64 } markers —
 * mirror of encodeWire/decodeWire in src/main/webui.ts.
 */
(function () {
  'use strict';
  var BYTES_TAG = '$mdWebUiBytes';

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function encodeWire(v) {
    if (v === null || typeof v !== 'object') return v;
    if (v instanceof Uint8Array) { var o = {}; o[BYTES_TAG] = bytesToB64(v); return o; }
    if (v instanceof ArrayBuffer) { var o2 = {}; o2[BYTES_TAG] = bytesToB64(new Uint8Array(v)); return o2; }
    if (Array.isArray(v)) return v.map(encodeWire);
    var out = {};
    for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k) && v[k] !== undefined) out[k] = encodeWire(v[k]);
    return out;
  }
  function decodeWire(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(decodeWire);
    if (typeof v[BYTES_TAG] === 'string' && Object.keys(v).length === 1) return b64ToBytes(v[BYTES_TAG]);
    var out = {};
    for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = decodeWire(v[k]);
    return out;
  }

  // channel → Set of preload listeners; fed by the SSE stream below.
  var listeners = new Map();
  var es = new EventSource('/__webui/events');
  es.onmessage = function (msg) {
    var evt;
    try { evt = JSON.parse(msg.data); } catch (e) { return; }
    var set = listeners.get(evt.channel);
    if (!set) return;
    var args = (evt.args || []).map(decodeWire);
    set.forEach(function (fn) {
      try { fn.apply(null, [{ sender: null, senderId: 0, ports: [] }].concat(args)); }
      catch (e) { console.error('[webui] listener for', evt.channel, 'threw', e); }
    });
  };

  function invoke(channel, args) {
    return fetch('/__webui/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: channel, args: encodeWire(args) })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) throw new Error(j.error || 'invoke failed: ' + channel);
      return decodeWire(j.value);
    });
  }

  var ipcRenderer = {
    invoke: function (channel) {
      var args = Array.prototype.slice.call(arguments, 1);
      // Clipboard IPC targets the SERVER's clipboard, which is useless from a
      // browser on another device — route to the browser's own clipboard, with
      // the server as a fallback for readClipboard when permission is denied.
      if (channel === 'app:copyToClipboard' && navigator.clipboard) {
        return navigator.clipboard.writeText(String(args[0] == null ? '' : args[0]))
          .then(function () { return { ok: true }; })
          .catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
      }
      if (channel === 'app:readClipboard' && navigator.clipboard && navigator.clipboard.readText) {
        return navigator.clipboard.readText().catch(function () { return invoke(channel, args); });
      }
      return invoke(channel, args);
    },
    on: function (channel, fn) {
      var set = listeners.get(channel);
      if (!set) { set = new Set(); listeners.set(channel, set); }
      set.add(fn);
      return ipcRenderer;
    },
    removeListener: function (channel, fn) {
      var set = listeners.get(channel);
      if (set) set.delete(fn);
      return ipcRenderer;
    },
    removeAllListeners: function (channel) {
      listeners.delete(channel);
      return ipcRenderer;
    },
    send: function (channel) {
      // Fire-and-forget: none of the preload API uses plain send today, but
      // keep the surface complete so a future preload addition degrades sanely.
      invoke(channel, Array.prototype.slice.call(arguments, 1)).catch(function () {});
    },
    sendSync: function (channel) {
      var args = Array.prototype.slice.call(arguments, 1);
      // Synchronous XHR: intentionally so. Both sendSync channels are one-shot,
      // tiny, and already try/catch-wrapped in preload (clipboard paste, roster
      // boot read) — an async imitation would break their contract instead.
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/__webui/sendSync', false);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify({ channel: channel, args: encodeWire(args) }));
      if (xhr.status !== 200) throw new Error('sendSync failed: ' + channel);
      var j = JSON.parse(xhr.responseText);
      if (!j.ok) throw new Error(j.error || 'sendSync failed: ' + channel);
      return decodeWire(j.value);
    }
  };

  var electronShim = {
    contextBridge: {
      exposeInMainWorld: function (key, api) { window[key] = api; }
    },
    ipcRenderer: ipcRenderer,
    webUtils: {
      // Browsers never expose real filesystem paths for dropped files. Preload's
      // pathForFile returns '' here and attachment-by-path degrades gracefully.
      getPathForFile: function () { return ''; }
    }
  };

  // CJS environment for the preload bundle (removed again by cleanup.js).
  window.module = { exports: {} };
  window.exports = window.module.exports;
  window.require = function (name) {
    if (name === 'electron') return electronShim;
    throw new Error('[webui] module not available in the browser: ' + name);
  };
})();
