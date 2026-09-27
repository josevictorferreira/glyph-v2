# 0012 — Hardening, deploy, parity audit, cutover

## Goal

Make the backend production-ready and prove parity with the Rails app before the frontend epic starts.

## Depends on

0002–0011.

## Scope

### Architecture enforcement
- `backend/tests/architecture.rs`: walk `src/features/**/domain/**` and `**/application/**`; fail on `use (tonic|axum|sqlx|reqwest|tokio::process|tokio::net|hyper|tower)` or `crate::infrastructure`. Also fail on `crate::features::<a>::<internal>` imports from another feature (allow only `crate::features::<a>::{…}` re-exports listed in that feature's `mod.rs`).
- Clippy `-D warnings`, `cargo fmt --check`, `cargo deny` (licenses/advisories), `buf lint`, `buf breaking` in `nix run .#check`.

### Operability
- Graceful shutdown: stop accepting → drain HTTP/gRPC (10s) → stop ticker → worker waits in-flight up to `GLYPH_SHUTDOWN_GRACE` → close pool.
- Telemetry: `tracing` spans per request (`tower-http` `TraceLayer`), per job (`kind`, `id`, `run_id`, `step_run_id`), JSON logs in prod (`GLYPH_LOG_JSON=true`); request/job ids as fields. No secrets in spans (Redactor applied to any error string that reaches a span; keys are `secrecy::SecretString`).
- Health: `/up` checks pool `SELECT 1`; gRPC health reports `NOT_SERVING` while migrating/shutting down.
- Metrics: out of scope (note).

### Container + deploy
- `Containerfile` (multi-stage): builder `rust:1.xx-slim` → `cargo build --release` with `SQLX_OFFLINE=true`; runtime `debian:bookworm-slim` + `ca-certificates` + Node 22 + `npm i -g @earendil-works/pi-coding-agent` (same as Rails image), non-root `glyph` user, `GLYPH_PI_BIN=pi`, `ENTRYPOINT ["/app/glyph"]` (migrations run at boot; no separate entrypoint script).
- Alternative evaluated: `pkgs.dockerTools.buildLayeredImage` from the flake (pure, pins Pi to nixpkgs' version). Pick one during the task; prefer the Nix image if Pi from nixpkgs matches the version smoke-tested in 0009.
- `nix run .#deploy`: port from Rails flake (podman build `linux/amd64`, push `ghcr.io/<repo>:latest`, `kubectl -n apps rollout restart deployment/glyph`). Never run unless asked (document in AGENTS.md).
- Env contract documented in `backend/README.md`: `DATABASE_URL`, `GLYPH_LISTEN_ADDR`, `GLYPH_ENCRYPTION_KEY`, `VELOX_*`, `OMNIROUTE_*`, `GLYPH_PI_*`, `GLYPH_STEP_CONCURRENCY`, `GLYPH_WORKER_ENABLED`, `GLYPH_SCHEDULER_ENABLED`, `GLYPH_CORS_ORIGINS`, `GLYPH_LOG_JSON`, `RUST_LOG`.

### Parity audit
- Walk the 0001 inventory table; for each row link the test(s) proving it or record a manual check with date + command. Output: `.agents/specs/0012-hardening-deploy-cutover/parity.md`.
- Behavioural diff list (intentional): outbox enqueue instead of after-commit; `StepRunCancelled` broadcast added; `Cron{expression}` schedule variant; deferred FK instead of `before_destroy` hack; proto sends `model_id` as `provider/model` (no display-string parsing); `MoveStep` returns aggregate. Anything else found → fix or add here.

### Cutover runbook (`cutover.md`)
1. Rails: export every workflow YAML (`GET /workflows/:id/definition`) — script via `rails runner`.
2. v2: `ImportWorkflow` each; compare `ValidateWorkflow` issues to Rails validator output; fix model ids (velox/omniroute full ids).
3. Re-create schedules' values (exported in YAML) and activate.
4. Run one manual run per workflow with `FakeStepRunner` off; confirm `SUCCEEDED`.
5. Point DNS/ingress; keep Rails read-only for run-history reference (history not migrated — 0001 non-goal).

## Tasks

1. Architecture test → verify: passes; a deliberate `use sqlx` in a domain file fails it.
2. `nix run .#check` pipeline (fmt, clippy, deny, buf, tests) → verify: green from clean clone.
3. Graceful shutdown + health gating → verify: integration test: SIGTERM during a fake 5s step → job finishes, exit 0; during a 60s step with grace 2s → exit after ~2s, step remains `running` (documented).
4. Telemetry review → verify: trace-level log capture during a full run with fake keys shows no secret; each job span has ids.
5. Containerfile / Nix image + `.#deploy` → verify: image runs locally with `podman run` against dev Postgres; `/up` ok; a run completes with real Pi.
6. `parity.md` + `cutover.md` → verify: every inventory row has evidence; reviewer sign-off.
7. Update root `AGENTS.md`/`README.md` with final commands and architecture rules → verify: new contributor can run `nix run .#web` from README alone.

## Acceptance

- `nix run .#check` green; architecture test enforced.
- Image deployed to the homelab manually via `nix run .#deploy` (only when the user asks) and a scheduled workflow dispatches from it.
- `parity.md` complete with no unresolved rows.

## Out of scope

Frontend, metrics/alerting, multi-tenant auth, run-history migration.
