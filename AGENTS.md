# Glyph contributor guide

Glyph is a visual designer, scheduler and runner for DAG-shaped AI workflows. Each step runs the Pi coding agent (or a deterministic "helper"); outputs flow along connections; runs are immutable evidence. This repo is the Rust rewrite of the Rails app (`../glyph`).

## Project map

- `flake.nix`: dev environment source of truth (Postgres, Rust toolchain, Pi, buf).
- `proto/glyph/v1/*.proto`: the gRPC contract shared by backend and frontend.
- `backend/`: Rust (axum + tonic + sqlx). See `backend/AGENTS.md`.
- `frontend/`: TypeScript React (later epic).
- Each service owns its `Containerfile` and deploy flake: `nix run .#deploy` from `backend/` or `frontend/` builds and pushes that service's image to GHCR and restarts its deployment.
- `.agents/specs/`: epic plan and per-spec implementation plans.

## Development commands

```sh
nix run .#web                 # Postgres + backend (+ frontend when present) on :3000
nix run .#test                # cargo test against a local Postgres
nix run .#test -- workflows   # filtered
nix run .#check               # buf lint/breaking, fmt, clippy -D warnings, tests
nix run .#seed                # import the sample "Design POC Tournament" workflow (server must run)
nix run .#reset               # stop Postgres and wipe .dev
nix build .#glyph             # release binary
nix build .#image             # OCI image (binary + Pi 1.0.3), `podman load < result`
GLYPH_STEP_RUNNER=fake nix run .#web   # deterministic runner, no provider keys needed
nix develop                   # shell with db_start/db_stop/db_psql/db_migrate/sqlx_prepare
```

Local state lives in `.dev/` (gitignored). Secrets go in `.env` (gitignored), sourced by every app. `nix run .#deploy` (from `backend/` or `frontend/`) builds, pushes and restarts that service: never run it unless explicitly asked.

## Architecture rules

Feature-first modular monolith; ports & adapters where an external system exists; transport at the edge.

- `features/*/domain` imports only `shared`, `chrono`, `uuid`, `serde`/`serde_json`, `regex`. Never `tonic`, `axum`, `sqlx`, `tokio`, `reqwest`.
- `features/*/application` may use `async_trait` and its own `ports`; never transport or DB crates.
- `features/*/{grpc,http}` convert proto/HTTP ⇄ application commands; no SQL.
- `infrastructure/*` implements ports and may know everything.
- Features talk to each other only through `features/<x>/mod.rs` re-exports.
- `app/bootstrap.rs` is the only place that names concrete adapters.

`backend/tests/architecture.rs` enforces these rules (and checks itself against deliberate violations).

Specs, the parity audit and the cutover runbook live in `.agents/specs/` (`0012-hardening-deploy-cutover/{parity,cutover}.md`).

## Execution and sensitive data (safety-critical)

- Run and step-run configuration is immutable evidence: execute and render from the run snapshot, never from the current workflow.
- Lifecycle transitions are compare-and-set on status; finalize only when every step run is terminal, under the run lock.
- A failed step skips only its transitive descendants that are still queued.
- Scheduled dispatch is occurrence-key idempotent (`{workflow_id}:{next_run_at RFC3339}` unique); due-workflow lock, run creation and next-occurrence update share one transaction.
- Append events and enqueue jobs in the same transaction as the state change they describe.
- No retries for execution jobs: repeating agent-side work makes diagnostics ambiguous.
- Invoke Pi only through an argv vector (`Command::new(pi_bin).args(..)`); never a shell. Keep `env_clear()`, the temp HOME, timeout and SIGTERM→SIGKILL handling.
- Pass every agent/provider text through the `Redactor` before it is persisted, logged, published or rendered. Never log API keys, credentials or encryption keys.

## Conventions

- Tests first for domain logic; Rails specs (`../glyph/spec/**`) are the minimum test set.
- Keep Rails wording for user-facing messages verbatim.
- Commit messages: `feat(0006): add step mutations`.
- Keep changes narrow; run the smallest relevant verification and report what was not run.
