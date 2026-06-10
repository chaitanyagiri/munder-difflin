# Reliable smoke harness

The smoke harness uses deterministic fake agents and the local debug/MCP control
path to test Munder orchestration without real Claude/Codex model calls.

Run after a build:

```bash
npm run build
npm run test:smoke
```

It verifies:

- fake terminal-agent output and closing-time ACK/no-ACK behavior;
- the debug endpoint can boot and serve `/health`;
- the MCP wrapper can send a work order, wait for idle, and observe a bounded
  closing-time timeout state;
- the built `out/main` folder includes the Slack trigger sidecar required by the
  Electron main bundle.
