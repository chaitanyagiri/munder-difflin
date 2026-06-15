---
name: md-hive-sync
version: 1.0.0
description: |
  Munder Difflin hive sync — runs the start-of-task hive protocol steps:
  reads memory.md, checks inbox/ for new messages, and reminds you to record
  durable facts in memory.md and write coordination files before ending.
  Use when asked to "sync with the hive", "check my inbox", "hive status",
  or "hive sync".
  Proactively suggest at the start of a new task if you haven't checked your
  hive inbox in this conversation. (munder-difflin)
allowed-tools:
  - Read
  - Bash
---

## Hive Sync

Run the mandatory hive start-of-task steps:

1. **Read memory** — `Read $AGENT_DIR/memory.md` for durable context from prior sessions.

2. **Check inbox** — list and read all files in `$AGENT_DIR/inbox/` that are NOT in `inbox/.done/`. For each message:
   - Act on the message.
   - Move the handled file into `$AGENT_DIR/inbox/.done/` with `mv`.

3. **Report** — summarize what you found in memory and any new inbox messages. Note any tasks assigned to you or information relevant to the current session.

4. **End-of-task reminder** — before closing this conversation, append durable facts, decisions, and outcomes to `$AGENT_DIR/memory.md` so future-you remembers.

Run `echo $AGENT_DIR` if the variable is not set to locate your agent directory under the hive root.
