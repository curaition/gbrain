# Railway deployment: start command & worker lifecycle (production brain)

> Operational runbook for the `GBrain` service in Railway project
> `peaceful-rejoicing` (`gbrain-production-97af`). Written 2026-08-23 after a
> 47-hour production queue wedge. Linear: CUR-1447 (this runbook), CUR-1445
> (incident, resolved), CUR-1433 (historical embedding context).

## 1. TL;DR

On container images that run GBrain via `bun run src/cli.ts` (no `gbrain`
binary on `$PATH`), **`gbrain jobs supervisor` and `gbrain autopilot` cannot
start workers** — they die ~90–360 s after boot with:

```
Could not resolve the gbrain CLI path. Install gbrain so it is on $PATH …
Debug: PATH="…" execPath="/…/bin/bun" argv1="/app/src/cli.ts"
```

Run the worker **in-process** instead:

```bash
sh -c 'bun run src/cli.ts config set search.reranker.enabled false; \
( sleep 90 && bun run src/cli.ts jobs work --concurrency 2 ) & \
exec bun run src/cli.ts serve --http --port 3131 --bind 0.0.0.0 \
  --public-url https://<your-domain>'
```

This exact pattern is in production since 2026-08-23 and drained a backlog of
5 stuck jobs plus an 110-chunk embed backfill on its first cycle.

## 2. Root cause (why supervisor/autopilot fail)

`resolveGbrainCliPath()` (v0.46.x: `src/commands/autopilot.ts:204-252`)
resolves the binary used to spawn worker *children* via three checks only:

1. `which gbrain` on `$PATH`
2. `process.execPath` ends with `/gbrain`
3. `process.argv[1]` ends with `/gbrain`

Source-run deployments satisfy none of them (`execPath=…/bun`,
`argv[1]=/app/src/cli.ts`), so every child-spawning path throws. The throw
happens *after* the boot delay, which makes it look like "the worker started
then mysteriously vanished." It was never viable on such images — the original
wedge was structural, not transient.

## 3. Why each piece of the start command exists

| Element | Reason |
|---|---|
| `config set search.reranker.enabled false` | defensive: keeps reranker off across redeploys |
| `sleep 90` | lets `serve` win the DB-migration race; do not cut below ~60 s |
| `( … ) &` subshell | backgrounds the worker without a long-lived shell parent |
| `jobs work` (NOT `jobs supervisor`) | runs in-process; no CLI-path resolution, no child spawn |
| `exec bun … serve` | server becomes PID 1; Railway healthcheck/restart tracks it |

Accepted trade-off: no auto-restart if the worker crashes. Compensating
control: an external daily probe that reads `get_job_stats.wedged` **directly**
(doctor's depth/stall-based `queue_health` reports OK for a zero-worker,
zero-stall queue — that blind spot is why the original wedge ran 47 h silent).

## 4. Env-var contract

| Variable | Value | Notes |
|---|---|---|
| `GBRAIN_CHAT_MODEL` | `openrouter:anthropic/claude-sonnet-4.6` | pins chat lane (beats tier auto-discovery) |
| `GBRAIN_EXPANSION_MODEL` | `openrouter:google/gemini-3-flash-preview` | pins query-expansion lane |
| `OPENROUTER_API_KEY` | secret | credential for both lanes above |
| `GBRAIN_EMBEDDING_MODEL` | `openai:text-embedding-3-small` | **NEVER change** — sizes the vector column |
| `GBRAIN_EMBEDDING_DIMENSIONS` | `1536` | **NEVER change** — changing strands all existing chunks |
| `OPENAI_API_KEY` | secret | **embedding-only** credential |

Hazards learned the hard way:

- Removing `OPENAI_API_KEY` kills the **embed backfill** even when every LLM
  lane is pinned to OpenRouter — embeddings do not route through OpenRouter.
  Symptom: embed jobs go dead with *"Embedding model openai:text-embedding-3-small
  requires OPENAI_API_KEY"*.
- With chat/expansion env-pinned, keeping the OpenAI key does **not** reopen
  model-tier auto-discovery (`refreshLatestOpenAIModels()`) on those lanes.
  Residual discovery surface: auxiliary passes (enrich/dream-style) — watch
  the provider response logs after new cycles.
- Never repoint the embedding model at another provider despite other keys
  (`VOYAGE_API_KEY` etc.) being present. See the v0.43 zembed incident class.

## 5. Post-redeploy verification

Wait ≥4 min after boot, then against the MCP endpoint with an admin-scoped token:

```
get_job_stats   → wedged == false; waiting drains toward 0
list_jobs       → recent jobs show attempts_started >= 1
get_health      → missing_embeddings trends to 0 after sync events
run_doctor      → wedged_queue check absent/OK; note doctor CANNOT see
                  zero-worker wedges by itself (see §3)
```

Known-benign: dead-letter entries from earlier incidents (e.g. the v0.43
zembed-era embed failures). `dead` is terminal; `cancel_job` refuses them;
they are inert records unless the count grows.

## 6. Durable fix (upstream)

Make source-run images spawn-safe by building an entrypoint binary during the
image build:

```dockerfile
RUN bun build ./src/cli.ts --compile --outfile /usr/local/bin/gbrain
```

(or minimally install a shim script named `gbrain` onto `$PATH`). Once
`which gbrain` succeeds inside the container, the supported topologies return:

- `jobs supervisor` regains crash-restart/backoff semantics
- `autopilot` becomes viable (worker supervision + full dream/sync cycles)

Until then, treat any start-command revision that introduces
supervisor/autopilot as suspect, and always re-run §5 after redeploying.
