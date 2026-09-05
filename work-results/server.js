"use strict";
/* work-results web server — serves the REAL Munder Difflin renderer + the
 * self-contained work-results.js panel, backed by live hive files (read-only).
 * Adds the projects tree and outbox messages to /api/state for the panel.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const HOST = process.env.WR_HOST || "127.0.0.1";
const PORT = Number(process.env.WR_PORT || 8788);

const HIVE_ROOT = process.env.HIVE_ROOT || "/Users/skyzhao/HarnessAgents/hive";
const PROJECTS_ROOT = process.env.PROJECTS_ROOT || "/Users/skyzhao/HarnessAgents/projects";
const APP_DIR = path.join(__dirname, "public", "app");
const PUBLIC_DIR = path.join(__dirname, "public");

function sep() {
  return process.platform === "win32" ? "\\" : "/";
}

/* Self-heal the renderer bundle copy: if the served app lacks the entry JS,
 * mirror it from the sibling web-office build (env ASSETS_SRC or default). */
function ensureAssets() {
  try {
    const entry = path.join(APP_DIR, "assets", "index-DPf-thQz.js");
    if (fs.existsSync(entry)) return;
    const src = process.env.ASSETS_SRC || "/Users/skyzhao/HarnessAgents/worktrees/worker-kevin-web-office-v2/web-office/public/app";
    const srcAssets = path.join(src, "assets");
    if (!fs.existsSync(srcAssets)) {
      console.warn("work-results: no renderer bundle locally and ASSETS_SRC missing at", srcAssets);
      return;
    }
    fs.cpSync(srcAssets, path.join(APP_DIR, "assets"), { recursive: true });
    console.log("work-results: mirrored renderer assets from", srcAssets);
  } catch (e) {
    console.warn("work-results: ensureAssets failed:", e.message);
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

function readJson(rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(HIVE_ROOT, rel), "utf8"));
  } catch {
    return null;
  }
}
function readText(rel) {
  try {
    return fs.readFileSync(path.join(HIVE_ROOT, rel), "utf8");
  } catch {
    return null;
  }
}
function readAgentFile(id, rel) {
  try {
    return fs.readFileSync(path.join(HIVE_ROOT, "agents", id, rel), "utf8");
  } catch {
    return null;
  }
}
function listAgentJson(id, dir) {
  const base = path.join(HIVE_ROOT, "agents", id, dir);
  try {
    return fs
      .readdirSync(base)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(base, f), "utf8"));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function agentDirectory() {
  const registry = readJson("registry.json") || { godId: null, agents: {} };
  const fleet = readJson("fleet.json") || { agents: [] };
  const byId = new Map(fleet.agents.map((a) => [a.id, a]));
  const agents = Object.entries(registry.agents || {}).map(([id, a]) => {
    const f = byId.get(id) || {};
    return {
      id,
      name: a.name,
      role: a.role ?? (a.isGod ? "orchestrator" : "agent"),
      provider: a.provider ?? "claude",
      model: f.model ?? null,
      status: f.status ?? a.status ?? "idle",
      cwd: a.cwd ?? null,
      cwdValid: a.cwdValid ?? null,
      archived: !!a.archived,
      isGod: !!a.isGod,
      isAssistant: !!a.isAssistant,
      sessionId: a.sessionId ?? null,
      inboxBacklog: f.inboxBacklog ?? 0,
      breaker: f.breaker ?? "healthy",
      tokens: f.tokens ?? 0,
      usd: Number((f.usd ?? 0).toFixed(4)),
      lastTool: f.lastTool ?? null,
      lastActiveSecAgo: f.lastActiveSecAgo ?? null,
      onHold: !!f.onHold,
      contextTokens: null,
      contextLimit: null,
      contextPct: null,
    };
  });
  return { godId: registry.godId, agents };
}

/* Projects output tree: one entry per project dir, with top-level files +
 * which agents' cwd points into it. Used by the work-results panel. */
