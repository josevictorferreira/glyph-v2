# Parity audit — Rails `../glyph` → Rust `backend/`

Each row of the 0001 inventory, with the tests (in `backend/`) that prove it. Test names are `file::function`; `lib::…` are unit tests under `src/`.

| Area | Rails behaviour | Evidence |
|---|---|---|
| Health | `GET /up` 200 | `tests/server.rs::up_returns_ok`, `native_grpc_health_is_serving`, `grpc_web_request_is_accepted` |
| Catalog | velox/omniroute `/models`, capabilities, `available`, stale TTL, tool seed, 5-min refresh, vanished model → `needs_attention` | `tests/catalog.rs` (all), `tests/schema.rs::migrations_are_idempotent` (4 tools), `tests/workflows.rs::vanished_models_flag_active_workflows`, `tests/scheduling.rs::recurring_ticks_dedupe` (recurring mechanism), `lib::catalog::domain::tests` |
| Workflows list | ILIKE name/description, status filter, `updated_at desc`, limit 100 | `tests/workflows.rs::create_get_update_list` |
| Workflow CRUD | blank name → "Untitled workflow", update, `WorkflowCreated/Updated` | `tests/workflows.rs::create_get_update_list`, `lib::workflows::domain::tests::create_defaults_the_name` |
| Steps | add pi/helper (slot or clamped position), duplicate, details/prompt/output/model/tools, delete (+downstream inputs), move | `tests/workflows.rs::steps_and_events`, `inputs_connections_and_deletion`; `lib::workflows::domain::tests::{add_step_positions, duplicate_step, output_rename_propagates_to_connections, update_step_model, toggle_step_tool, delete_step_removes_downstream_inputs_and_own_edges, move_step_clamps}` |
| Step inputs | add/remove/map, case-insensitive uniqueness | `tests/workflows.rs::inputs_connections_and_deletion`, `lib::…::step_inputs`, `tests/schema.rs::step_input_names_are_unique_case_insensitively` |
| Workflow inputs | name regex, required constant needs value, remove unmaps + drops schedule values | `lib::…::{workflow_input_validation_messages, remove_workflow_input_unmaps_and_drops_schedule_values}`, `tests/workflows.rs::inputs_connections_and_deletion` |
| Connections | self-edge, cycle, missing output, replace flow, remove deletes input, rename propagates | `lib::…::{create_connection_guards, connect_output_to_step_creates_an_optional_input, remove_connection_deletes_the_destination_input}`, `tests/workflows.rs::inputs_connections_and_deletion` (FAILED_PRECONDITION detail) |
| Validator | every check, identical messages | `lib::workflows::domain::tests` (17 validator cases ported from `validator_spec.rb`) |
| Lifecycle | activate / pause / resume / revalidate → `needs_attention` | `lib::…::{activation, activation_refuses_invalid_workflows, pause_clears_next_run_and_keeps_recurrence, resume, revalidation}`, `tests/workflows.rs::schedule_and_lifecycle` |
| Schedule | builder → cron, IANA tz, descriptions, DST-safe `next_run_at`, enabled only when not draft, per-input values | `lib::workflows::domain::schedule_calculator::tests` (incl. New York spring-forward, London fall-back), `lib::…::save_schedule`, `tests/workflows.rs::schedule_and_lifecycle` |
| Snapshot | v3 shape incl. resolved tools | `lib::…::snapshot_captures_everything`, `tests/runs.rs::snapshot_is_immutable` |
| YAML | schema route, parser (limits, safe load, line numbers, references), applier (fingerprint, upsert, layout), exporter, importer | `lib::definition::domain::{yaml,schema,emit,layout}::tests`, `lib::definition::domain::tests` (parser/exporter/applier/round-trip ports), `tests/definition.rs` |
| Runs | RunCreator, executor, dispatcher (ready set, skip descendants, fail-fast cancel), finalizer, stop, retry, input resolver, workflow values, helpers, draft tests, delete | `tests/runs.rs` (15 end-to-end scenarios through the real worker), `lib::runs::domain::{engine,input_resolver,workflow_values}::tests` |
| Evidence | encrypted at rest | `tests/runs.rs::{helpers_fan_out_values_without_pi, downloads_and_preview}` (raw bytea checks), `tests/workflows.rs::schedule_and_lifecycle` (schedule values), `lib::infrastructure::crypto` |
| Downloads | md/html/json/zip (base64 → bytes), helper pretty JSON, safe filename, nosniff, preview CSP | `tests/runs.rs::{downloads_and_preview, helpers_fan_out_values_without_pi}`, `lib::runs::http::tests::filenames` |
| Pi | argv-only, scrubbed env, temp HOME + models.json, `@prompt`, NDJSON outcomes, SIGTERM→SIGKILL, progress, output validation, transcript | `tests/pi_contract.rs` (the real Pi 0.83.0 CLI against a local OpenAI-compatible mock), `tests/pi_runner.rs` (9, against `tests/fixtures/fake_pi.sh`), `tests/runs.rs::engine_runs_real_pi_runner_without_leaking_keys`, `lib::runs::domain::{pi_events,prompt,output_format_validator,session_transcript}::tests` |
| Redaction | secret env values + `sk-…`/`Bearer …` before persist/log/publish | `lib::shared::redactor::tests`, `tests/pi_runner.rs::secrets_are_redacted`, `tests/catalog.rs::api_key_never_reaches_trace_logs`, `tests/runs.rs::engine_runs_real_pi_runner_without_leaking_keys` |
| Scheduling | minute dispatcher, `FOR UPDATE`, occurrence key, advance, needs_attention | `tests/scheduling.rs` (incl. 100-iteration concurrent dispatchers) |
| Jobs | queues, step concurrency, no retries | `tests/worker.rs` (concurrency cap, one claim per job, errors recorded not retried, shutdown drain/abandon) |
| Events | appended in the mutating tx, `Workflow$id` / `WorkflowRun$id`, correlation id | `tests/runs.rs::linear_chain_passes_output_downstream` (sequence + correlation), `tests/workflows.rs` (event types per mutation) |
| Live updates | run/step lifecycle + progress to workflow subscribers | `tests/live.rs` (listener, reconnect RESYNC, full run sequence, filtering, lag, heartbeat, gRPC-Web stream) |
| Seeds | tool catalog; "Design POC Tournament" | `tests/schema.rs::migrations_are_idempotent`, `tests/definition.rs::tournament_seed_imports_and_validates` |
| Ops | image, deploy, graceful shutdown, tracing | `tests/shutdown.rs` (real binary + SIGTERM), `nix build .#image` (manual check below), `tests/architecture.rs` |

