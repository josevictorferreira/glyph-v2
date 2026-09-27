# 0001 — Epic: rewrite Glyph backend in Rust

## Story

Glyph (`../glyph`) is a Rails 8 app: visual designer, scheduler and runner for DAG-shaped AI workflows. Each step runs the Pi coding agent (or a deterministic "helper"), outputs flow along connections, runs are immutable evidence.

This repo (`glyph-v2`) becomes a monorepo:

```
glyph-v2/
├── flake.nix          # nix run .#web = Postgres + backend + frontend
├── proto/             # gRPC contract shared by backend + frontend
├── backend/           # Rust (axum + tonic + sqlx)
└── frontend/          # TypeScript React (later epic)
```

This epic covers **backend only**. Frontend is a later epic; the API contract (0003) is designed so it can start in parallel once 0003 lands.

Success = every backend behaviour of the Rails app exists in Rust, is covered by tests, and is reachable over a typed gRPC contract; `nix run .#web` brings the whole dev stack up.

## Goals

1. Feature parity with the Rails backend (inventory below). No feature dropped silently.
2. Architecture from the brief: feature-first modular monolith, ports & adapters where an external system exists, transport at the edge, domain ignorant of axum/tonic/sqlx/tokio.
3. Type-safe server→frontend contract: protobuf + gRPC-Web served by tonic directly (no Envoy), server-streaming for live updates.
4. Nix as the dev-environment source of truth (`web`, `test`, `reset`, later `deploy`).
5. Safety-critical semantics preserved: immutable snapshots, compare-and-set transitions, occurrence-key idempotency, no job retries, redaction, scrubbed Pi environment.

## Non-goals

- Frontend (separate epic; only a placeholder slot in the flake).
- Data migration of run history from the Rails DB. Workflows migrate via the existing YAML export → import (0007). Encryption format is not ActiveRecord-compatible.
- Authentication / multi-user. Rails has none (`Phlex::Reactive.verify_authorized = false`, no `Current.user` in code). Leave an interceptor slot only.
- Retries of execution jobs (deliberately absent in Rails; keep absent).
- Workflow deletion/retirement (`retired_at` column exists in Rails, unused; not ported).

## Feature inventory (parity checklist)

Source of truth: `../glyph/app/**`. Every row must map to a spec.

| Area | Rails behaviour | Spec |
|---|---|---|
| Health | `GET /up` 200 | 0002 |
| Catalog | `AvailableModel` (velox/omniroute `/models`, capabilities, `available` flag, stale TTL 300s), `ToolDefinition` seed (read/bash/edit/write), 5-min refresh job, flag active workflows whose model vanished → `needs_attention` | 0005 |
| Workflows list | search name/description ILIKE, status filter, order `updated_at desc`, limit 100 | 0006 |
| Workflow CRUD | create (blank name → "Untitled workflow"), update name/description/fail_fast, `WorkflowCreated/Updated` events | 0006 |
| Steps | add pi/helper (auto canvas slot or explicit position, clamp 0..4000/0..3000), duplicate (copies inputs, +40/+40), save details/prompt/output/model/tools, delete (cascade connections + downstream inputs), move/nudge | 0006 |
| Step inputs | add (name, required), remove, map to workflow input, uniqueness (case-insensitive per step) | 0006 |
| Workflow inputs | add/update/remove (name regex `^[A-Za-z][A-Za-z0-9_ ]*$`, required, value, ask_at_run_time; constant requires value) | 0006 |
| Connections | create (self-edge, cycle, missing output name, one source per input, replace-existing flow), remove (also removes destination input), output rename propagates `source_output_name` | 0006 |
| Validator | all `Workflows::Validator` checks incl. `{{var}}` prompt tokens, model availability/capabilities (temperature only), tools, schedule, cycle | 0006 |
| Lifecycle | activate / pause / resume / revalidate-after-edit → `needs_attention`; events | 0006 |
| Schedule | builder kinds interval/daily/weekly/monthly → cron; IANA tz; human description; `next_run_at` (UTC, DST-safe); enabled only when not draft; per-input schedule values | 0006 |
| Snapshot | `SnapshotBuilder` v3 shape incl. resolved tools | 0006 |
| YAML | JSON Schema (`/schemas/workflow.json`), Parser (size limit, safe load, schema errors w/ line numbers, reference checks), Applier (fingerprint optimistic concurrency, upsert by id/name, layout for new steps), Exporter (defaults folding, fingerprint), Importer | 0007 |
| Runs | `RunCreator` (validation, missing values, snapshot, step runs, events), `WorkflowExecutor`, `StepDispatcher` (ready set, skip transitive descendants, fail_fast cancel), `RunFinalizer`, `RunStop`, `StepRetry`, `InputResolver`, `WorkflowValues`, helper steps, draft test runs, delete run | 0008 |
| Evidence | encrypted at rest: resolved_inputs, output, output_text, messages, session_content, technical_error, supplied_values, schedule values | 0004/0008 |
| Downloads | step output download (md/html/json/zip, base64→bytes for zip, helper → pretty JSON, safe filename, nosniff), HTML preview with strict CSP | 0008 |
| Pi | argv-only spawn, scrubbed env, temp HOME + `models.json`, prompt via `@file`, NDJSON parse, success/model_error/timeout/exit_error/malformed_output/internal_error, SIGTERM→SIGKILL, 3s progress snapshots, `OutputFormatValidator` (json/html/zip bombs), `SessionTranscript` | 0009 |
| Redaction | env secret values + `sk-…`/`Bearer …` patterns, applied before persist/log/publish | 0009 |
| Scheduling | minute dispatcher, `FOR UPDATE` lock per workflow, occurrence key `"{id}:{next_run_at utc iso8601}"` unique, advance `next_run_at`, flag needs_attention when invalid | 0010 |
| Jobs | queues workflow_execution / step_execution (5 concurrent), scheduling, maintenance; no retries | 0008 |
| Events | append per mutation in same tx (ids + status only), streams `Workflow$id`, `WorkflowRun$id`, correlation id | 0004/0008 |
| Live updates | run/step lifecycle + progress broadcasts to page subscribed on `workflow_{id}` | 0011 |
| Seeds | tool catalog; "Design POC Tournament" sample workflow | 0005/0007 |
| Ops | Containerfile, `nix run .#deploy`, graceful shutdown, tracing | 0012 |

