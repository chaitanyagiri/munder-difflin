"use strict";
/* web-office v2 — window.cth shim
 *
 * The real Munder Difflin renderer (React + PixiJS) talks to Electron ONLY
 * through `window.cth` (exposed by preload/index.js via contextBridge). This
 * shim substitutes that bridge in a plain browser: every data method becomes a
 * fetch() to our local /api/state (which reads the live hive files), and every
 * interactive/Electron-only method is a safe no-op. The office floor scene
 * (agents, thought bubbles, board wall, status colors) then renders for real.
 */
(function () {
  var CTH_VERSION = "0.4.6";
  var POLL_MS = 4000;
  var stateCache = null;
  var stateTs = 0;
  var subs = {}; // channel -> [cb]
  var CAST = ["michael","jim","pam","dwight","kevin","angela","oscar","stanley","phyllis","andy","kelly","ryan","toby","creed","meredith"];
  var ACCENTS = ["coral","mint","sky","lemon","lilac","peach"];

  function hashStr(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h;
  }
  function characterFor(a) {
    if (a.isGod) return "michael";
    var n = ((a.name || a.id) || "").toLowerCase();
    for (var i = 0; i < CAST.length; i++) {
      if (n.indexOf(CAST[i]) !== -1) return CAST[i];
    }
    return CAST[hashStr(a.id || "x") % CAST.length];
  }
  function liveStatus(a) {
    var b = a.breaker || "healthy";
    if (b === "constrained" || b === "stopped") return "looping";
    if (a.onHold) return "waiting";
    if (typeof a.lastActiveSecAgo === "number" && a.lastActiveSecAgo < 60) return "working";
    return "idle";
  }
  function rosterFrom(s) {
    var dir = (s && s.agentDirectory) || { agents: [] };
    var list = Array.isArray(dir.agents) ? dir.agents : [];
    var agents = list.map(function (a) {
      return {
        id: a.id,
        name: a.name || a.id,
        character: characterFor(a),
        accent: ACCENTS[hashStr(a.id || "x") % ACCENTS.length],
        description: a.role || "a fresh harness",
        project: ((a.cwd || "").split(/[\\/]/).filter(Boolean).pop()) || "hive",
        tmuxTarget: "",
        cwd: a.cwd || null,
        status: liveStatus(a),
        action: "idle",
        progress: 0,
        currentStation: "desk",
        ptyId: a.id,
        command: null,
        provider: a.provider || "claude",
        isGod: !!a.isGod,
        recentTextTs: Date.now()
      };
    });
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      agents: agents,
      archived: [],
      restorable: [],
      queues: {},
      selectedId: null
    };
  }
  // Sync one-time fetch at shim load so the bundle's synchronous boot reads
  // (rosterReadSync / harnessHomeSync) get real live-hive data.
  function bootStateSync() {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("GET", "/api/state", false);
      xhr.send(null);
      if (xhr.status === 200) return JSON.parse(xhr.responseText);
    } catch (_e) {}
    return null;
  }
  var BOOT = bootStateSync();

  function getState(force) {
    if (force || !stateCache || Date.now() - stateTs > 1500) {
      return fetch("/api/state", { cache: "no-store" })
        .then(function (r) {
          if (!r.ok) throw new Error("state " + r.status);
          return r.json();
        })
        .then(function (s) {
          stateCache = s;
          stateTs = Date.now();
          return s;
        });
    }
    return Promise.resolve(stateCache);
  }

  function data() {
    return getState(false).catch(function () {
      return {};
    });
  }

  /* ── subscription plumbing ───────────────────────────── */
  function sub(channel, cb) {
    if (!subs[channel]) subs[channel] = [];
    subs[channel].push(cb);
    return function () {
      var i = (subs[channel] || []).indexOf(cb);
      if (i >= 0) subs[channel].splice(i, 1);
    };
  }
  function emit(channel, payload) {
    (subs[channel] || []).forEach(function (cb) {
      try {
        cb(payload);
      } catch (_e) {}
    });
  }
  function pulse(s) {
    // Re-fire subscribers on each poll with fresh shapes the UI expects.
    emit("hive:hookEvent", { event: "state", ts: Date.now(), state: s });
    emit("hive:contextUpdate", { ts: Date.now() });
    emit("telemetry:event", { ts: Date.now() });
    emit("config:changed", s.config || {});
    // Per-agent live status → drives the floor's status colors + bubbles.
    var dir = (s.agentDirectory && s.agentDirectory.agents) || [];
    for (var i = 0; i < dir.length; i++) {
      var a = dir[i];
      var st = liveStatus(a);
      var base = { ts: Date.now(), agentId: a.id };
      if (st === "looping") {
        emit("control:breakerState", { agentId: a.id, level: "constrained", reason: "breaker armed" });
      } else if (st === "working") {
        emit("hive:hookEvent", Object.assign({ event: "PreInvocation" }, base));
      } else if (st === "compacting") {
        emit("hive:hookEvent", Object.assign({ event: "PreCompact" }, base));
      } else {
        emit("hive:hookEvent", Object.assign({ event: "PostInvocation" }, base));
      }
    }
  }

  /* ── data methods (backed by /api/state) ──────────────── */
  var api = {
    version: CTH_VERSION,
    platform: "darwin",
    arch: "arm64",

    hiveRegistry: function () {
      return data().then(function (s) {
        return s.registry || { godId: null, agents: {} };
      });
    },
    hiveBoard: function () {
      return data().then(function (s) {
        return s.board || "";
      });
    },
    hiveTasks: function () {
      return data().then(function (s) {
        return s.tasks || { tasks: [] };
      });
    },
    hiveLog: function (n) {
      return data().then(function (s) {
        var log = s.logTail || [];
        return typeof n === "number" ? log.slice(-n) : log;
      });
    },
    hiveMemory: function (id) {
      return data().then(function (s) {
        return (s.memories && s.memories[id]) || "";
      });
    },
    hiveInbox: function (id) {
      return data().then(function (s) {
        return (s.inboxes && s.inboxes[id]) || [];
      });
    },
    hiveMessages: function (opts) {
      return data().then(function (s) {
        return s.messages || [];
      });
    },
    hiveAgentDirectory: function () {
      return data().then(function (s) {
        return (
          s.agentDirectory || { godId: null, agents: [] }
        );
      });
    },
    telemetrySnapshot: function () {
      return data().then(function (s) {
        return s.telemetry || { usage: [], spans: {} };
      });
    },
    hiveProjects: function () {
      return data().then(function (s) {
        return (s && s.projects) || [];
      });
    },
    telemetryUsage: function (agentId) {
      return data().then(function (s) {
        var u = (s.telemetry && s.telemetry.usage) || [];
        var hit = u.find(function (x) {
          return x.agentId === agentId;
        });
        return hit || null;
      });
    },
    telemetrySpans: function (agentId) {
      return data().then(function (s) {
        return (s.telemetry && s.telemetry.spans && s.telemetry.spans[agentId]) || [];
      });
    },
    getConfig: function () {
      return data().then(function (s) {
        return s.config || {};
      });
    },
    agentUsage: function () {
      return data().then(function (s) {
        return (s.telemetry && s.telemetry.usage) || [];
      });
    },
    agentContext: function () {
      return Promise.resolve(null);
    },
    // synchronous boot-time reads — backed by the sync boot fetch, so the
    // store hydrates its roster from the LIVE hive instead of empty localStorage
    rosterReadSync: function () {
      return rosterFrom(BOOT);
    },
    harnessHomeSync: function () {
      return (BOOT && BOOT.config && BOOT.config.harnessHome) || null;
    },

    /* ── subscription methods (poll-driven) ─────────────── */
    onHiveHookEvent: function (cb) {
      return sub("hive:hookEvent", cb);
    },
    onHiveContextUpdate: function (cb) {
      return sub("hive:contextUpdate", cb);
    },
    onHiveMessage: function (cb) {
      return sub("hive:message", cb);
    },
    onHiveEnqueue: function (cb) {
      return sub("hive:enqueueToAgent", cb);
    },
    onHiveAgentSpawned: function (cb) {
      return sub("hive:agentSpawned", cb);
    },
    onHiveAgentArchived: function (cb) {
      return sub("hive:agentArchived", cb);
    },
    onBreakerState: function (cb) {
      return sub("control:breakerState", cb);
    },
    onTelemetryEvent: function (cb) {
      return sub("telemetry:event", cb);
    },
    onUpdateStatus: function (cb) {
      return sub("update:status", cb);
    },
    onConfigChanged: function (cb) {
      return sub("config:changed", cb);
    },
    onPtyData: function (_id, cb) {
      return sub("pty:data", cb);
    },
    onPtyExit: function (_id, cb) {
      return sub("pty:exit", cb);
    },
    onPtyRelaunch: function (_id, cb) {
      return sub("pty:relaunch", cb);
    },
    onSlackMessage: function (cb) {
      return sub("slack:incomingMessage", cb);
    },
    onClosingTime: function (cb) {
      return sub("app:closingTime", cb);
    },
    onCloseRequested: function (cb) {
      return sub("app:closeRequested", cb);
    },
    onPowerResume: function (cb) {
      return sub("power:resume", cb);
    },
    onRealtimeCompletion: function (cb) {
      return sub("realtime:completion", cb);
    },
    onRealtimeFloorDelta: function (cb) {
      return sub("realtime:floorDelta", cb);
    },
    onRealtimeEnqueue: function (cb) {
      return sub("realtime:enqueue", cb);
    },
    onMissionsUpdated: function (cb) {
      return sub("missions:updated", cb);
    },
    onAutoCompact: function (cb) {
      return sub("mission:autoCompact", cb);
    },
    onApprovalRequest: function (cb) {
      return sub("control:approvalRequest", cb);
    },
    onTriggerHistoryUpdated: function (cb) {
      return sub("triggerHistory:updated", cb);
    },
    onHireImport: function (cb) {
      return sub("hire:import", cb);
    },
    onHireError: function (cb) {
      return sub("hire:error", cb);
    },
    onContextTrigger: function (cb) {
      return sub("trigger:context", cb);
    },

    /* ── interactive / Electron-only: safe no-ops ───────── */
    trackMessageSent: function () {
      return Promise.resolve();
    },
    spawnPty: function (opts) {
      // Read-only web view: no real PTY is spawned, but a "success" lets the
      // renderer's restore flow bring every live-hive agent onto the office floor.
      var id = (opts && opts.id) || "pty-mock";
      return Promise.resolve({ ok: true, ptyId: id, seedPrompt: undefined });
    },
    writePty: function () {
      return Promise.resolve();
    },
    resizePty: function () {
      return Promise.resolve();
    },
    redrawPty: function () {
      return Promise.resolve();
    },
    killPty: function () {
      return Promise.resolve();
    },
    listPtys: function () {
      return Promise.resolve([]);
    },
    resolveSessionCwd: function () {
      return Promise.resolve(null);
    },
    chooseFolder: function () {
      return Promise.resolve(null);
    },
    openTerminalAt: function () {
      return Promise.resolve({ ok: false });
    },
    copyToClipboard: function () {
      return Promise.resolve();
    },
    readClipboard: function () {
      return Promise.resolve("");
    },
    readClipboardSync: function () {
      return "";
    },
    updateConfig: function () {
      return Promise.resolve({});
    },
    setAgentTokenCap: function () {
      return Promise.resolve();
    },
    ensureHarnessHome: function () {
      return Promise.resolve({ ok: true });
    },
    changeHome: function () {
      return Promise.resolve({ ok: false, error: "read-only web view" });
    },
    listDir: function () {
      return Promise.resolve([]);
    },
    readFile: function () {
      return Promise.resolve("");
    },
    readBinary: function () {
      return Promise.resolve(null);
    },
    writeFile: function () {
      return Promise.resolve({ ok: false });
    },
    statAbs: function () {
      return Promise.resolve(null);
    },
    revealPath: function () {
      return Promise.resolve();
    },
    gitIsRepo: function () {
      return Promise.resolve(false);
    },
    gitMainRepo: function () {
      return Promise.resolve(null);
    },
    gitBranch: function () {
      return Promise.resolve(null);
    },
    gitStatus: function () {
      return Promise.resolve({});
    },
    gitLog: function () {
      return Promise.resolve([]);
    },
    gitBranches: function () {
      return Promise.resolve([]);
    },
    gitAheadBehind: function () {
      return Promise.resolve(null);
    },
    gitDiff: function () {
      return Promise.resolve("");
    },
    gitLogGraph: function () {
      return Promise.resolve([]);
    },
    gitCommitFiles: function () {
      return Promise.resolve([]);
    },
    gitShowFile: function () {
      return Promise.resolve("");
    },
    gitCompareRefs: function () {
      return Promise.resolve(null);
    },
    gitWorktrees: function () {
      return Promise.resolve([]);
    },
    gitCheckout: function () {
      return Promise.resolve({ ok: false });
    },
    hivePatchAgentRole: function () {
      return Promise.resolve({ ok: false });
    },
    hiveRenameAgent: function () {
      return Promise.resolve({ ok: false });
    },
    hiveSetAgentHold: function () {
      return Promise.resolve({ ok: false });
    },
    hiveAddTask: function () {
      return Promise.resolve(false);
    },
    hivePatchTask: function () {
      return Promise.resolve(false);
    },
    hiveDeleteTask: function () {
      return Promise.resolve(false);
    },
    hiveSend: function () {
      return Promise.resolve({ ok: false });
    },
    listWorkers: function () {
      return Promise.resolve([]);
    },
    stopWorker: function () {
      return Promise.resolve({ ok: false });
    },
    memoryStatus: function () {
      return Promise.resolve({ enabled: false });
    },
    toolsStatus: function () {
      return Promise.resolve([]);
    },
    heroPayload: function () {
      return Promise.resolve(null);
    },
    skillsLocal: function () {
      return Promise.resolve([]);
    },
    skillsCatalog: function () {
      return Promise.resolve([]);
    },
    skillsInstall: function () {
      return Promise.resolve({ ok: false });
    },
    skillsUninstall: function () {
      return Promise.resolve({ ok: false });
    },
    skillsReveal: function () {
      return Promise.resolve();
    },
    searchMemory: function () {
      return Promise.resolve([]);
    },
    memoryWakeUp: function () {
      return Promise.resolve("");
    },
    mineNow: function () {
      return Promise.resolve({});
    },
    reflectNow: function () {
      return Promise.resolve([]);
    },
    kgStatus: function () {
      return Promise.resolve({ enabled: false });
    },
    kgList: function () {
      return Promise.resolve([]);
    },
    kgSearch: function () {
      return Promise.resolve([]);
    },
    kgGet: function () {
      return Promise.resolve(null);
    },
    kgRemove: function () {
      return Promise.resolve({ ok: false });
    },
    kgAddFiles: function () {
      return Promise.resolve([]);
    },
    kgIngestFiles: function () {
      return Promise.resolve([]);
    },
    attachFiles: function () {
      return Promise.resolve([]);
    },
    pathForFile: function () {
      return null;
    },
    saveClipboardImage: function () {
      return Promise.resolve(null);
    },
    historyAdd: function () {
      return Promise.resolve();
    },
    historyList: function () {
      return Promise.resolve([]);
    },
    historySearch: function () {
      return Promise.resolve([]);
    },
    textSearch: function () {
      return Promise.resolve([]);
    },
    githubIssues: function () {
      return Promise.resolve({ ok: false, error: "read-only web view" });
    },
    githubCIRuns: function () {
      return Promise.resolve({ ok: false, error: "read-only web view" });
    },
    setNotifications: function () {
      return Promise.resolve(false);
    },
    openExternal: function () {
      return Promise.resolve();
    },
    setLoginItem: function () {
      return Promise.resolve(false);
    },
    hiveSetArchived: function () {
      return Promise.resolve({ ok: false });
    },
    slackStart: function () {
      return Promise.resolve({ ok: false });
    },
    slackStop: function () {
      return Promise.resolve({ ok: false });
    },
    slackStatus: function () {
      return Promise.resolve({ connected: false });
    },
    slackReply: function () {
      return Promise.resolve({ ok: false });
    },
    slackReplyScriptPath: function () {
      return Promise.resolve(null);
    },
    slackSetConfig: function () {
      return Promise.resolve({});
    },
    webhookStart: function () {
      return Promise.resolve({ ok: false });
    },
    webhookStop: function () {
      return Promise.resolve({ ok: false });
    },
    webhookStatus: function () {
      return Promise.resolve({ connected: false });
    },
    webhookGenerateSecret: function () {
      return Promise.resolve("");
    },
    webhookSetConfig: function () {
      return Promise.resolve({});
    },
    getContextTrigger: function () {
      return Promise.resolve({});
    },
    setContextTrigger: function () {
      return Promise.resolve({});
    },
    listWebhooks: function () {
      return Promise.resolve([]);
    },
    saveWebhooks: function () {
      return Promise.resolve([]);
    },
    deleteWebhook: function () {
      return Promise.resolve([]);
    },
    generateWebhookSecret: function () {
      return Promise.resolve("");
    },
    webhooksStatus: function () {
      return Promise.resolve({ endpoints: [] });
    },
    getOrgTrigger: function () {
      return Promise.resolve({});
    },
    setOrgTrigger: function () {
      return Promise.resolve({});
    },
    listTriggerHistory: function () {
      return Promise.resolve([]);
    },
    decideTriggerHistory: function () {
      return Promise.resolve(null);
    },
    clearTriggerHistory: function () {
      return Promise.resolve();
    },
    freeflowSetConfig: function () {
      return Promise.resolve({});
    },
    freeflowTranscribe: function () {
      return Promise.resolve(null);
    },
    integrationsList: function () {
      return Promise.resolve([]);
    },
    integrationsTemplates: function () {
      return Promise.resolve([]);
    },
    integrationsUpsert: function () {
      return Promise.resolve({ ok: false });
    },
    integrationsSetSecret: function () {
      return Promise.resolve({ ok: false });
    },
    integrationsRemove: function () {
      return Promise.resolve({ ok: false });
    },
    integrationsTest: function () {
      return Promise.resolve({ ok: false });
    },
    providerKeySet: function () {
      return Promise.resolve({ ok: false });
    },
    providerKeyHas: function () {
      return Promise.resolve(false);
    },
    providerKeyClear: function () {
      return Promise.resolve({ ok: false });
    },
    realtimeHasOpenAiKey: function () {
      return Promise.resolve(false);
    },
    realtimeMintToken: function () {
      return Promise.resolve(null);
    },
    realtimeAction: function () {
      return Promise.resolve({ spoken: "" });
    },
    realtimeActionConfirm: function () {
      return Promise.resolve({ spoken: "" });
    },
    realtimeActionCancel: function () {
      return Promise.resolve();
    },
    realtimeSetSessionLive: function () {
      return Promise.resolve();
    },
    realtimeDrainCompletions: function () {
      return Promise.resolve([]);
    },
    realtimeWaitFor: function () {
      return Promise.resolve(null);
    },
    appInfo: function () {
      return Promise.resolve({ version: CTH_VERSION });
    },
    rosterWrite: function () {
      return Promise.resolve({ ok: false });
    },
    updateCurrent: function () {
      return Promise.resolve({ state: "idle", version: CTH_VERSION });
    },
    updateRestartAndInstall: function () {
      return Promise.resolve({ ok: false });
    },
    updateCheckNow: function () {
      return Promise.resolve({ ok: false });
    },
    updateDownload: function () {
      return Promise.resolve({ ok: false });
    },
    updateOpenRelease: function () {
      return Promise.resolve();
    },
    updateSimulate: function () {
      return Promise.resolve({ ok: false });
    },
    controlPause: function () {
      return Promise.resolve(null);
    },
    controlAutoDelivery: function () {
      return Promise.resolve(null);
    },
    controlResume: function () {
      return Promise.resolve(null);
    },
    controlGateTool: function () {
      return Promise.resolve(null);
    },
    controlSteer: function () {
      return Promise.resolve(null);
    },
    controlHalt: function () {
      return Promise.resolve(null);
    },
    controlSnapshot: function () {
      return Promise.resolve(null);
    },
    listMissions: function () {
      return Promise.resolve([]);
    },
    saveMissions: function () {
      return Promise.resolve({ ok: false });
    },
    newFloor: function () {
      return Promise.resolve({ ok: false });
    },
    startClosingTime: function () {
      return Promise.resolve({ ok: false, error: "read-only web view" });
    },
    cancelClosingTime: function () {
      return Promise.resolve({ ok: false });
    },
    resetAll: function () {
      return Promise.resolve();
    },
    confirmClose: function () {
      return Promise.resolve(false);
    },
    cancelClose: function () {
      return Promise.resolve();
    }
  };

  // swallow method calls that don't exist yet (future bridge surface)
  var p = new Proxy(api, {
    get: function (target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === "string" && /^(on|open|confirm)/.test(prop)) {
        return function () {
          return function () {};
        };
      }
      return target[prop] !== undefined ? target[prop] : function () {
        return Promise.resolve(null);
      };
    }
  });

  // Boot straight past the hive picker: the renderer's useState initializer
  // reads this one-shot key, returns true for `hiveOpened`, then removes it.
  try {
    window.localStorage.setItem("cth.skipHivePickerOnce", "1");
  } catch (_e) {}

  window.cth = p;
  if (typeof window.process === "undefined") {
    window.process = { platform: "darwin", arch: "arm64", env: {} };
  }

  // live polling → pulse subscribers (drives the office floor updates)
  setInterval(function () {
    getState(true)
      .then(pulse)
      .catch(function () {});
  }, POLL_MS);
})();
