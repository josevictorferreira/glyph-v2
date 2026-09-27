# 0008 — Run engine: runs, step runs, dispatch, jobs, events

## Goal

Port `Execution::{RunCreator, WorkflowExecutor, StepDispatcher, RunFinalizer, RunStop, StepRetry, StepRunExecutor}`, `Workflows::{InputResolver, WorkflowValues}`, the three execution jobs, `Glyph::EventStore::{Publisher,Subscriptions,Handlers::EnqueueWorkflowRunJob}`, `WorkflowRunsController` (create/show/destroy/stop/retry_step/download/preview). Agent execution sits behind a `StepRunner` port with a **fake adapter**; the real Pi adapter is 0009.

## Depends on

0006 (aggregate, validator, snapshot). 0005 (tools for snapshot).

## Rails behaviour to preserve

**RunCreator** (`create_run(workflow, trigger, supplied_values: map name→string, draft_test, occurrence_key)`):
- issues = validator ∪ missing-value issues (`required && ask_at_run_time && no supplied && no stored value` → `Issue{error, workflow_input, id, value, "Provide a value for “{name}” to start the run."}`); blocking → not created.
- tx: snapshot → insert run (`queued`, `queued_at=now`, snapshot, supplied_values (encrypted), occurrence key) → one step_run per snapshot step (`queued`, copies kind/allow_failure/prompt/context/model_id/model_settings/enabled_tools/expected_output/format/output_name/position/name, `queued_at`) → `workflow.last_run_at/last_run_status` → events `StepRunQueued` ×N then `WorkflowRunQueued{trigger, draft_test}` on `WorkflowRun${id}` (correlation = run id) → **enqueue job `execute_workflow_run{run_id}` in the same tx** (Rails did it after commit via subscription; outbox is equivalent and safer).
- Manual trigger (`StartRun`): `draft_test = workflow.status == draft`; values keyed by input name (controller mapped ids→names; proto sends names). Missing required → `FAILED_PRECONDITION reason=MISSING_VALUES` + issues (Rails redirected to the sheet).

**WorkflowExecutor** (job `execute_workflow_run`): CAS `queued→running` (`started_at`), else return; event `WorkflowRunStarted`; `dispatch_ready`; `finalize_attempt`.

**StepDispatcher**:
- `dispatch_ready(run)`: dag from snapshot; `completed` = succeeded ∪ (failed ∧ allow_failure); `inflight` = status ≠ queued; for each ready id with a queued step_run → enqueue `execute_step_run{step_run_id}`.
- `after_step_finished(step_run)`: run terminal → return. failed ∧ ¬allow_failure → `fail_fast` ? cancel remaining (queued|running, ≠ failed one → `cancelled`, `ended_at`, event `StepRunCancelled{reason:"Cancelled because “{name}” failed."}`) : skip transitive queued descendants (`skipped`, `ended_at`, `skipped_reason = "Did not run because “{name}” did not complete."`, event `StepRunSkipped{reason}`). succeeded ∨ failed → `dispatch_ready`. Then `finalize_attempt`.

**RunFinalizer** (`attempt`): under run lock (`SELECT … FOR UPDATE`), reload; skip if terminal / no step runs / any non-terminal. failed = failed ∧ ¬allow_failure; first by `started_at ?? created_at`; failed → `status=failed`, `failure_summary = "The {step_name} step could not complete: {human_error}"`, `first_failed_step_run_id`, event `WorkflowRunFailed{reason}`; else `succeeded`, event `WorkflowRunSucceeded`. `elapsed_ms` from `started_at ?? queued_at ?? created_at`. Update `workflow.last_run_at/last_run_status`.

**RunStop**: not live → `Precondition("The run has already finished.")`; under lock re-check (`"The run is no longer running."`); `cancelled`, `ended_at`, `elapsed_ms`; queued step runs → `skipped` (`"Cancelled by user."`, events); running steps left to finish; event `WorkflowRunCancelled`. Later `after_step_finished` on a cancelled run returns early (terminal) and executor never overwrites a `cancelled` step (see CAS below).

