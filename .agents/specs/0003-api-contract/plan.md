# 0003 — gRPC API contract (`proto/`)

## Goal

Define the complete typed contract between backend and frontend up front, generate Rust code, and register every service with `UNIMPLEMENTED` handlers. Frontend work can start against this contract after this spec.

## Depends on

0002.

## Scope

- `proto/glyph/v1/{common,catalog,workflow,definition,run,live}.proto`, `proto/buf.yaml`, `proto/buf.gen.yaml` (TS generation config, used by the frontend epic).
- `backend/build.rs` (`protox` → `tonic-build`), generated module `backend/src/proto.rs` (`pub mod glyph { pub mod v1 { tonic::include_proto!("glyph.v1"); } }`).
- Stub service impls in `features/*/grpc/mod.rs` returning `Status::unimplemented`, registered in bootstrap, wrapped with `tonic-web`.
- Descriptor set embedded for gRPC reflection (`tonic-reflection`) so `grpcurl` works in dev.

## Design principles

- Messages mirror the Rails domain 1:1; the frontend must never need JSON blobs. The only opaque field is `StepRun.output_json` (arbitrary JSON produced by the agent) carried as `google.protobuf.Value`.
- IDs are `string` UUIDs. Times are `google.protobuf.Timestamp` (UTC). Optional scalars use `optional`.
- Every workflow mutation returns the full `Workflow` aggregate + validation `issues` (Rails re-validates after each edit and re-renders).
- Errors: gRPC status codes. `INVALID_ARGUMENT` for user-fixable input, `FAILED_PRECONDITION` with `google.rpc.ErrorInfo{reason, metadata}` (via `tonic-types`) for flows the UI must confirm (e.g. replacing a connection), `NOT_FOUND`, `ABORTED` for fingerprint conflicts.
- Confirmation modals (delete step, remove input, pause…) are frontend concerns; backend exposes the final operation only.

## Contract

### common.proto

```proto
enum WorkflowStatus { WORKFLOW_STATUS_UNSPECIFIED=0; DRAFT=1; ACTIVE=2; PAUSED=3; NEEDS_ATTENTION=4; }
enum StepKind { STEP_KIND_UNSPECIFIED=0; PI=1; HELPER=2; }
enum OutputFileFormat { OUTPUT_FILE_FORMAT_UNSPECIFIED=0; FREE_TEXT_MARKDOWN=1; HTML=2; JSON=3; ZIP=4; }
enum RunStatus { RUN_STATUS_UNSPECIFIED=0; QUEUED=1; RUNNING=2; SUCCEEDED=3; FAILED=4; CANCELLED=5; }
enum StepRunStatus { …; QUEUED; RUNNING; SUCCEEDED; FAILED; SKIPPED; CANCELLED; }
enum RunTrigger { …; MANUAL=1; SCHEDULED=2; }
enum IssueSeverity { …; ERROR=1; }
enum IssueEntityType { …; WORKFLOW; WORKFLOW_STEP; STEP_INPUT; WORKFLOW_INPUT; WORKFLOW_CONNECTION; WORKFLOW_SCHEDULE; }
message Issue { IssueSeverity severity; IssueEntityType entity_type; string entity_id; string field; string message; }
```

### catalog.proto — `CatalogService`

```proto
message AvailableModel { string provider; string model_id; string full_id; string display_name; bool available;
                         map<string,bool> capabilities; google.protobuf.Timestamp fetched_at; }
message ToolDefinition { string key; string display_name; string description; string pi_tool_name; bool enabled; }
rpc ListModels(ListModelsRequest{bool include_unavailable}) returns (ListModelsResponse{repeated AvailableModel models; bool stale});
rpc ListTools(ListToolsRequest{}) returns (ListToolsResponse{repeated ToolDefinition tools});
rpc RefreshModels(RefreshModelsRequest{}) returns (RefreshModelsResponse{repeated ProviderRefreshResult results});  // manual trigger
```

### workflow.proto — `WorkflowService`

Read model:

