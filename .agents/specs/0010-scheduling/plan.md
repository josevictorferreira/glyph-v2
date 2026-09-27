# 0010 — Scheduled dispatch

## Goal

Port `Execution::ScheduleDispatcher`, `DispatchDueWorkflowsJob` and the `recurring.yml` minute tick. Concurrency-critical: duplicate dispatchers must never create two runs for one occurrence.

## Depends on

0008.

## Rails behaviour to preserve

- Tick every minute (`every minute`), queue `scheduling`. Also `refresh_models` every 5 minutes (0005) moves onto the same recurring mechanism.
- `dispatch(now)`: select due workflows = `status='active' AND schedule.enabled AND schedule.next_run_at <= now`; for each, under `SELECT … FOR UPDATE` on the workflow row: re-check (schedule enabled, `next_run_at <= now`, workflow active); validate → blocking issues → `needs_attention`, `next_run_at=null`, event `WorkflowNeedsAttention{issues: first 5 blocking}`; return false. Else `occurrence_key = "{workflow_id}:{next_run_at.utc RFC3339 seconds}"`, `values = schedule values by input name`, `create_run(trigger=scheduled, values, occurrence_key)`; not created → false; else `next = next_run_at(cron, tz, from=now)`, `schedule.next_run_at=next, last_dispatched_at=now`, `workflow.next_run_at=next`; true.
- Unique violation on `schedule_occurrence_key` → treat as already dispatched, continue. Any other error → log, continue with next workflow. Return dispatched count.

## Design

```
features/scheduling/
├── mod.rs
└── application/dispatch_due.rs   // DispatchDueWorkflows { workflows_repo, runs::create_run, clock } -> usize
infrastructure/jobs/recurring.rs   // Recurring { every, kind } → enqueue job if none pending/running for that kind (dedupe), leader via pg_try_advisory_lock(hash("glyph.recurring")) so multi-replica ticks once
```
Job kinds: `dispatch_due_workflows` (queue `scheduling`, concurrency 1), `refresh_models` (0005). Tick loop is a tokio task in bootstrap gated by `GLYPH_WORKER_ENABLED`.

Locking uses `WorkflowRepository::with_lock` (0006) and `create_run` (0008) inside the same transaction; `create_run` must accept a transaction handle (`&mut Tx`) — adjust 0008 signature if not already.

## Tasks

1. `dispatch_due` → verify: port `schedule_dispatcher_spec.rb`: due workflow dispatched once; not due skipped; paused/draft skipped; invalid → needs_attention + event, no run; `next_run_at` advanced from `now`; values passed by name; `last_dispatched_at` set.
2. Idempotency → verify: two dispatchers run concurrently (`tokio::join!` on two pool connections) for the same due workflow → exactly one run; unique violation swallowed.
3. Recurring ticker + advisory lock → verify: two tickers in test → one job per minute; `tokio::time::pause` advances.
4. Wire job handler + config (`GLYPH_SCHEDULER_ENABLED`, default true) → verify: `nix run .#web`, activate a workflow with `Interval{every:1, unit:MINUTES}` → a `SCHEDULED` run appears within a minute; `next_run_at` advances.

## Acceptance

- Concurrency test (task 2) passes 100 iterations (`--test-threads` stress loop in CI script).
- Occurrence key format identical to Rails (`{uuid}:{YYYY-MM-DDTHH:MM:SSZ}`).

## Out of scope

Catch-up of missed occurrences while the server was down (Rails does not do it: next occurrence is computed from `now`).