**StepRetry**: step not found (`"Step run not found."`), not failed (`"Only failed steps can be retried."`), run not terminal (`"The run must be finished before retrying a step."`). Under lock: revive run (`running`, clear ended/elapsed/failure/first_failed), reset the failed step to queued (clear all evidence fields, CAS on `failed`), reset skipped|cancelled transitive descendants to queued, events `StepRunQueued` for step + queued descendants; then `dispatch_ready`.

**StepRunExecutor** (job `execute_step_run`): load; terminal → return; CAS `queued→running` (`started_at`) else return; event `StepRunStarted`. Resolve inputs (`InputResolver`) → `MissingRequiredInput` → `skipped` with `"A required input was unavailable: Required input “{n}” has no value"` + event. Persist `resolved_inputs` `{name: {value, source}}`. Helper kind → `output = resolved map`, `succeeded`, `elapsed_ms` (ceil), event. Pi kind → `StepRunner::run(StepRunContext{…}, workflow_values, progress: callback)`; after return **re-read status; only persist if still `running`** (fail-fast may have cancelled it). success → `succeeded` + output_text/output/messages/session_content; else `failed` + human/technical errors + partial evidence; events with `reason = human_error`. Then `after_step_finished`. Progress callback: `session_content = redacted snapshot` + NOTIFY `STEP_RUN_PROGRESS` (0011), errors swallowed with warn.

**InputResolver** (pure over snapshot + step runs): per snapshot input: incoming connection → upstream succeeded ? value = `output ?? output_text` (nil-check, empty object valid), source `{kind: step_output, step_run_id, label: "Output from {name}"}` : nil, `required = required && !(upstream failed && allow_failure)`, label suffix ` (failed — continuing without it)` / ` (unavailable)`; else `workflow_input_id` → `WorkflowValues` entry, source `constant` (`Constant “{n}”`) or `workflow_value` (`Workflow value “{n}”`); else `{kind: none, label: "Not connected"}`. Required && absent → `MissingRequiredInput(name)`.

**WorkflowValues**: snapshot inputs in order; `value = supplied[name] (non-blank) ?? input.value`; source `supplied` / `stored` (ask) / `constant`.

**Jobs / worker**: kinds `execute_workflow_run`, `execute_step_run` (queue `execution`, concurrency `GLYPH_STEP_CONCURRENCY`=5), `refresh_models` (queue `maintenance`, 1), later `dispatch_due_workflows` (0010). Worker: poll loop (1s idle backoff) `UPDATE jobs … FOR UPDATE SKIP LOCKED … RETURNING`; run handler; set `finished_at` (+`error` on Err). **No retry.** Job handlers are idempotent by CAS. `locked_by = hostname:pid`. Graceful shutdown waits for in-flight handlers (Pi timeout ≤ 15 min → cap wait at `GLYPH_SHUTDOWN_GRACE`, default 30s, then abort; a step left `running` is diagnostic, like Rails).

**Events**: `DomainEvent{event_type, stream, correlation_id, data: json}` appended in the same tx by repositories; NOTIFY `glyph_events` with `{type, workflow_id, run_id?, step_run_id?}` (payload < 8000 bytes) in the same tx.

