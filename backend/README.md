# glyph-backend

Rust backend for Glyph: one process serves HTTP, native gRPC and gRPC-Web on one port, runs the job worker, the recurring tickers (minute schedule dispatch, 5-minute model refresh) and the live-update listener. Migrations are embedded and applied at boot.

```sh
nix run .#web            # from the repo root: Postgres + this server on :3000
nix run .#test           # full test suite
nix build .#glyph        # release binary (offline sqlx data, no protoc needed)
nix build .#image        # OCI image (binary + Pi), load with `podman load < result`
```

## HTTP routes

| Route | Purpose |
|---|---|
| `GET /up` | 200 `ok` when the database answers, 503 otherwise |
| `GET /schemas/workflow.json` | workflow definition JSON Schema (cached a day) |
| `GET /workflows/{id}/runs/{id}/step_runs/{id}/download` | step output as a file (`nosniff`) |
| `GET /workflows/{id}/runs/{id}/step_runs/{id}/preview` | HTML output inline under a strict CSP |
| `POST /glyph.v1.*/*`, `/grpc.health.v1.Health/*`, reflection | gRPC and gRPC-Web |

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | — (required) | Postgres connection URL |
| `GLYPH_LISTEN_ADDR` | `0.0.0.0:3000` | listen address |
| `GLYPH_DATABASE_MAX_CONNECTIONS` | `10` | shared pool size (LISTEN connections are separate) |
| `GLYPH_ENCRYPTION_KEY` | insecure dev key (warned) | base64 of 32 bytes; AES-256-GCM key for evidence at rest |
| `GLYPH_CORS_ORIGINS` | `http://localhost:5173` | comma list of browser origins allowed for gRPC-Web |
| `GLYPH_PUBLIC_URL` | unset | absolute base URL for the schema header in exported YAML |
| `VELOX_BASE_URL` / `VELOX_API_KEY` | `https://velox.josevictor.me/v1` / unset | model provider |
| `GLYPH_MODELS_CACHE_TTL` | `300` | seconds before the model catalog reports `stale` |
| `GLYPH_STEP_RUNNER` | `pi` | `pi` or `fake` (deterministic, for development) |
| `GLYPH_PI_BIN` | `pi` | Pi CLI path (the flake sets it) |
| `GLYPH_PI_TIMEOUT_SECONDS` | `900` | per-step agent timeout (SIGTERM, then SIGKILL after 3s) |
| `GLYPH_STEP_CONCURRENCY` | `5` | concurrent step executions per process |
| `GLYPH_WORKER_ENABLED` | `true` | run the job worker and recurring tickers here |
| `GLYPH_SCHEDULER_ENABLED` | `true` | enqueue the minute schedule dispatch |
| `GLYPH_SHUTDOWN_GRACE` | `30` | seconds the worker waits for in-flight jobs on shutdown |
| `GLYPH_LIVE_HEARTBEAT_SECONDS` | unset | heartbeat events on idle `WatchWorkflow` streams |
| `GLYPH_LOG_JSON` | `false` | JSON log lines |
| `RUST_LOG` | `info,sqlx=warn,tower_http=info` | log filter |

Secret values (`VELOX_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GLYPH_DATABASE_PASSWORD`, `GLYPH_ENCRYPTION_KEY`, the `DATABASE_URL` password) are redacted from every agent output before it is stored, logged or published.

## Jobs

| Kind | Queue (concurrency) | Enqueued by |
|---|---|---|
| `execute_workflow_run` | `workflow_execution` (2) | run creation (same transaction) |
| `execute_step_run` | `step_execution` (`GLYPH_STEP_CONCURRENCY`) | dispatch after start / step finish / retry |
| `dispatch_due_workflows` | `scheduling` (1) | recurring ticker, every minute |
| `refresh_models` | `maintenance` (1) | recurring ticker, every 5 minutes |

Jobs are never retried; a failed job records its error. Handlers are idempotent through compare-and-set status transitions.

## Graceful shutdown

On SIGINT/SIGTERM: gRPC health reports `NOT_SERVING`, tickers stop, live streams end, the worker stops claiming and waits up to `GLYPH_SHUTDOWN_GRACE` for in-flight jobs, and HTTP requests get up to 10s to drain. A step still running after the grace is left `running` (diagnostic, never retried).