Contract completeness: `tests/contract.rs::every_rpc_is_routed` walks the descriptor set and asserts no RPC answers `UNIMPLEMENTED`.

## Manual checks

| Check | Command | Result |
|---|---|---|
| Dev stack | `nix run .#web`, `curl localhost:3000/up`, `grpcurl -plaintext localhost:3000 list` | see `cutover.md` §Verification log |
| Real Pi | real CLI through the full stack against a local mock (done); against velox/omniroute pending network access | see `cutover.md` §Verification log |
| Image | `nix build .#image && podman load < result` | see `cutover.md` §Verification log |
| Rails YAML import | Rails `GET /workflows/:id/definition` → `DefinitionService.ImportWorkflow` | `full.yml` (Rails-authored fixture) imports in `tests/definition.rs`; exports from the live Rails DB are a cutover step |
| Deploy | `nix run .#deploy` | not run (only on explicit request) |

## Intentional differences from Rails

Runtime semantics
- **Outbox instead of after-commit**: execution jobs are inserted in the transaction that queues the run (Rails enqueued after commit through an event subscription). Same effect, no lost jobs on crash.
- **Editor mutations lock the workflow row** (`SELECT … FOR UPDATE`) for their read-modify-write; Rails was last-write-wins.
- **`fail_fast` is recorded in the run snapshot.** Rails read `snapshot.workflow.fail_fast`, which its snapshot builder never wrote, so fail-fast never took effect.
- **Dispatch + finalize happen in one transaction under the run lock** after each step (Rails: separate calls, finalize locked).
- **Model lookups accept full ids** (`provider/model`) for capability checks and for flagging vanished models. Rails looked up capabilities and vanished ids by bare `model_id`, so full-id steps always failed the temperature check and were never flagged.
- **`StepRunCancelled` and a new `WorkflowRunDeleted` are live events.**
- **Deferred FK** for `first_failed_step_run_id` replaces the `before_destroy` hack.
- `elapsed_ms` is truncated to whole milliseconds (Rails rounded).

Editor / API
- Errors are gRPC statuses: user-fixable input → `INVALID_ARGUMENT` with the Rails copy; confirmations (`CONNECTION_SOURCE_EXISTS`), activation, `StartRun` (`VALIDATION_FAILED`/`MISSING_VALUES`), stop/retry → `FAILED_PRECONDITION` + `google.rpc.ErrorInfo` (+ `ValidationIssues`). Rails redirected or set a flash.
- Unknown ids answer `NOT_FOUND` where Rails silently no-oped (duplicate/remove missing step or input, remove missing connection).
- `SaveSchedule` adds a raw `Cron{expression}` recurrence.
- `ConnectOutputToStep` rejects a cycle or a duplicate input name (Rails created the cyclic connection, or raised on the duplicate).
- `SetScheduleValue` without a schedule is `INVALID_ARGUMENT` (Rails no-op).
- `MoveStep` returns the aggregate.
- Empty strings for optional text fields are stored as NULL (both are "blank" in every Rails check).
- The validator's unknown-step-kind check is unreachable: kind is an enum and a DB check constraint.

YAML
- The exporter uses the scalar input shorthand only when it reads back identically (required constant without description) and writes `ask` accurately; Rails' shorthand/`ask: false` could turn an asked input into a constant on re-import.
- The applier's "schedule unchanged" check compares values by input id; Rails compared a name-keyed map to an id-keyed map, so any schedule with values always re-applied.
- Fingerprints hash the route-relative export (`/schemas/workflow.json` header); the downloadable export uses `GLYPH_PUBLIC_URL` when set.
- YAML is read with YAML 1.1-style plain scalar typing (as Psych); `yes/no/on/off` are booleans.

Pi output
- HTML validation extracts the document with the Rails regex; the extra Nokogiri parse is dropped (it always yields a root for a matched document).
- ZIP limits are checked from the central directory (entry count, declared uncompressed size) instead of streaming local headers.

Storage
- Evidence encryption is app-level AES-256-GCM (`nonce ‖ ciphertext ‖ tag`), not ActiveRecord-compatible — run history is not migrated (0001 non-goal).
- Timestamps are `timestamptz` (UTC).