**Download** (`GET /workflows/{wid}/runs/{rid}/step_runs/{sid}/download`): helper → `output` pretty JSON, `application/json; charset=utf-8`, filename `{safe(output_name)}.json`; pi → requires `succeeded` && `output_text`; zip → base64 strict decode (invalid → 404); mime/extension from format table; `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`. `safe_filename`: strip `/`/`\` → `_`, drop non-printable, trim, empty → `output`.
**Preview**: `succeeded` && format html && output_text; `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:`, nosniff, inline `text/html; charset=utf-8`.
**DeleteRun**: cascade (deferred FK handles `first_failed_step_run_id`).

## Design

```
features/runs/
├── mod.rs
├── domain/
│   ├── run.rs, step_run.rs        // structs + status enums + terminal()/live() + CAS patch types
│   ├── input_resolver.rs, workflow_values.rs
│   ├── output_format.rs           // OutputFileFormat table: label/extension/mime (validation itself in 0009)
│   └── events.rs
├── application/
│   ├── create_run.rs, start_run.rs (manual), execute_run.rs, execute_step.rs, dispatch.rs, finalize.rs, stop_run.rs, retry_step.rs, delete_run.rs, queries.rs
├── ports/
│   ├── repository.rs (0004), job_queue.rs (0004)
│   └── step_runner.rs   // trait StepRunner { async fn run(&self, ctx: StepRunContext, values: &WorkflowValuesMap, progress: ProgressSink) -> StepRunOutcome }
│                        // StepRunOutcome { status: Success|ModelError|Timeout|ExitError|MalformedOutput|InternalError, output_text, output_json, messages, session_content, usage, exit_status, human_error, technical_error, elapsed_ms }
├── grpc/mod.rs           // RunService
└── http/{download.rs, preview.rs}
infrastructure/postgres/{runs_repo.rs, jobs.rs}
infrastructure/jobs/worker.rs      // generic worker: registry kind -> handler, concurrency per queue, shutdown token
infrastructure/fake_runner.rs      // FakeStepRunner: scripted outcomes keyed by prompt marker (tests + dev without Pi)
```
Job handlers are closures built in bootstrap capturing application services (`execute_run`, `execute_step`). Config: `step_concurrency`, `worker_enabled`, `shutdown_grace`.

## Tasks

1. Domain types + `InputResolver` + `WorkflowValues` + `OutputFileFormat` table → verify: port `input_resolver_spec.rb`, `workflow_values_spec.rb` (pure).
2. `runs_repo.rs` (+ CAS updates, locks, encrypted fields) and `jobs.rs` (enqueue in tx, claim with SKIP LOCKED, finish) → verify: `#[sqlx::test]` CAS returns 0 rows on wrong from-status; two concurrent claims never get the same job.
3. Worker loop with concurrency + shutdown → verify: test with fake handlers: 10 jobs, max 5 in flight; shutdown waits for in-flight.
4. `create_run` + `start_run` + `RunService.StartRun` → verify: port `run_creator_spec.rb`, `requests/workflow_runs_spec.rb#create` (draft test flag, missing values precondition, job enqueued in tx — rollback test shows no job).
5. `execute_run`, `dispatch`, `finalize`, `execute_step` with `FakeStepRunner` → verify: port `engine_spec.rb` end-to-end through the real worker: linear, diamond (parallel branches), failed step skips descendants only, allow_failure unblocks with unavailable input, fail_fast cancels running/queued, helper step output, missing required input skips, cancelled step not overwritten by late runner result.
6. `stop_run`, `retry_step`, `delete_run` → verify: port `run_stop_spec.rb`, `step_retry_spec.rb`; delete with `first_failed_step_run_id` set.
7. `RunService` remaining RPCs + `GetStepRun` (transcript filled by 0009; empty until then) → verify: gRPC tests; `ListRuns` newest first; supplied values decrypted.
8. HTTP download/preview → verify: port `requests/workflow_runs_spec.rb#{download,preview}` (helper json, zip decode, invalid base64 404, CSP header, nosniff, filename sanitising).
9. Events + NOTIFY on every transition → verify: test collects `events` rows per scenario and asserts the Rails sequence (`StepRunQueued…WorkflowRunQueued`, `…Started`, `…Succeeded`).

## Acceptance

- With `FakeStepRunner` (`GLYPH_STEP_RUNNER=fake`), `nix run .#web` + grpcurl: `StartRun` on a 3-step diamond completes `SUCCEEDED` with outputs flowing into resolved inputs; stop/retry work live.
- No job row is ever executed twice (assert `finished_at` set once; CAS guards).

## Out of scope

Real Pi execution, redaction, output validation, transcript (0009); scheduled trigger (0010); watch stream (0011).
