# Kalshi company pipeline

The Desktop folder is a junction to `C:/Users/chrom/src/munder-difflin`. The active
Kalshi MCP implementation is outside the app checkout, in the shared Hermes workspace.
No Electron build or installed-renderer patch is needed for these connector changes.

| Surface | Location |
|---|---|
| MCP entrypoint registered in Hermes `.mcp.json` | `C:/Users/chrom/AppData/Local/hermes/integrations/kalshi-mcp/launch.mjs` |
| Connector code and current verification | `C:/Users/chrom/AppData/Local/hermes/integrations/kalshi-mcp/` |
| Full office handoff and tool input guide | `C:/Users/chrom/AppData/Local/hermes/skills/trading/kalshi/ALL_MARKET_WORKFLOW.md` |
| Hypothetical review and existing decision engine | `C:/Users/chrom/AppData/Local/hermes/skills/trading/kalshi/review.py` and `engine.py` |
| Company coordination board | `C:/Users/chrom/HarnessAgents/hive/board.md` |

All categories are eligible for discovery, evidence gathering and review proposals.
There is no autonomous live order submission or simulated fill accounting. Review
readiness depends on fresh market data, explicit evidence, agreement, estimated costs
and hypothetical exposure inputs; it does not establish winning odds or profitability.

The connector exposes 19 tools. Existing worker sessions may retain the old registry;
new sessions load the updated entrypoint. Workers without native MCP access can run
`node integrations/kalshi-mcp/call.mjs GET_PIPELINE_STATUS` from Hermes.

Verification: `node integrations/kalshi-mcp/verify.mjs` from Hermes. This opens and
closes its own MCP process, checks live public and authenticated reads and verifies
that stale synthetic evidence is rejected. It never calls order mutation tools.
Read `verification.json` for the current outcome; do not infer runtime success from
the presence of an unrelated Node process or a scheduled task.
