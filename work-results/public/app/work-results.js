"use strict";
/* work-results.js — per-agent WORK-RESULTS panel for Munder Difflin.
 *
 * A self-contained panel that renders, for each agent (god + workers), the
 * questions/tasks it was given, the messages it received & replied, and its
 * output files under the projects/ tree. Data comes from the LIVE hive files
 * through `window.cth` — the real preload in the packaged app, or the shim in
 * the browser build. Nothing is hardcoded; auto-refreshes every 5s.
 */
(function () {
  if (window.__workResultsLoaded) return;
  window.__workResultsLoaded = true;

  var POLL_MS = 5000;
  var state = { agents: [], tasks: [], board: "", projects: [], outboxes: {}, inboxes: {}, lastTs: 0 };
  var timers = [];

  function $(sel) {
    return document.querySelector(sel);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function short(s, n) {
    s = String(s == null ? "" : s);
    return s.length > (n || 140) ? s.slice(0, (n || 140) - 1) + "…" : s;
  }

  function timeAgo(iso) {
    if (!iso) return "";
    var t = new Date(iso).getTime();
    if (isNaN(t)) return "";
    var s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return s + "s ago";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }

  /* ── data adapters: window.cth (real preload OR browser shim) ────────── */
  function call(name) {
    var args = Array.prototype.slice.call(arguments, 1);
    var c = window.cth || {};
    if (typeof c[name] === "function") {
      try {
        return Promise.resolve(c[name].apply(c, args));
      } catch (e) {
        return Promise.resolve(null);
      }
    }
    return Promise.resolve(null);
  }

  function getDirectory() {
    return call("hiveAgentDirectory").then(function (d) {
      return (d && (d.agents || d)) || [];
    });
  }

  function getTasks() {
    return call("hiveTasks").then(function (t) {
      if (!t) return [];
      return Array.isArray(t) ? t : (t.tasks || []);
    });
  }

  function getBoard() {
    return call("hiveBoard").then(function (b) {
      return typeof b === "string" ? b : "";
    });
  }

  function getInbox(id) {
    return call("hiveInbox", id).then(function (msgs) {
      return Array.isArray(msgs) ? msgs : [];
    });
  }

  /* Recent messages incl. direction (inbox|outbox). Real preload returns the
   * voice read-layer; the shim mirrors it from /api/state. */
  function getMessages(id) {
    return call("hiveMessages", { agentId: id, limit: 40, includeArchived: true }).then(function (msgs) {
      return Array.isArray(msgs) ? msgs : [];
    });
  }

  /* Output files: prefer a structured projects tree (shim /api/state.projects),
   * else walk the projects root with the real preload's listDir. */
  function getProjects() {
    return call("hiveProjects").then(function (p) {
      if (Array.isArray(p) && p.length) return p;
      return call("listDir", defaultProjectsRoot(), "").then(function (r) {
        if (!r || !r.ok || !Array.isArray(r.entries)) return [];
        var dirs = r.entries.filter(function (e) {
          return e.isDir;
        });
        return Promise.all(
          dirs.map(function (d) {
            return call("listDir", defaultProjectsRoot(), d.name).then(function (fr) {
              var files = [];
              if (fr && fr.ok && Array.isArray(fr.entries)) {
                files = fr.entries
                  .filter(function (e) {
                    return !e.name.startsWith(".") && e.name !== "node_modules";
                  })
                  .slice(0, 40)
                  .map(function (e) {
                    return { name: e.name, size: e.isDir ? 0 : e.size };
                  });
              }
              return { name: d.name, isDir: true, files: files, agents: [] };
            });
          })
        );
      });
    });
  }

  /* Projects tree lives next to the hive home. */
  function defaultProjectsRoot() {
    var home = null;
    try {
      if (window.cth && typeof window.cth.harnessHomeSync === "function") home = window.cth.harnessHomeSync();
      if (!home && window.cth && typeof window.cth.getConfig === "function") {
        // covered below via boot sync; harnessHomeSync is synchronous where it matters
      }
    } catch (e) {}
    if (!home && state.harnessHome) home = state.harnessHome;
    if (!home) return "/Users/skyzhao/HarnessAgents/projects";
    return home.replace(/[\\/]hive$/, "") + "/projects";
  }

  /* ── load ─────────────────────────────────────────────────────────────── */
  function load() {
    return Promise.all([getDirectory(), getTasks(), getBoard(), getProjects()]).then(function (res) {
      state.agents = res[0];
      state.tasks = res[1];
      state.board = res[2];
      state.projects = res[3] || [];
      if (window.cth && typeof window.cth.getConfig === "function") {
        return call("getConfig").then(function (cfg) {
          if (cfg && cfg.harnessHome) state.harnessHome = cfg.harnessHome;
          return loadMailboxes();
        });
      }
      return loadMailboxes();
    });
  }

  function loadMailboxes() {
    var ids = state.agents.map(function (a) {
      return a.id;
    });
    return Promise.all(
      ids.map(function (id) {
        return Promise.all([getInbox(id), getMessages(id)]).then(function (pair) {
          state.inboxes[id] = pair[0];
          var out = [];
          var seen = {};
          pair[1].forEach(function (m) {
            if (!m || seen[m.id]) return;
            seen[m.id] = 1;
            out.push(m);
          });
          state.outboxes[id] = out;
        });
      })
    ).then(function () {
      state.lastTs = Date.now();
      render();
    });
  }

  /* ── project → agents mapping (match by cwd) ─────────────────────────── */
  function projectAgents(projectName) {
    var hits = [];
    state.agents.forEach(function (a) {
      var cwd = String(a.cwd || a.project || "");
      if (!cwd) return;
      if (cwd.indexOf("projects" + sep() + projectName) !== -1 || cwd.split(sep()).pop() === projectName) {
        hits.push(a);
      }
    });
    return hits;
  }

  function sep() {
    return navigator && navigator.userAgent && navigator.userAgent.indexOf("Win") !== -1 ? "\\" : "/";
  }

  /* ── rendering ────────────────────────────────────────────────────────── */
  var HOST = "unknown";
  var TASKS_STATUS = { todo: "todo", doing: "doing", blocked: "blocked", done: "done" };

  function statusColor(a) {
    var b = (a.breaker || "healthy").toLowerCase();
    if (b === "constrained" || b === "steering" || b === "stopped") return "#C98A1B";
    var st = String(a.status || "idle").toLowerCase();
    if (st === "working" || st === "busy" || st === "active") return "#2A6FB0";
    if (a.isGod) return "#6E1423";
    if (a.archived) return "#9A8C9E";
    return "#3E7C4F";
  }

  function statusLabel(a) {
    if (a.archived) return "archived";
    if (a.isGod) return "orchestrator";
    var b = (a.breaker || "healthy").toLowerCase();
    if (b === "stopped") return "looping";
    if (b === "constrained" || b === "steering") return "steering";
    var st = String(a.status || "idle");
    if (st === "working" || st === "busy") return "working";
    if (st === "blocked") return "blocked";
    return st || "idle";
  }

  function agentTasks(id) {
    return state.tasks.filter(function (t) {
      var a = t.assignee || t.assignedTo || "";
      return a === id;
    });
  }

  function renderAgentCard(a) {
    var card = el("section", "wr-card");
    var head = el("header", "wr-card-head");
    var name = el("h3", "wr-name", a.name || a.id);
    name.style.color = statusColor(a);
    var meta = el("span", "wr-role", a.role || (a.isGod ? "orchestrator (god)" : "worker"));
    var status = el("span", "wr-status", statusLabel(a));
    status.style.color = statusColor(a);
    var idTag = el("span", "wr-id", a.id);
    head.appendChild(name);
    head.appendChild(meta);
    head.appendChild(idTag);
    head.appendChild(status);
    card.appendChild(head);

    var body = el("div", "wr-card-body");

    /* tasks given */
    var tasks = agentTasks(a.id);
    var tl = el("div", "wr-block");
    tl.appendChild(el("h4", "wr-block-title", "ASSIGNED TASKS (" + tasks.length + ")"));
    if (!tasks.length) tl.appendChild(el("p", "wr-muted", "no tasks assigned"));
    tasks.forEach(function (t) {
      var row = el("div", "wr-task");
      var st = TASKS_STATUS[t.status] || t.status || "todo";
      var badge = el("span", "wr-badge", st);
      var title = el("span", "wr-task-title", short(t.title, 90));
      var when = el("span", "wr-time", t.updatedAt ? timeAgo(t.updatedAt) : "");
      row.appendChild(badge);
      row.appendChild(title);
      if (when.textContent) row.appendChild(when);
      tl.appendChild(row);
      if (t.humanQA && t.humanQA.length) {
        t.humanQA.forEach(function (qa) {
          var qr = el("div", "wr-qa");
          qr.appendChild(el("span", "wr-q", "Q: " + short(qa.q, 120)));
          if (qa.a) qr.appendChild(el("span", "wr-a", "A: " + short(qa.a, 120)));
          tl.appendChild(qr);
        });
      }
    });
    body.appendChild(tl);

    /* messages received */
    var inbox = state.inboxes[a.id] || [];
    var il = el("div", "wr-block");
    il.appendChild(el("h4", "wr-block-title", "RECEIVED (" + inbox.length + ")"));
    if (!inbox.length) il.appendChild(el("p", "wr-muted", "no messages"));
    inbox.slice(-8).reverse().forEach(function (m) {
      var row = el("div", "wr-msg");
      row.appendChild(el("span", "wr-act", m.act || ""));
      var who = el("span", "wr-who", (m.from || "?") + (m.direction ? " → " + m.direction : ""));
      var subj = el("span", "wr-subj", short(m.subject || m.body, 110));
      var t = el("span", "wr-time", m.created_at ? timeAgo(m.created_at) : "");
      row.appendChild(who);
      row.appendChild(subj);
      if (t.textContent) row.appendChild(t);
      il.appendChild(row);
    });
    body.appendChild(il);

    /* replies sent (outbox) */
    var out = state.outboxes[a.id] || [];
    var ol = el("div", "wr-block");
    ol.appendChild(el("h4", "wr-block-title", "REPLIES / OUTBOX (" + out.length + ")"));
    if (!out.length) ol.appendChild(el("p", "wr-muted", "no outbox messages"));
    out.slice(-8).reverse().forEach(function (m) {
      var row = el("div", "wr-msg wr-msg-out");
      row.appendChild(el("span", "wr-act", m.act || ""));
      var who = el("span", "wr-who", "→ " + (m.to || "?"));
      var subj = el("span", "wr-subj", short(m.subject || m.body, 110));
      var t = el("span", "wr-time", m.created_at ? timeAgo(m.created_at) : "");
      row.appendChild(who);
      row.appendChild(subj);
      if (t.textContent) row.appendChild(t);
      ol.appendChild(row);
    });
    body.appendChild(ol);

    /* output files */
    var files = agentOutputFiles(a);
    var fl = el("div", "wr-block");
    fl.appendChild(el("h4", "wr-block-title", "OUTPUT FILES (" + files.length + ")"));
    if (!files.length) fl.appendChild(el("p", "wr-muted", "no output files yet"));
    files.forEach(function (f) {
      var row = el("div", "wr-file");
      row.appendChild(el("span", "wr-fname", f.path));
      if (f.size != null && f.size > 0) row.appendChild(el("span", "wr-fsize", f.size));
      fl.appendChild(row);
    });
    body.appendChild(fl);

    card.appendChild(body);
    return card;
  }

  function agentOutputFiles(a) {
    var out = [];
    state.projects.forEach(function (p) {
      if (!p || !p.name) return;
      var agents = p.agents && p.agents.length ? p.agents : projectAgents(p.name);
      var mine = agents.some(function (x) {
        return x.id === a.id;
      });
      if (!mine) return;
      (p.files || []).forEach(function (f) {
        out.push({ path: p.name + "/" + f.name, size: f.size });
      });
      if (!p.files || !p.files.length) out.push({ path: p.name + "/", size: "" });
    });
    return out.slice(0, 20);
  }

  function render() {
    if (!$("#wr-root")) buildPanel();
    var list = $("#wr-agents");
    list.textContent = "";
    var visible = state.agents.filter(function (a) {
      return !a.archived || (a.isGod && false);
    });
    if (!visible.length) visible = state.agents;
    visible.forEach(function (a) {
      list.appendChild(renderAgentCard(a));
    });
    $("#wr-count").textContent = visible.length + " agents";
    var last = $("#wr-last");
    if (last) last.textContent = "live hive · " + new Date().toLocaleTimeString();
    var board = $("#wr-board-preview");
    if (board) {
      var lines = state.board.split("\n").filter(function (l) {
        return l.length > 4;
      });
      board.textContent = short(lines.join("\n"), 400);
    }
    var tasksDoing = state.tasks.filter(function (t) {
      return t.status === "doing";
    }).length;
    var tasksDone = state.tasks.filter(function (t) {
      return t.status === "done";
    }).length;
    $("#wr-stats").textContent = "tasks: " + state.tasks.length + " (doing " + tasksDoing + ", done " + tasksDone + ")";
  }

  function buildPanel() {
    var root = el("div", "wr-root");
    root.id = "wr-root";
    root.innerHTML =
      '<button id="wr-toggle" class="wr-toggle" title="Work results panel">WORK RESULTS</button>' +
      '<div id="wr-panel" class="wr-panel">' +
      '  <div class="wr-panel-head">' +
      '    <div><div class="wr-logo">MD</div><h2 class="wr-title">WORK RESULTS</h2>' +
      '      <div class="wr-sub"><span id="wr-count"></span> · <span id="wr-stats"></span></div></div>' +
      '    <button id="wr-close" class="wr-close" title="Close">×</button>' +
      '  </div>' +
      '  <div class="wr-scroll" id="wr-agents"></div>' +
      '  <div class="wr-panel-foot"><span id="wr-last"></span><span class="wr-muted">auto-refresh ' + Math.round(POLL_MS / 1000) + 's</span></div>' +
      '</div>';
    document.body.appendChild(root);

    var toggle = $("#wr-toggle");
    var panel = $("#wr-panel");
    toggle.addEventListener("click", function () {
      panel.classList.add("wr-open");
      toggle.style.display = "none";
    });
    $("#wr-close").addEventListener("click", function () {
      panel.classList.remove("wr-open");
      toggle.style.display = "";
    });

    var css = el("style");
    css.textContent = WR_CSS;
    document.head.appendChild(css);
  }

  var WR_CSS =
    ".wr-root{position:fixed;inset:0;pointer-events:none;z-index:2147483000;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;}" +
    ".wr-toggle{position:fixed;right:16px;top:16px;z-index:2147483001;pointer-events:auto;cursor:pointer;background:#6E1423;color:#F4F1EA;border:3px solid #4A0D17;font-family:'Press Start 2P',monospace;font-size:10px;letter-spacing:1px;padding:10px 14px;box-shadow:4px 4px 0 rgba(26,19,32,.35);}" +
    ".wr-toggle:hover{background:#8A1B2D;}" +
    ".wr-panel{position:fixed;top:0;right:0;bottom:0;width:min(560px,94vw);background:#FFF8E7;color:#1A1320;border-left:4px solid #4A0D17;box-shadow:-8px 0 24px rgba(26,19,32,.35);transform:translateX(105%);transition:transform .25s ease;pointer-events:auto;display:flex;flex-direction:column;}" +
    ".wr-panel.wr-open{transform:translateX(0);}" +
    ".wr-panel-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:14px 18px;background:#1A1320;color:#F4F1EA;border-bottom:4px solid #6E1423;}" +
    ".wr-logo{display:inline-grid;place-items:center;width:36px;height:36px;background:#6E1423;border:3px solid #4A0D17;font-family:'Press Start 2P',monospace;font-size:10px;margin-right:8px;vertical-align:middle;}" +
    ".wr-title{display:inline-block;font-family:'Press Start 2P',monospace;font-size:12px;margin:0;vertical-align:middle;}" +
    ".wr-sub{font-size:11px;color:#CBB8D8;margin-top:6px;}" +
    ".wr-close{background:none;border:none;color:#F4F1EA;font-size:24px;cursor:pointer;line-height:1;}" +
    ".wr-scroll{flex:1;overflow-y:auto;padding:14px 18px 20px;}" +
    ".wr-panel-foot{display:flex;justify-content:space-between;padding:8px 18px;border-top:1px solid #E4D8C0;font-size:11px;color:#6B5878;}" +
    ".wr-card{margin:0 0 16px;border:2px solid #4A0D17;background:#FFFFFF;box-shadow:3px 3px 0 rgba(26,19,32,.18);}" +
    ".wr-card-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;padding:10px 12px;border-bottom:2px solid #E4D8C0;}" +
    ".wr-name{margin:0;font-family:'Press Start 2P',monospace;font-size:11px;}" +
    ".wr-role{font-size:11px;color:#6B5878;}" +
    ".wr-id{font-size:10px;color:#9A8C9E;background:#F2EADA;padding:1px 6px;border-radius:8px;}" +
    ".wr-status{font-weight:700;font-size:11px;margin-left:auto;}" +
    ".wr-card-body{padding:10px 12px;}" +
    ".wr-block{margin:0 0 12px;}" +
    ".wr-block-title{margin:0 0 6px;font-family:'Press Start 2P',monospace;font-size:8px;letter-spacing:1px;color:#6B5878;}" +
    ".wr-muted{color:#9A8C9E;font-size:11px;margin:2px 0;}" +
    ".wr-task,.wr-msg,.wr-file{display:flex;gap:8px;align-items:baseline;font-size:12px;padding:3px 0;border-bottom:1px dotted #E4D8C0;}" +
    ".wr-badge{font-size:9px;font-weight:700;padding:1px 5px;border:1px solid #4A0D17;color:#4A0D17;text-transform:uppercase;white-space:nowrap;}" +
    ".wr-task-title{flex:1;}" +
    ".wr-time{color:#9A8C9E;font-size:10px;white-space:nowrap;}" +
    ".wr-qa{font-size:11px;padding:3px 0 3px 10px;color:#4A384F;}" +
    ".wr-q{display:block;}" +
    ".wr-a{display:block;color:#2A6FB0;}" +
    ".wr-act{font-size:9px;font-weight:700;text-transform:uppercase;color:#6E1423;border:1px solid #6E1423;padding:1px 4px;white-space:nowrap;}" +
    ".wr-who{color:#6B5878;font-size:10px;white-space:nowrap;}" +
    ".wr-subj{flex:1;}" +
    ".wr-msg-out .wr-act{color:#2A6FB0;border-color:#2A6FB0;}" +
    ".wr-file{font-family:'JetBrains Mono',Menlo,monospace;font-size:11px;}" +
    ".wr-fname{flex:1;color:#1A1320;}" +
    ".wr-fsize{color:#9A8C9E;font-size:10px;}";

  /* ── start ────────────────────────────────────────────────────────────── */
  function start() {
    load();
    timers.push(setInterval(load, POLL_MS));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  window.__workResults = { load: load, state: state, refresh: load };
})();
