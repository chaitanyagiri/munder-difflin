#!/usr/bin/env node
'use strict';

const { existsSync, readFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

const SERVER_NAME = 'munder-mcp';
const SERVER_VERSION = '0.1.0';
const MIN_ENDPOINT_VERSION = 1;

const TOOLS = [
  {
    name: 'munder_health',
    description: 'Check whether the local Munder Difflin debug control endpoint is available.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'munder_snapshot',
    description: 'Return the current sanitized Munder snapshot: agents, PTYs, closing-time state, and recent metadata log.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'munder_list_agents',
    description: 'List known Munder hive agents from the sanitized debug snapshot.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'munder_send_work_order',
    description: 'Route a work order through Munder hive mail to god or a named agent.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Target hive agent id. Defaults to god.' },
        subject: { type: 'string' },
        body: { type: 'string' },
        act: { type: 'string', enum: ['request', 'inform', 'propose', 'query', 'agree', 'refuse', 'done'] },
        requiresReply: { type: 'boolean' },
      },
      required: ['body'],
      additionalProperties: false,
    },
  },
  {
    name: 'munder_wait_for_idle',
    description: 'Poll the snapshot until a PTY or agent has produced no output for the requested idle window.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        ptyId: { type: 'string' },
        idleMs: { type: 'number', default: 2000 },
        timeoutMs: { type: 'number', default: 60000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'munder_wait_for_text',
    description: 'Poll sanitized snapshot metadata until its JSON contains the given text.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        timeoutMs: { type: 'number', default: 60000 },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'munder_start_closing_time',
    description: 'Start Munder closing-time graceful shutdown protocol.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'munder_steer_agent',
    description: 'Inject a steer note for an agent at its next hook boundary.',
    inputSchema: {
      type: 'object',
      properties: { agentId: { type: 'string' }, text: { type: 'string' } },
      required: ['agentId', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'munder_halt_agent',
    description: 'Request a graceful halt for an agent at its next hook boundary.',
    inputSchema: {
      type: 'object',
      properties: { agentId: { type: 'string' } },
      required: ['agentId'],
      additionalProperties: false,
    },
  },
  {
    name: 'munder_kill_agent',
    description: 'Kill a live Munder PTY by id. Destructive: use only when graceful stop failed.',
    inputSchema: {
      type: 'object',
      properties: { ptyId: { type: 'string' } },
      required: ['ptyId'],
      additionalProperties: false,
    },
  },
];

function defaultDiscoveryPath() {
  if (process.env.MUNDER_DEBUG_DISCOVERY) return process.env.MUNDER_DEBUG_DISCOVERY;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'munder-difflin', 'debug-control.json');
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'munder-difflin', 'debug-control.json');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'munder-difflin', 'debug-control.json');
}

function readDiscovery() {
  if (process.env.MUNDER_DEBUG_URL && process.env.MUNDER_DEBUG_TOKEN) {
    return {
      url: process.env.MUNDER_DEBUG_URL,
      token: process.env.MUNDER_DEBUG_TOKEN,
      endpointVersion: Number(process.env.MUNDER_DEBUG_ENDPOINT_VERSION || MIN_ENDPOINT_VERSION),
    };
  }
  const path = defaultDiscoveryPath();
  if (!existsSync(path)) {
    throw new Error(`Munder debug discovery file not found: ${path}. Start Munder with MUNDER_DEBUG_CONTROL=1.`);
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed.url !== 'string' || typeof parsed.token !== 'string') {
    throw new Error(`Invalid Munder debug discovery file: ${path}`);
  }
  if (Number(parsed.endpointVersion || 0) < MIN_ENDPOINT_VERSION) {
    throw new Error(`Unsupported Munder debug endpoint version: ${parsed.endpointVersion}`);
  }
  return parsed;
}