```proto
message WorkflowSummary { string id; string name; optional string description; WorkflowStatus status; bool fail_fast;
  optional google.protobuf.Timestamp last_run_at; optional RunStatus last_run_status; optional google.protobuf.Timestamp next_run_at;
  optional string schedule_summary; google.protobuf.Timestamp created_at; updated_at; }
message WorkflowInput { string id; string name; optional string description; bool required; bool ask_at_run_time; optional string value; int32 position; }
message StepInput { string id; string name; optional string description; bool required; int32 position;
  optional string workflow_input_id; optional string incoming_connection_id; }
message Step { string id; StepKind kind; string name; optional string description; optional string prompt; optional string additional_context;
  optional string expected_output; optional string output_name; optional string output_description; OutputFileFormat output_file_format;
  optional string model_id; optional double temperature; repeated string enabled_tool_keys; bool allow_failure;
  int32 canvas_x; int32 canvas_y; int32 position; repeated StepInput inputs; bool configured; }
message Connection { string id; string source_step_id; string source_output_name; string destination_step_id; string destination_input_id; }
message ScheduleValue { string workflow_input_id; string value; }
message Schedule { string id; bool enabled; optional string cron_expression; optional string timezone; optional string human_description;
  optional google.protobuf.Timestamp next_run_at; optional google.protobuf.Timestamp last_dispatched_at; repeated ScheduleValue values; }
message Workflow { WorkflowSummary summary; repeated WorkflowInput inputs; repeated Step steps; repeated Connection connections; optional Schedule schedule; }
message WorkflowMutationResponse { Workflow workflow; repeated Issue issues; }
```

RPCs (one per Rails editor action; request fields = Rails params):

```
ListWorkflows(query, optional status, limit≤100) → repeated WorkflowSummary
GetWorkflow(id) → Workflow + issues
CreateWorkflow(name, description, fail_fast) → Workflow
UpdateWorkflow(id, name, description, fail_fast) → Mutation
ValidateWorkflow(id) → issues
AddStep(workflow_id, kind, optional canvas_x, optional canvas_y) → Mutation (+ new_step_id)
DuplicateStep(workflow_id, step_id) → Mutation (+ new_step_id)
UpdateStepDetails(workflow_id, step_id, name, description, allow_failure) → Mutation
UpdateStepPrompt(workflow_id, step_id, prompt, additional_context) → Mutation
UpdateStepOutput(workflow_id, step_id, output_name, output_description, expected_output, output_file_format) → Mutation
UpdateStepModel(workflow_id, step_id, model_id, optional temperature) → Mutation
ToggleStepTool(workflow_id, step_id, tool_key) → Mutation
MoveStep(workflow_id, step_id, canvas_x, canvas_y) → Mutation
DeleteStep(workflow_id, step_id) → Mutation
AddStepInput(workflow_id, step_id, name, required) → Mutation
RemoveStepInput(workflow_id, input_id) → Mutation
MapStepInput(workflow_id, input_id, optional workflow_input_id) → Mutation
AddWorkflowInput(workflow_id, name, description, required, value, ask_at_run_time) → Mutation
UpdateWorkflowInput(workflow_id, input_id, …same) → Mutation
RemoveWorkflowInput(workflow_id, input_id) → Mutation
CreateConnection(workflow_id, source_step_id, destination_input_id, replace_existing) → Mutation
ConnectOutputToStep(workflow_id, source_step_id, target_step_id) → Mutation   // Rails drag_output_to_step: creates input named after output
RemoveConnection(workflow_id, connection_id) → Mutation
SaveSchedule(workflow_id, oneof recurrence { None none; Interval{every,unit MINUTES|HOURS}; Daily{hour,minute}; Weekly{weekday,hour,minute}; Monthly{day,hour,minute}; Cron{expression} }, timezone, enabled) → Mutation
SetScheduleValue(workflow_id, workflow_input_id, value) → Mutation
ActivateWorkflow(id) → Mutation   // FAILED_PRECONDITION reason=VALIDATION_FAILED when blocking issues; issues in response detail
PauseWorkflow(id) → Mutation
ResumeWorkflow(id) → Mutation     // becomes NEEDS_ATTENTION when invalid; still OK response with issues
```

### definition.proto — `DefinitionService`

```
ExportDefinition(workflow_id) → { string yaml; string fingerprint; string filename; }
GetSchemaUrl() → { string url }   // "/schemas/workflow.json" (also plain HTTP)
ParseDefinition(optional workflow_id, yaml) → { repeated DefinitionError errors }   // dry run
ApplyDefinition(workflow_id, yaml, fingerprint) → { Workflow workflow; repeated Issue issues; string new_fingerprint } | ABORTED on stale fingerprint | INVALID_ARGUMENT with errors detail
ImportWorkflow(yaml) → { Workflow workflow } | INVALID_ARGUMENT with errors
message DefinitionError { string path; optional int32 line; string message; }
```

### run.proto — `RunService`

