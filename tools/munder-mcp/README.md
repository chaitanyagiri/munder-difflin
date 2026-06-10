# munder-mcp

`munder-mcp` is a local stdio MCP wrapper around Munder Difflin's debug control
endpoint. It is a client of the running Electron app, not a second orchestrator.

Start Munder with the local debug endpoint enabled:

```bash
MUNDER_DEBUG_CONTROL=1 open -a "Munder Difflin"
```

Register the MCP server with a client that supports stdio MCP:

```bash
node /path/to/munder-difflin/tools/munder-mcp/index.cjs
```

The server reads the discovery file written by Munder. Override it with
`MUNDER_DEBUG_DISCOVERY=/path/to/debug-control.json`, or set
`MUNDER_DEBUG_URL` and `MUNDER_DEBUG_TOKEN` directly for tests.

Example flow:

1. Call `munder_health`.
2. Call `munder_list_agents` and pick a target agent id.
3. Call `munder_send_work_order` with `{ "to": "<agent-id>", "body": "..." }`.
4. Call `munder_wait_for_idle` for that agent.