## Target architecture

```
backend/
├── Cargo.toml  build.rs  migrations/  .sqlx/  tests/
└── src/
    ├── main.rs                # ~10 lines: Config::load → bootstrap → run
    ├── config.rs
    ├── app/
    │   ├── bootstrap.rs       # composition root: infra → services → router → worker
    │   ├── router.rs          # axum router + tonic-web services, one port
    │   └── state.rs           # AppState { workflows, runs, catalog, definition, live }
    ├── features/
    │   ├── health/http.rs
    │   ├── catalog/     {domain, application, ports, grpc}
    │   ├── workflows/   {domain/, application/, ports/, grpc/}
    │   ├── definition/  {domain/, application/, grpc/, http.rs}   # YAML
    │   ├── runs/        {domain/, application/, ports/, grpc/, http/}
    │   ├── scheduling/  {application/}
    │   └── live/        {grpc/}
    ├── infrastructure/
    │   ├── postgres/    {pool, migrate, repositories, events, jobs, listener}
    │   ├── crypto/      aes_gcm.rs
    │   ├── pi/          runner.rs
    │   ├── gateways/    {velox.rs, omniroute.rs}
    │   ├── jobs/        worker.rs
    │   └── telemetry.rs
    └── shared/          {error.rs, ids.rs, time.rs, dag.rs}
```

Dependency rules (enforced by an architecture test, 0012):

- `features/*/domain` imports only `shared`, `chrono`, `uuid`, `serde`, `regex`. Never `tonic`, `axum`, `sqlx`, `tokio`, `reqwest`.
- `features/*/application` may use `async_trait` and its own `ports`; never transport or DB crates.
- `features/*/{grpc,http}` convert proto/HTTP ⇄ application commands; no SQL.
- `infrastructure/*` implements ports; may know everything.
- Features talk to each other only via `features/<x>/mod.rs` re-exports (public operations), never internals.
- `app/bootstrap.rs` is the only place that names concrete adapters.

Single crate to start. Split into workspace crates only if 0012's architecture test proves insufficient.

## Key decisions

