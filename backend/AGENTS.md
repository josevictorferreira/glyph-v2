# Backend guide

Single crate `glyph-backend`, binary `glyph`. One port serves plain HTTP (`/up`, downloads, previews, `/schemas/workflow.json`), native gRPC (h2c) and gRPC-Web (h1, via `tonic-web`).

## Layout

```
src/
├── main.rs            Config::load → bootstrap → run
├── config.rs          env-only configuration
├── app/               composition root, router, AppState, error → status mapping
├── features/<name>/   domain/ (pure), application/ (use cases + ports), grpc/, http
├── infrastructure/    postgres, crypto, pi, gateways, jobs, telemetry
└── shared/            error, ids, time, issue, dag, events
```

## Database

- Migrations in `migrations/` are embedded (`sqlx::migrate!`) and applied at boot.
- Queries use `sqlx` macros checked against the database. `nix run .#test`/`.#check` set `SQLX_OFFLINE=true` and read `.sqlx/`; after changing any query run `sqlx_prepare` in `nix develop` (dev Postgres running, migrations applied via `db_migrate`) and commit `.sqlx/`.
- Integration tests use `#[sqlx::test]`: each test gets a fresh database on the local cluster.

## Pi

Contract verified against Pi **1.0.3** (the nixpkgs `pi-coding-agent` in `flake.lock`, also shipped in the image). `tests/pi_contract.rs` runs the real CLI against a local OpenAI-compatible mock whenever `GLYPH_PI_BIN` is set (the flake sets it) — rerun it after any Pi upgrade. `tests/fixtures/fake_pi.sh` stands in for Pi in the process-handling tests.

Safety rules for `infrastructure/pi/runner.rs` and `features/runs/domain/{pi_events,prompt,output_format_validator}.rs`: argv only, `env_clear()` + allow-list, temp HOME, stdin closed, timeout with SIGTERM → SIGKILL, and redact before anything leaves the runner.

## Tests

```sh
nix run .#test                       # everything
nix run .#test -- --test server      # one integration test file
```

| File | Covers |
|---|---|
| `tests/server.rs`, `tests/contract.rs` | `/up`, gRPC + gRPC-Web, every RPC implemented |
| `tests/schema.rs` | migrations, DB constraints |
| `tests/catalog.rs` | gateways (wiremock), refresh, `CatalogService`, no key in logs |
| `tests/workflows.rs` | every editor RPC, lifecycle, schedule, events |
| `tests/definition.rs` | schema route, import/apply/export/parse, tournament seed |
| `tests/runs.rs`, `tests/worker.rs` | run engine end-to-end through the worker, downloads, job queue |
| `tests/pi_runner.rs`, `tests/pi_contract.rs` | Pi process handling, real Pi contract |
| `tests/scheduling.rs` | minute dispatch, idempotency, concurrent dispatchers, recurring ticker |
| `tests/live.rs` | LISTEN/NOTIFY hub, `WatchWorkflow` |
| `tests/shutdown.rs` | SIGTERM drain / grace on the real binary |
| `tests/architecture.rs` | dependency rules |

Domain rules are unit-tested next to the code (`cargo test --lib`).
