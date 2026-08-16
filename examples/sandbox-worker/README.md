# Sandbox exec service (reference)

The other half of the **Sandbox exec (Cloudflare)** integration template. It gives a
hive worker one capability: *run this code somewhere that isn't the user's laptop.*

Agents in Munder Difflin run as real CLI processes on the user's machine. Sandboxed
autonomy (Settings → Autonomy & Budgets) bounds what those processes can touch, but the
riskiest thing an agent does isn't its own file writes — it's executing code the model
just **wrote** and nobody has read. That belongs off-machine.

## How a worker reaches it

The worker never holds this service's token and never calls it directly. It calls the
app's loopback broker, which injects the credential and forwards the request:

```
worker ──▶ $MD_BROKER_URL/i/sandbox-exec/exec                    (capability token)
              └──▶ broker (Electron main) ──▶ https://<your worker>/exec
                                                Authorization: Bearer <AUTH_TOKEN>
```

```bash
curl -s -X POST "$MD_BROKER_URL/i/sandbox-exec/exec" \
  -H "Authorization: Bearer $MD_BROKER_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"source":"python3 -c \"print(sum(range(10)))\"","backend":"shell"}'
# → {"ok":true,"stdout":"45\n","stderr":"","exitCode":0}
```

## Routes

| Route | Body | Returns |
| --- | --- | --- |
| `POST /exec` | `{"source": "...", "backend": "shell" \| "js", "timeoutMs"?: number}` | `{"ok":true,"stdout","stderr","exitCode"}` |
| `GET /health` | — | `{"ok":true,"backend":"sandbox-sdk"}` |

Both require `Authorization: Bearer <AUTH_TOKEN>`. Source is capped at 256 KB and the
timeout at 120 s, whatever the caller asks for.

## Deploy

```bash
cd examples/sandbox-worker
npm install
wrangler secret put AUTH_TOKEN      # any long random string
wrangler deploy
```

Then in Munder Difflin: **Settings → Integrations → Sandbox exec (Cloudflare)**, set the
base URL to your Worker origin (`https://md-sandbox-exec.<you>.workers.dev`) and paste
the same token as the secret. Enable it, and it appears in every worker's capability
catalog.

## Which Cloudflare sandbox?

This implementation uses [`@cloudflare/sandbox`](https://github.com/cloudflare/sandbox-sdk)
(**beta**): a real container per sandbox id, with streaming exec, background processes,
git clone, `/workspace` file APIs, and `sleepAfter` lifetimes. It needs Workers +
Containers, and Docker locally for `wrangler dev`.

[`@cloudflare/computer`](https://github.com/cloudflare/computer) (**preview**, MIT) is
the other option — a virtual filesystem plus `workspace.runtime.exec(source, {backend})`
inside Durable Objects, with the authoritative state in SQLite and container /
isolate-bash / isolate-JS backends. The isolate backends need no container at all, so
they start faster and cost less for small snippets, at the price of a much smaller
userland. `runInSandbox()` in `src/index.ts` is the single function to swap; upstream
calls its APIs unstable, so pin a version if you go that way.

Neither is required by the app: anything that answers these two routes works, including
a service on your own infrastructure.

## Not production code

One bearer token, no tenancy, no quotas, no audit log. It is deliberately small enough
to read in one sitting before you trust it with anything.