function createMunderClient(discovery = readDiscovery()) {
  async function request(path, opts = {}) {
    const res = await fetch(`${discovery.url}${path}`, {
      method: opts.method || 'GET',
      headers: {
        authorization: `Bearer ${discovery.token}`,
        ...(opts.body ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : null; }
    catch { body = { raw: text }; }
    if (!res.ok) {
      throw new Error(`Munder debug endpoint ${res.status}: ${body?.error || text || res.statusText}`);
    }
    return body;
  }
  return {
    health: () => request('/health'),
    snapshot: () => request('/snapshot'),
    workOrder: (payload) => request('/work-order', { method: 'POST', body: payload }),
    startClosingTime: () => request('/closing-time/start', { method: 'POST', body: {} }),
    steer: (agentId, text) => request(`/control/${encodeURIComponent(agentId)}/steer`, { method: 'POST', body: { text } }),
    halt: (agentId) => request(`/control/${encodeURIComponent(agentId)}/halt`, { method: 'POST', body: {} }),
    kill: (ptyId) => request(`/pty/${encodeURIComponent(ptyId)}/kill`, { method: 'POST', body: {} }),
  };
}

async function handleToolCall(name, args = {}, client = createMunderClient()) {
  switch (name) {
    case 'munder_health':
      return client.health();
    case 'munder_snapshot':
      return client.snapshot();
    case 'munder_list_agents': {
      const snap = await client.snapshot();
      return { ok: true, agents: snap?.hive?.agents || [] };
    }
    case 'munder_send_work_order':
      if (!args.body || typeof args.body !== 'string') throw new Error('body is required');
      return client.workOrder(args);
    case 'munder_wait_for_idle':
      return waitForIdle(args, client);
    case 'munder_wait_for_text':
      return waitForText(args, client);
    case 'munder_start_closing_time':
      return client.startClosingTime();
    case 'munder_steer_agent':
      if (!args.agentId || !args.text) throw new Error('agentId and text are required');
      return client.steer(args.agentId, args.text);
    case 'munder_halt_agent':
      if (!args.agentId) throw new Error('agentId is required');
      return client.halt(args.agentId);
    case 'munder_kill_agent':
      if (!args.ptyId) throw new Error('ptyId is required');
      return client.kill(args.ptyId);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function waitForIdle(args, client) {
  const timeoutMs = numberOr(args.timeoutMs, 60000);
  const idleMs = numberOr(args.idleMs, 2000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const snap = await client.snapshot();
    const ptys = Array.isArray(snap.ptys) ? snap.ptys : [];
    const pty = args.ptyId
      ? ptys.find((p) => p.id === args.ptyId)
      : args.agentId
        ? ptys.find((p) => p.agentId === args.agentId)
        : null;
    if (!pty) return { ok: true, state: 'no-live-pty' };
    if (typeof pty.idleMs === 'number' && pty.idleMs >= idleMs) {
      return { ok: true, state: 'idle', pty };
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for idle after ${timeoutMs}ms`);
}

async function waitForText(args, client) {
  if (!args.text || typeof args.text !== 'string') throw new Error('text is required');
  const timeoutMs = numberOr(args.timeoutMs, 60000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const snap = await client.snapshot();
    if (JSON.stringify(snap).includes(args.text)) {
      return { ok: true, text: args.text };
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for text: ${args.text}`);
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeMessage(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

async function handleRpc(msg) {
  if (msg.method === 'notifications/initialized') return;
  try {
    if (msg.method === 'initialize') {
      writeMessage({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      });
      return;
    }
    if (msg.method === 'tools/list') {
      writeMessage({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
      return;
    }
    if (msg.method === 'tools/call') {
      const result = await handleToolCall(msg.params?.name, msg.params?.arguments || {});
      writeMessage({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
      });
      return;
    }
    writeMessage({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  } catch (e) {
    writeMessage({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } });
  }
}

function startStdioServer() {
  let buffer = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const sep = buffer.indexOf('\r\n\r\n');
      if (sep === -1) return;
      const headers = buffer.slice(0, sep).toString('utf8');
      const m = headers.match(/Content-Length:\s*(\d+)/i);
      if (!m) throw new Error('Missing Content-Length header');
      const length = Number(m[1]);
      const start = sep + 4;
      if (buffer.length < start + length) return;
      const body = buffer.slice(start, start + length).toString('utf8');
      buffer = buffer.slice(start + length);
      void handleRpc(JSON.parse(body));
    }
  });
}

if (require.main === module) startStdioServer();

module.exports = {
  TOOLS,
  createMunderClient,
  defaultDiscoveryPath,
  handleToolCall,
  readDiscovery,
  startStdioServer,
};
