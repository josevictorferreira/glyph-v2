# 0011 — Live updates (`LiveService.WatchWorkflow`)

## Goal

Replace Action Cable / `RunBroadcaster` / `BroadcastRunUpdateJob` / the executor progress broadcast with a server-streaming gRPC subscription driven by Postgres `LISTEN/NOTIFY`.

## Depends on

0008 (NOTIFY emitted on every run/step transition), 0006 (workflow mutations NOTIFY `WORKFLOW_UPDATED`).

## Rails behaviour to preserve

- Pages subscribed to `workflow_{id}` receive updates on every run lifecycle event (`WorkflowRun{Queued,Started,Succeeded,Failed,Cancelled}`, `StepRun{Queued,Started,Succeeded,Failed,Skipped}`, plus `StepRunCancelled` which Rails omitted — include it) and on step progress (session content snapshot every ≥3s).
- Broadcast failures never affect the run.
- Broadcasts replace content only; here the client re-fetches (`GetRun`, `GetStepRun`, `ListRuns`, `GetWorkflow`) on event — documented in proto comments.

## Design

```
features/live/
├── mod.rs
├── domain.rs           // LiveEvent { kind, workflow_id, run_id?, step_run_id?, occurred_at } + serde for the NOTIFY payload (shared with emitters in 0006/0008)
├── ports.rs            // trait LiveBus { fn subscribe(&self) -> broadcast::Receiver<LiveEvent> }
└── grpc/mod.rs         // WatchWorkflow: filter by workflow_id, map to proto, ReceiverStream; on Lagged → emit RESYNC and continue
infrastructure/postgres/listener.rs   // PgListener on channel `glyph_events`; single task; parses payload → broadcast::Sender<LiveEvent> (capacity 1024); reconnects with backoff; on reconnect emits RESYNC to all
```
- Emitters (repositories in 0006/0008) call `NOTIFY glyph_events, $payload` inside the transaction via `pg_notify($1,$2)`; payload JSON < 8 KB (ids only).
- Progress: `execute_step` progress sink writes `session_content` and `pg_notify` `STEP_RUN_PROGRESS` in its own short transaction (throttled ≥3s by the runner already).
- Stream termination: client disconnect drops the receiver; server shutdown closes the sender → streams end cleanly.
- Keep-alive: tonic `http2_keepalive_interval` 30s; for gRPC-Web (h1) send a `RESYNC`-free heartbeat? No: gRPC-Web streams over h1 stay open without app-level pings behind most proxies; add optional `GLYPH_LIVE_HEARTBEAT_SECONDS` sending `EventType::HEARTBEAT` (add to enum in 0003 now to avoid a breaking change later).

## Tasks

1. Add `HEARTBEAT` to `EventType` (0003 proto) → verify: `buf breaking` passes (additive).
2. `LiveEvent` payload type used by 0006/0008 emitters (refactor their ad-hoc JSON to this type) → verify: existing NOTIFY tests assert the typed payload.
3. `PgListener` task + `LiveBus` → verify: `#[sqlx::test]`: insert via repo → event received; kill connection (`pg_terminate_backend`) → reconnect + `RESYNC`.
4. `WatchWorkflow` → verify: gRPC-Web streaming integration test: start run with `FakeStepRunner`, collect stream until `RUN_SUCCEEDED`; sequence contains `RUN_QUEUED, STEP_RUN_QUEUED…, RUN_STARTED, STEP_RUN_STARTED, STEP_RUN_PROGRESS*, STEP_RUN_SUCCEEDED, RUN_SUCCEEDED`; events for another workflow filtered out; lag → `RESYNC`.
5. Heartbeat + keepalive config → verify: stream idle 2×interval receives heartbeats.

## Acceptance

- `grpcurl -plaintext -d '{"workflow_id":"…"}' localhost:3000 glyph.v1.LiveService/WatchWorkflow` prints events live while a run executes under `nix run .#web`.
- A failing/slow subscriber never delays a run (broadcast channel is non-blocking; test asserts run completes with zero subscribers draining).

## Out of scope

Pushing full state; per-user auth on streams.