function projectsTree() {
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(PROJECTS_ROOT);
  } catch {
    return out;
  }
  const registry = readJson("registry.json") || { agents: {} };
  const tasks = (readJson("tasks.json") || { tasks: [] }).tasks || [];
  const board = readText("board.md") || "";
  const slugOf = (p) => p.name.toLowerCase().replace(/[^a-z0-9-]/g, "-");

  /* Board.md is the authoritative producer record, but lines are long and name
   * many agents. Attribute only when the agent's name/id appears within a short
   * window around the `projects/<slug>` reference (same sentence, ~140 chars). */
  const boardLines = board.split("\n");
  const boardAttributed = (id, a, want) => {
    const display = (a && a.name || "").toLowerCase();
    const idlc = id.toLowerCase();
    const ref = "projects" + sep() + want;
    for (const line of boardLines) {
      const idx = line.indexOf(ref);
      if (idx === -1) continue;
      const ll = line.toLowerCase();
      const from = Math.max(0, idx - 140);
      const to = Math.min(line.length, idx + ref.length + 140);
      const window = ll.slice(from, to);
      if (window.indexOf(idlc) !== -1 || (display && window.indexOf(display) !== -1)) return true;
    }
    return false;
  };

  for (const name of names) {
    if (name.startsWith(".")) continue;
    const want = slugOf({ name });
    /* Precise attribution: cwd inside projects/<name>, worktree/id named after
     * the slug, a tasks.json assignee whose card mentions projects/<name>, or a
     * board.md line naming the agent next to projects/<name>. */
    const attributed = (id, a) => {
      if (a && a.isGod) return false;
      const cwd = String((a && a.cwd) || "");
      const hay = (id + " " + cwd).toLowerCase();
      if (cwd.indexOf("projects" + sep() + want) !== -1) return true;
      if (hay.indexOf("worktree") !== -1 && hay.indexOf(want) !== -1) return true;
      if (hay.indexOf("projects" + sep()) !== -1 && hay.indexOf(want) !== -1) return true;
      for (const t of tasks) {
        if ((t.assignee || "") !== id) continue;
        const text = ((t.title || "") + " " + (t.description || "")).toLowerCase();
        if (text.indexOf("projects" + sep() + want) !== -1) return true;
      }
      if (boardAttributed(id, a, want)) return true;
      const mem = readAgentFile(id, "memory.md") || "";
      return mem.indexOf("projects" + sep() + want) !== -1;
    };

    const full = path.join(PROJECTS_ROOT, name);
    let isDir = false;
    let files = [];
    try {
      isDir = fs.statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    try {
      files = fs
        .readdirSync(full)
        .filter((f) => !f.startsWith(".") && !["node_modules", ".git"].includes(f))
        .slice(0, 40)
        .map((f) => {
          let size = 0;
          try {
            const st = fs.statSync(path.join(full, f));
            size = st.isDirectory() ? 0 : st.size;
          } catch {}
          return { name: f, size };
        });
    } catch {}
    const agents = Object.entries(registry.agents || {})
      .filter(([id, a]) => attributed(id, a))
      .map(([id, a]) => ({ id, name: a.name }));
    out.push({ name, files, agents });
  }
  return out;
}

function buildState() {
  const registry = readJson("registry.json") || { godId: null, agents: {} };
  const tasks = readJson("tasks.json") || { tasks: [] };
  const fleet = readJson("fleet.json") || { agents: [] };
  const board = readText("board.md") || "";
  const directory = agentDirectory();
  const memories = {};
  const inboxes = {};
  const outboxes = {};
  const messages = [];
  for (const a of directory.agents) {
    if (a.archived) continue;
    memories[a.id] = readAgentFile(a.id, "memory.md") || "";
    const inbox = listAgentJson(a.id, "inbox");
    const outbox = listAgentJson(a.id, "outbox");
    inboxes[a.id] = inbox;
    outboxes[a.id] = outbox;
    for (const m of inbox) messages.push(Object.assign({}, m, { direction: "inbox", owner: a.id }));
    for (const m of outbox) messages.push(Object.assign({}, m, { direction: "outbox", owner: a.id }));
  }
  return {
    ts: Date.now(),
    hiveRoot: HIVE_ROOT,
    projectsRoot: PROJECTS_ROOT,
    board,
    tasks,
    registry,
    fleet,
    agentDirectory: directory,
    projects: projectsTree(),
    logTail: [],
    memories,
    inboxes,
    outboxes,
    messages,
    telemetry: {
      usage: fleet.agents.map((a) => ({ agentId: a.id, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, model: a.model ?? null, usd: a.usd ?? 0, ts: fleet.ts ?? Date.now() })),
      spans: {},
    },
    config: { version: "0.4.6", hiveRoot: HIVE_ROOT, onboardingComplete: true, harnessHome: HIVE_ROOT },
  };
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function serveStatic(res, root, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.resolve(root, rel);
  const rootResolved = path.resolve(root);
  if (file !== path.join(rootResolved, "index.html") && !file.startsWith(rootResolved + path.sep)) {
    sendJson(res, 403, { error: "forbidden", path: pathname });
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found: " + pathname);
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=3600",
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const pathname = url.pathname;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }
  if (pathname === "/" || pathname === "/index.html") {
    serveStatic(res, APP_DIR, "/");
    return;
  }
  if (pathname === "/api/state") {
    sendJson(res, 200, buildState());
    return;
  }
  if (pathname === "/api/projects") {
    sendJson(res, 200, { ts: Date.now(), projects: projectsTree() });
    return;
  }
  if (pathname.startsWith("/app/")) {
    serveStatic(res, APP_DIR, pathname.slice("/app".length));
    return;
  }
  if (!pathname.includes("..")) {
    const appFile = path.resolve(APP_DIR, pathname.replace(/^\/+/, ""));
    if (appFile.startsWith(path.resolve(APP_DIR) + path.sep) && fs.existsSync(appFile)) {
      serveStatic(res, APP_DIR, pathname);
      return;
    }
    serveStatic(res, PUBLIC_DIR, pathname);
    return;
  }
  sendJson(res, 404, { error: "not found", path: pathname });
});

server.listen(PORT, HOST, () => {
  console.log("Munder Difflin — WORK-RESULTS panel server");
  console.log(`  Serving:  http://${HOST}:${PORT}/`);
  console.log(`  Hive:     ${HIVE_ROOT} (read-only)`);
  console.log(`  Projects: ${PROJECTS_ROOT} (read-only)`);
});
server.on("error", (err) => {
  console.error("work-results server failed:", err.message);
  process.exit(1);
});