```proto
message RunSnapshot { … mirrors Rails snapshot v3: workflow{id,name,description,status,schedule}, inputs[], steps[]{…, enabled_tools[]{key,display_name,pi_tool_name}, inputs[]{…,workflow_input_name}}, connections[]{…,destination_input_name} }
message StepRunSummary { string id; string snapshot_step_id; string step_name; StepKind step_kind; StepRunStatus status; int32 position; bool allow_failure;
  optional Timestamp queued_at; started_at; ended_at; optional int64 elapsed_ms; optional string human_error; optional string skipped_reason;
  optional string output_name; OutputFileFormat output_file_format; bool has_output; }
message ResolvedInput { string name; optional google.protobuf.Value value; InputSource source{ kind NONE|STEP_OUTPUT|WORKFLOW_VALUE|CONSTANT; optional step_run_id; optional workflow_input_id; string label } }
message AgentMessage { string role; string text; int32 tool_calls; optional string stop_reason; optional string error; }
message TranscriptBlock { oneof block { Text text; Thinking thinking; Tool tool{name, summary, state RUNNING|DONE|ERROR} } }
message StepRun { StepRunSummary summary; optional string prompt; optional string additional_context; optional string expected_output;
  optional string model_id; optional double temperature; repeated string enabled_tool_names; repeated ResolvedInput resolved_inputs;
  optional string output_text; optional google.protobuf.Value output_json; repeated AgentMessage messages; repeated TranscriptBlock transcript;
  optional string technical_error; string download_path; optional string preview_path; }
message Run { string id; string workflow_id; RunStatus status; RunTrigger trigger; bool draft_test; optional Timestamp queued_at; started_at; ended_at;
  optional int64 elapsed_ms; optional string failure_summary; optional string first_failed_step_run_id; optional string schedule_occurrence_key;
  map<string,string> supplied_values; RunSnapshot snapshot; repeated StepRunSummary step_runs; Timestamp created_at; }
```

```
StartRun(workflow_id, map<string,string> values /*keyed by input NAME*/) → { Run run } | FAILED_PRECONDITION reason=VALIDATION_FAILED|MISSING_VALUES with issues
ListRuns(workflow_id, limit, optional before) → repeated Run (without step_runs detail; newest first)
GetRun(workflow_id, run_id) → Run
GetStepRun(workflow_id, run_id, step_run_id) → StepRun
StopRun(workflow_id, run_id) → Run | FAILED_PRECONDITION "The run has already finished."
RetryStep(workflow_id, run_id, step_run_id) → Run | FAILED_PRECONDITION with Rails messages
DeleteRun(workflow_id, run_id) → Empty
```
HTTP (not proto): `GET /workflows/{wid}/runs/{rid}/step_runs/{sid}/download`, `…/preview`, `GET /schemas/workflow.json`.

### live.proto — `LiveService`

```proto
message WatchWorkflowRequest { string workflow_id; }
message WorkflowEvent { EventType type; string workflow_id; optional string run_id; optional string step_run_id; Timestamp occurred_at; }
enum EventType { …; WORKFLOW_UPDATED; RUN_QUEUED; RUN_STARTED; RUN_SUCCEEDED; RUN_FAILED; RUN_CANCELLED;
                 STEP_RUN_QUEUED; STEP_RUN_STARTED; STEP_RUN_PROGRESS; STEP_RUN_SUCCEEDED; STEP_RUN_FAILED; STEP_RUN_SKIPPED; STEP_RUN_CANCELLED; RESYNC; }
rpc WatchWorkflow(WatchWorkflowRequest) returns (stream WorkflowEvent);
```

## Tasks

1. Write all `.proto` files + `buf.yaml` (lint: `DEFAULT`, breaking: `FILE`) → verify: `buf lint` clean, `buf build` ok.
2. `build.rs` with `protox::compile` + `tonic_build::configure().file_descriptor_set_path(..).compile_fds` → verify: `cargo build` generates `glyph.v1`.
3. Stub services (`features/{catalog,workflows,definition,runs,live}/grpc/mod.rs`) → verify: each RPC returns `UNIMPLEMENTED` in an integration test using generated clients over an in-process server.
4. `tonic-reflection` registered → verify: `grpcurl -plaintext localhost:3000 list` shows 5 services + health.
5. Document in `proto/README.md`: how to regenerate TS (`buf generate`), compatibility rules (`buf breaking` in `nix run .#check`).

## Acceptance

- `nix run .#check` runs `buf lint` + `buf breaking --against .git#branch=main` + cargo checks.
- Every RPC listed above exists in generated code and is reachable (unimplemented).

## Out of scope

Handler logic (0005–0011). Frontend codegen execution.
