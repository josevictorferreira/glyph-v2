# 0006 — Workflow design: aggregate, mutations, validation, lifecycle, schedule

## Goal

Port everything under `app/domain/workflows/*` (except `definition/`), the models, the editor mutations in `Components::Workflows::Editor` and `ScheduleValueRow`, and `WorkflowsController#{index,create}`; expose `WorkflowService` fully.

## Depends on

0003, 0004, 0005.

## Rails behaviour to preserve (checklist)

**Listing/CRUD**
- `ListWorkflows`: `name ILIKE %q% OR description ILIKE %q%` (escape `%_\`), optional status, `ORDER BY updated_at DESC LIMIT 100`. Summary includes `schedule_summary` (human description when schedule enabled, else none).
- `CreateWorkflow`: blank name → `"Untitled workflow"`; event `WorkflowCreated`.
- `UpdateWorkflow`: blank name → `Invalid("Unable to save — the workflow needs a name.")`; trims name; event `WorkflowUpdated`; revalidate.

**Steps** (`position = max+1`; canvas clamp x 0..4000, y 0..3000)
- `AddStep(kind)`: default slot `x=120+(count%4)*300`, `y=120+(count/4)*220`; explicit position clamped; `name=""`; event `WorkflowStepAdded{step_id, kind}`.
- `DuplicateStep`: copies kind, name, description, prompt, additional_context, allow_failure; **not** model/tools/output/expected_output (Rails omission — keep, note in proto docs); canvas +40/+40; copies inputs (name, description, position) unconnected/unmapped.
- `UpdateStepDetails`: trims name. `UpdateStepPrompt`. `UpdateStepOutput`: trims output_name; if changed → `UPDATE workflow_connections SET source_output_name` for outgoing; unknown format → `free_text_markdown`.
- `UpdateStepModel`: `model_id` empty → null; `temperature` present → must be `0..=2` else `Invalid("Unable to save — temperature must be a number between 0 and 2.")`; absent → remove key from `model_settings`.
- `ToggleStepTool`: key must be an enabled tool else `Invalid("Unable to save — that tool is not available.")`; toggles membership.
- `MoveStep`: no revalidation (Rails `validate: false`); no event.
- `DeleteStep`: destroy downstream inputs fed by its outgoing connections, then the step (cascades its inputs/connections); event `WorkflowStepDeleted`.

**Step inputs**
- `AddStepInput`: blank name → `Invalid("Unable to save — name the input.")`; duplicate (case-insensitive) → Invalid with the DB uniqueness message; event `WorkflowStepUpdated`.
- `RemoveStepInput`: destroys input (+ its incoming connection).
- `MapStepInput(workflow_input_id?)`: unknown id → `Invalid("Unable to save — that workflow value does not exist.")`; event `WorkflowInputMapped{step_input_id, workflow_input_id}`.

**Workflow inputs**
- name regex `^[A-Za-z][A-Za-z0-9_ ]*$` (message: `must start with a letter and use letters, numbers, spaces or underscores`), unique case-insensitive per workflow, `value` required when `required && !ask_at_run_time`; blank name → `"Unable to save — name the workflow value."`.
- Remove: step inputs mapped to it get `workflow_input_id=null`; schedule values deleted; event `WorkflowUpdated{removed_workflow_input_id}`.

**Connections**
- `CreateConnection`: source/input must exist (`"Unable to save — choose an output and an input to connect."`); self (`"… a step cannot connect to itself."`); source without output name (`"… “{name}” has no named output yet."`); input already connected or mapped and `!replace_existing` → `Precondition{code:"CONNECTION_SOURCE_EXISTS", reason:..., meta:{existing_source_label}}`; with `replace_existing` → remove incoming connection and clear mapping first; cycle (`"… that connection would create a cycle."`). Creates with `source_output_name = source.output_name`; event `WorkflowConnectionCreated`.
- `ConnectOutputToStep` (drag output onto card): creates input on target named `source.output_name`, `required=false`, connects; events `WorkflowConnectionCreated` + `WorkflowStepUpdated{target}`.
- `RemoveConnection`: destroys connection **and its destination input**; event `WorkflowConnectionRemoved`.

**Validator** — port every check with identical messages: workflow name/steps; per step: name, output_name, unknown kind, (pi only) prompt, expected_output, model chosen / available (bare id or full id), model settings (only `temperature`, gated by capability), tools enabled; step inputs: two sources / required without source; `{{token}}` regex `\{\{([A-Za-z0-9_ -]+)\}\}` against workflow input names ∪ step input names (pi steps only); constant workflow inputs need value; connections: dangling, self, output name mismatch, cycle; schedule: cron parse, tz known, enabled needs cron+tz, required inputs without value need a schedule value. `Issue{severity, entity_type, entity_id, field, message}`, `blocking = severity == error`.

**Lifecycle**
- `Activate`: blocking issues → `Precondition{code:"VALIDATION_FAILED"}` with issues; else `status=active`, `next_run_at = schedule enabled && configured ? next(cron,tz) : null` (also stored on schedule); event `WorkflowActivated`.
- `Pause`: `status=paused`, `next_run_at=null` on workflow + schedule; event `WorkflowPaused`.
- `Resume`: invalid → `needs_attention`, `next_run_at=null`, event `WorkflowNeedsAttention{issues: first 5 blocking messages}`, response OK with issues; valid → `active`, recompute next run, event `WorkflowResumed`.
- `Revalidate` after every mutation except move/pause: active + blocking → `needs_attention` + event. `needs_attention` never auto-heals.
- `flag_workflows_using_models(ids)` (called by 0005): active workflows with a step using any id → needs_attention + event.

**Schedule**
- Builder → cron: interval minutes `*/{n} * * * *` (1..59), hours `7 */{n} * * *` (1..23), daily `{m} {h} * * *`, weekly `{m} {h} * * {wd}`, monthly `{m} {h} {d} * *` (1..31); else Invalid `"Unable to save — the recurrence or timezone is invalid."`. `Cron{expression}` variant: must parse.
- Human description: `Every {n} {unit}(s) ({tz})`, `Daily at HH:MM ({tz})`, `{Weekday}s at HH:MM ({tz})`, `Monthly on day {d} at HH:MM ({tz})`; raw cron → `"{cron} ({tz})"`.
- `enabled = requested && !draft`; `next_run_at = enabled ? next(cron, tz, from=now) : null` on schedule; workflow `next_run_at = active ? next : null`; event `WorkflowScheduleChanged{mode, cron_expression}`.
- `None` → delete schedule (+values), `workflow.next_run_at=null`, event mode `none`.
- `next(cron, tz, from)`: strictly after `from`, evaluated in `tz`, stored UTC; invalid → null.
- `SetScheduleValue`: upsert encrypted value; revalidate.

**Snapshot** (`SnapshotBuilder`, version 3): exact key set from Rails incl. `captured_at` (RFC3339 µs), `workflow.schedule`, `steps[].enabled_tools` resolved from `tool_definitions`, `steps[].inputs[].workflow_input_name`, `connections[].destination_input_name`. Lives here as `workflows::snapshot::build(&Workflow, &[ToolDefinition]) -> Snapshot` (typed struct, `serde` to jsonb); runs (0008) consume it.

**Events** appended with `actor_id: null` on stream `Workflow${id}`; data = ids only.

## Design

```
features/workflows/
├── mod.rs                  // pub use Workflow, WorkflowService facade, Validator, Issue, snapshot, schedule_calculator, flag_workflows_using_models
├── domain/
│   ├── workflow.rs         // Workflow aggregate (+ Vec<Step>, Vec<WorkflowInput>, Vec<Connection>, Option<Schedule>), mutation methods returning Result<Vec<DomainEvent>, DomainError>
│   ├── step.rs, input.rs, connection.rs, schedule.rs
│   ├── validator.rs        // fn validate(&Workflow, &CatalogView) -> Vec<Issue>
│   ├── schedule_calculator.rs
│   ├── snapshot.rs
│   └── events.rs           // enum WorkflowEvent {...} -> DomainEvent{type, stream, data}
├── application/            // one file per command; each: load aggregate → domain method → revalidate → repo.save(events) → return (Workflow, issues)
│   ├── list.rs, get.rs, create.rs, update.rs, steps.rs, step_inputs.rs, workflow_inputs.rs, connections.rs, schedule.rs, lifecycle.rs, revalidate.rs
├── ports/
│   ├── repository.rs (0004)
│   └── catalog.rs          // CatalogView { available_model_ids: HashSet<String>, capabilities_by_model_id, enabled_tool_keys } + trait CatalogReader { async fn view() }
└── grpc/mod.rs             // WorkflowService: request → command → response mapping; proto<->domain converters in grpc/convert.rs
infrastructure/postgres/workflows_repo.rs
shared/dag.rs               // Dag { adds_cycle, cyclic, root_ids, ready_ids(completed, inflight), transitive_downstream } over &str ids — ported from Workflows::Graph
```

Domain purity: `Workflow` mutation methods take plain values + a `Clock`-provided `now` and return events; no async, no DB. Cycle checks use `shared::dag`. Catalog data passed in as `CatalogView`.

Concurrency: mutations are last-write-wins like Rails (no `lock_version` use). Lifecycle + scheduler use `with_lock`.

## Tasks

1. `shared/dag.rs` → verify: port `spec/domain/workflows/graph_spec.rb` (adds_cycle, cyclic, roots, ready set, transitive downstream).
2. `schedule_calculator.rs` → verify: port `schedule_calculator_spec.rb` + DST cases (America/Sao_Paulo, Europe/London), interval bounds, invalid tz.
3. Domain aggregate + events + validator → verify: port `validator_spec.rb`, `lifecycle_spec.rb`, `snapshot_builder_spec.rb`, `models/core_spec.rb` as pure unit tests.
4. `workflows_repo.rs` (aggregate load/diff-save/list/lock, event append, NOTIFY `glyph_events`) → verify: `#[sqlx::test]` round-trip of a full aggregate; delete-orphans; case-insensitive uniqueness surfaces as `Invalid`.
5. Application commands (all RPC rows) → verify: port `spec/components/workflows/editor_spec.rb` scenarios as application-level tests against the DB (each mutation: state, event types, issues, error message).
6. gRPC service + converters → verify: integration tests for every RPC incl. `FAILED_PRECONDITION` detail on connection replace and activation.
7. `flag_workflows_using_models` wired into 0005's job → verify: test refresh marks affected active workflow.

## Acceptance

- Every `Editor` action in Rails has a passing gRPC test with the same outcome and message.
- `nix run .#web` + `grpcurl`: create workflow → add 2 steps → connect → activate → `GetWorkflow` shows `ACTIVE`, `next_run_at` when scheduled.

## Out of scope

YAML (0007), runs (0008), scheduler tick (0010).