| Decision | Choice | Alternatives / why |
|---|---|---|
| Transport | axum + tonic on one port; gRPC services wrapped with `tonic-web` (+ CORS) so browsers speak gRPC-Web without Envoy. Plain HTTP for `/up`, downloads, preview, schema JSON. | Connect protocol (`axum-connect`) less mature in Rust. REST loses the typed contract the user asked for. |
| Contract | `proto/glyph/v1/*.proto`, codegen via `tonic-build` + `protox` (pure-Rust protoc, no `protoc` binary). Frontend later: `buf generate` + `protoc-gen-es` + `@connectrpc/connect-web` gRPC-Web transport. | |
| Live updates | server-streaming RPC `WatchWorkflow` fed by Postgres `LISTEN/NOTIFY`. `NOTIFY` issued inside the mutating transaction = delivered on commit = Rails' after-commit semantics for free, works across replicas. Payload = ids + type; client refetches. | In-process broadcast only works single-replica. Pushing full state over the stream duplicates the read RPCs. |
| Jobs | own `jobs` table, `FOR UPDATE SKIP LOCKED` polling worker in-process, enqueued in the same transaction as the state change (transactional outbox). No retries. | `apalis`/`sqlxmq` add ceremony for 4 job kinds. Rails also used a DB queue (Solid Queue). |
| Events | `events` table appended in-tx (audit) + NOTIFY (side effects). No event-sourcing replay; tables stay the read model, as in Rails. | Keeps RES semantics without a framework. |
| DB access | `sqlx` (Postgres, `runtime-tokio`, `tls-rustls`), query macros with committed `.sqlx/` offline data so Nix builds need no DB. Migrations embedded via `sqlx::migrate!`, applied at boot. | Diesel: sync; SeaORM: heavier. |
| Encryption | app-level AES-256-GCM (`aes-gcm`), key `GLYPH_ENCRYPTION_KEY` (base64, 32 bytes), dev fallback constant like Rails. `bytea` columns, `nonce‖ciphertext‖tag`. | Not AR-compatible → no run-history migration (non-goal). |
| Cron | `croner` + `chrono-tz` (5-field, tz-aware next occurrence, strictly-after semantics like fugit). | `cron` crate lacks tz. |
| YAML | typed parse → `serde_json::Value` for `jsonschema` (draft 2020-12) validation; second pass with a marked parser for JSON-pointer → line index; aliases/tags rejected; 256 KiB limit. Emit with preserved key order. | Exact crate chosen in 0007. |
| IDs / time | `uuid` v4 newtypes in `shared/ids.rs`; `timestamptz`, all UTC; `chrono`. | Rails used `timestamp` without tz. |
| Errors | `shared/error.rs`: `DomainError` (NotFound, Invalid{message}, Conflict, Precondition{reason, meta}) → mapped to tonic `Status` / HTTP status only at the edge. | |
| Pi | `tokio::process::Command` `env_clear()`, argv vec, `kill_on_drop`; SIGTERM via `nix` then SIGKILL after 3s. | |

## Spec index (execute in order; each ends runnable + tested)

| # | Spec | Delivers |
|---|---|---|
| 0002 | backend-skeleton | Cargo project, config, errors, tracing, axum+tonic one port, `/up`, sqlx pool + migrate runner, `flake.nix` (`web`, `test`, `reset`), CI-style `cargo test` |
| 0003 | api-contract | all `.proto` files + codegen; every service compiled, handlers return `UNIMPLEMENTED` |
| 0004 | database-schema | migrations for all tables (domain, `events`, `jobs`), crypto adapter, repository ports skeleton |
| 0005 | model-and-tool-catalog | gateways, refresher, tool seed, `CatalogService`, maintenance job hook |
| 0006 | workflow-design | Workflow aggregate, all editor mutations, validator, lifecycle, schedule, snapshot, `WorkflowService` |
| 0007 | yaml-definition | schema route, parser, applier, exporter, importer, layout, `DefinitionService`, sample workflow seed |
| 0008 | run-engine | runs domain + application, job queue + worker, events + NOTIFY, `RunService`, download/preview HTTP; step runner behind a port (fake adapter) |
| 0009 | pi-agent-runner | Pi adapter, output format validator, session transcript, redactor |
| 0010 | scheduling | minute dispatcher, locking, idempotency, needs_attention |
| 0011 | live-updates | `PgListener` → `LiveService.WatchWorkflow` stream, progress snapshots |
| 0012 | hardening-deploy-cutover | architecture test, graceful shutdown, Containerfile, `nix run .#deploy`, parity audit vs Rails, cutover runbook |

## Definition of done (epic)

- Parity table above: every row checked against Rails behaviour by a test or a documented manual check (0012).
- `nix run .#web` starts Postgres, migrates, serves gRPC-Web + HTTP on `:3000`, starts the worker and the minute scheduler; Ctrl-C stops everything.
- `nix run .#test` runs unit + integration tests green on a fresh cluster.
- Architecture test passes (no forbidden imports in domain/application).
- Rails workflows importable via YAML export → `DefinitionService.ImportWorkflow`.

## Conventions for all specs

- Each spec: Goal, Depends on, Scope, Design, Tasks (`step → verify`), Acceptance, Out of scope.
- Tests first for domain logic; port Rails spec cases (`../glyph/spec/domain/**`) as the minimum test set.
- Keep Rails wording for user-facing messages (validator issues, errors, skip reasons) verbatim so the frontend epic can reuse copy.
- Commit per task. Commit messages: `feat(0006): add step mutations` style.

## Risks / assumptions

- **Assumption**: fresh database; no run-history migration (see non-goals). Confirm before cutover.
- **Assumption**: single deployment process runs server + worker + scheduler; `GLYPH_WORKER_ENABLED` flag allows splitting later.
- gRPC-Web only supports unary + server-streaming — sufficient (no client streaming needed).
- Pi CLI contract (`--print --mode json …`) verified against Pi 0.83 in Rails; re-verify against the `pi-coding-agent` nixpkgs version during 0009.
- YAML line-number fidelity depends on the marked parser crate; fallback is `line = null` for a pointer (parser already tolerates that).
