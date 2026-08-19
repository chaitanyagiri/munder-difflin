---
title: "MCP Tool Poisoning: How to Secure the Model Context Protocol"
description: "How the Model Context Protocol gets attacked — tool poisoning, rug pulls, command injection — and the layered defenses that secure your MCP tools."
date: 2026-06-05
category: guides
categoryLabel: Guides
type: Technical
primaryKeyword: "mcp tool poisoning"
secondaryKeywords: ["mcp security", "model context protocol security", "mcp prompt injection", "securing mcp servers"]
tags: ["Security", "MCP", "Protocols", "Guardrails"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What is MCP tool poisoning?"
    a: "Tool poisoning is an attack where malicious instructions are hidden in an MCP tool's metadata — its name, description, or schema. Because an MCP client passes those descriptions to the model as input the user never sees, a poisoned description can steer the agent into unsafe actions. It's a form of indirect prompt injection that exploits the client-server trust model."
  - q: "What is an MCP rug pull attack?"
    a: "A rug pull is a time-delayed tool poisoning. A server looks benign when you approve it, then later updates its tool descriptions to add malicious instructions — which the agent will follow on the next call. The defense is to treat tool descriptions as untrusted: scan them at install and on every update, and reject silent changes."
  - q: "What's the most common MCP security risk?"
    a: "Despite the attention tool poisoning gets, industry analyses point to something more mundane: token mismanagement — a leaked or over-privileged credential — as the most common real-world MCP breach vector. Least privilege and secret hygiene matter more than defending any single clever injection chain."
---

<div class="callout tldr"><span class="ic">TL;DR</span><p>MCP's power — letting an agent discover and call
external tools — is also its attack surface. The core flaw is a <strong>trust model</strong>: an MCP
client hands the model tool <em>descriptions</em> it got from a server, usually <strong>without validating
them</strong>. That makes tool metadata an injection vector (<strong>tool poisoning</strong>), enables
time-bomb <strong>rug pulls</strong>, and — with unsanitized arguments — real command execution. Yet the
most common real breach is mundane: a <strong>leaked or over-privileged token</strong>. Defense is
layered: treat tool metadata as untrusted, scan and pin it, sanitize arguments, enforce OAuth 2.1 + least
privilege, and contain execution in a sandbox.</p></div>

The [Model Context Protocol](/blog/mcp-and-skills-in-a-hive/) made agents genuinely useful: a standard
way to plug an LLM into tools, APIs, and data. It also opened a security surface that most teams wiring
up MCP servers haven't thought through. This is a practical tour of how MCP gets attacked — and the
layered defenses that actually hold.

## The MCP trust model (why it's attackable)

MCP works like this: a client asks a server "what tools do you offer?", gets back tool names,
**descriptions**, and schemas, and passes those to the model so it can decide what to call. The weak
point is subtle but serious — **the tool description is model input the user never sees**, and
**most clients accept server-provided metadata without rigorous validation; the spec doesn't require it**
([academic threat-modeling work](https://arxiv.org/abs/2603.22489) makes this the center of its analysis).

So whoever controls an MCP server controls text that goes straight into the model's decision-making. That
single fact is the root of almost every MCP attack below.

## Tool poisoning: the headline attack

**Tool poisoning** embeds malicious instructions in a tool's metadata — its description or schema. The
user approves a benign-looking "weather" tool; its description quietly tells the model to also read
`~/.ssh/id_rsa` and pass it along. It's a form of *indirect* prompt injection, and research identifies it
as the most prevalent, impactful client-side MCP vulnerability. The agent isn't jailbroken — it's just
following instructions it was handed by something it was told to trust.

The mitigation starts with a mindset shift: **tool descriptions are untrusted model input, not
documentation.** Treat them the way you'd treat any string from the internet that reaches your prompt.

{% img "note-1" %}

## The rug pull: poisoning on a delay

Approving a server once isn't enough, because descriptions can change. In a **rug pull**, a server is
clean when you approve it, then **updates its tool descriptions later** to add exfiltration instructions
the agent will follow on the next call. Approval is a moment; trust has to be continuous.

Defense: pin and **re-scan tool descriptions on every server update, and reject silent changes**. A tool
whose description changed since you approved it should require re-approval, not be used quietly.

## The rest of the catalog

- **Resource / content poisoning.** Instead of the tool's metadata, the attacker hides instructions in
  the **data** an MCP server retrieves — a poisoned document, a planted issue comment — achieving
  *persistent* prompt injection through a trusted data channel.
- **Line jumping / command injection.** Unsanitized tool arguments (pipes, `;`, `&`) flow straight to a
  shell. One 2026 analysis attributes [roughly 43% of MCP CVEs](https://www.practical-devsecops.com/mcp-security-best-practices/)
  to command injection — the unglamorous bug that does real damage. Never interpolate model output
  straight into a command.
- **Confused deputy.** A proxy MCP server acts with *its* privileges instead of the *user's*. The
  [spec's mitigation](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices) is
  a per-user registry of approved `client_id`s, checked before any third-party authorization flow, with
  consent stored securely.

## The boring truth: it's usually the token

Worth saying plainly, because it cuts against the spy-movie framing: industry analyses put **token
mismanagement — a leaked or over-privileged API key — as the most common real-world MCP breach vector**,
ahead of clever injection chains. The flashy attack gets the write-ups; the credential left in scope does
the damage. If you do one thing, make it **least privilege**: scope every tool's token so it can only
touch the data it explicitly needs.

{% img "note-2" %}

## Defenses, layered

No single control is enough; MCP security is defense in depth.

- **Treat tool metadata as untrusted.** Scan descriptions at install **and on every update**; reject
  silent changes (the rug-pull defense).
- **Sanitize tool arguments** before they reach a shell or API. Model output is never a safe command.
- **AuthN/AuthZ + least privilege.** Modern MCP standardizes on **OAuth 2.1** for HTTP transports
  (replacing custom auth and raw API keys), with Dynamic Client Registration; scope tokens tightly. The
  [OWASP guide to secure MCP server development](https://genai.owasp.org/resource/a-practical-guide-for-secure-mcp-server-development/)
  is the checklist to start from.
- **Mitigate confused-deputy** with per-user `client_id` registries and stored consent for proxies.
- **Vet and pin servers.** Prefer first-party or local servers; pin versions; review on update.
- **Contain execution.** Even a perfectly-authed call can be hijacked by poisoned content, so pair MCP
  hygiene with an execution sandbox and **default-deny network egress** — the same defense-in-depth
  posture covered in [running AI agents safely](/blog/agent-security-and-sandboxing/). The protocol layer
  and the infrastructure layer reinforce each other.

[Red Hat's overview](https://www.redhat.com/en/blog/model-context-protocol-mcp-understanding-security-risks-and-controls)
and the [MCP spec's own security best practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
are the authoritative starting points to go deeper.

## Securing MCP in a hive

A [multi-agent harness](/#what) gives every agent MCP tools and skills — which means it inherits this
whole threat surface, but also a local-first advantage in defending it. The trust problem shrinks when
the servers are *yours*: prefer **local or first-party MCP servers** (no third party controlling your
tool descriptions), keep **prod credentials out of agents' reach** and tokens least-privileged, and
**version-pin** what you install. Layer that with what a hive already gives you — risky actions gated by
[human-in-the-loop approval](/blog/human-in-the-loop-approving-ai-agents/) and every call recorded to an
[append-only audit log](/blog/append-only-event-log-agents/) — and a poisoned tool has far fewer places
to do damage.

## The takeaway

MCP didn't invent prompt injection; it gave it a standardized, high-trust delivery channel. The fix isn't
to avoid MCP — it's to stop trusting tool metadata by default. Treat descriptions as untrusted input,
scan and pin them, scope every token to least privilege, sanitize what reaches a shell, and contain
execution. Do that and MCP is what it should be: a powerful, *bounded* way to give agents real tools.

Want a hive where MCP tools run with least-privilege, human-gated, fully-audited by default? You can
[download Munder Difflin](/#install) free — it's open source.
