# 0007 — YAML workflow definition (schema, parse, apply, export, import)

## Goal

Port `app/domain/workflows/definition/*` (`Schema`, `Parser`, `Applier`, `Exporter`, `Importer`, `Layout`, `Types`), `SchemasController`, `WorkflowsController#{import,definition}` and `YamlEditor#apply`; expose `DefinitionService` + `GET /schemas/workflow.json`. Also the sample "Design POC Tournament" workflow as an importable YAML.

## Depends on

0006.

## Rails behaviour to preserve

**Schema**: copy `schema.json` verbatim to `backend/src/features/definition/schema.json` (embedded with `include_str!`), served at `/schemas/workflow.json` (`application/schema+json`, `Cache-Control: public, max-age=86400`). Exported YAML header: `# yaml-language-server: $schema={base_url}/schemas/workflow.json`.

**Parser** (`parse(text, existing: Option<&Workflow>) -> Result<Document, Vec<DefinitionError>>`), stages stop at first failing stage:
1. blank → `("/", 1, "The document is empty. Start with a name and one step.")`
2. `> 256 KiB` → `("/", null, "The document is too large (limit 256 KiB).")`
3. YAML load, safe: aliases/anchors/tags → `"Aliases and tags are not allowed."`; syntax → `("/", line, "YAML syntax error: {problem} {context}")`
4. root not a map → `"The document must be a map with name and steps."`
5. JSON Schema (draft 2020-12) errors, each with pointer → line via line index; messages rewritten: required → `Add the required key "{k}".`; additionalProperties → `"{k}" is not a known key here.` (pointer = containing node); propertyNames on helper → `"{k}" is not allowed on a helper step.`; enum → `{v} is not one of: a, b.`; min/max → `temperature must be between 0 and 2.`; pattern → `{v} must start with a letter and use letters, digits, spaces or underscores.`; else the validator's text.
6. Reference checks: name non-blank (`Give the workflow a name.`); constant input without value and `ask` false (`Constant input “{n}” needs a value, or set ask: true.`); duplicate workflow input names (ci); duplicate step names (ci); step `id` must exist in `existing` (`No step with id “{id}” exists in this workflow. Remove the id to create a new step.`), no id → match by name, two existing matches → `The workflow already has two steps named “{n}”. Download the YAML to get their ids.`; input `from` both step & input → `“{f}” is both a step and a workflow input. Rename one of them.`; self-feed → `“{f}” cannot feed itself.`; unknown → `“{f}” is not a step or a workflow input. Check the spelling.`; cycle → `("/steps", null, "The connections form a cycle. Remove the link that closes the loop.")`; schedule cron invalid, tz unknown, values naming non-inputs (`The schedule sets “{n}”, which is not a workflow input.`).
7. Build `Document{name, description, fail_fast, inputs: IndexMap<String, InputDef>, schedule: Option<ScheduleDef>, steps: Vec<StepDef>}`; `defaults` folded into pi steps (model, temperature, tools, format); helper steps get no model/tools/format; `output` defaults to step name; format `markdown` ↔ `free_text_markdown`; input scalar form → constant (`ask=false`, value stringified); object → `ask = ask ?? value.is_none()`.

Line index: walk the YAML node tree once, record `pointer → 1-based line` for every mapping key and sequence item, JSON-pointer escaping (`~0`, `~1`).

**Applier** (`apply(workflow, document, fingerprint: Option<&str>) -> Result<Applied{issues}, ApplyFailure{Conflict | Errors(Vec<DefinitionError>)}>`), one transaction, same order: workflow attrs (event only if changed); delete steps absent from document (by matched id set); inputs upsert by ci-name with positions, remove missing (events `WorkflowInputMapped` on create, `WorkflowUpdated` on change/remove); steps upsert (`update` publishes only on change, output rename propagates to outgoing connections; `create` uses `Layout` for canvas position, event `WorkflowStepAdded`); step inputs upsert by ci-name (positions, `workflow_input_id` from `from` when source is a workflow input; event `WorkflowInputMapped` when mapping changes; `WorkflowStepUpdated` when anything changed); connections: desired set `{(source_step_id, destination_input_id) → output_name}` diffed against existing (destroy → `WorkflowConnectionRemoved`, update output name, create → `WorkflowConnectionCreated`); schedule: absent → destroy + `next_run_at=null` + `WorkflowScheduleChanged{mode:none}`; present → upsert (enabled, cron, tz, description, `next_run_at = enabled && active ? next : null`), replace values by input name, event mode `yaml`; skip when unchanged. Then `Revalidate` → issues. Stale fingerprint → `Conflict` before any change. Record-invalid (uniqueness etc.) → `Errors([{path:null,line:null,message}])`, whole apply rolled back.

**Exporter**: `document_hash` key order: name, description?, fail_fast (only true), defaults?, inputs?, schedule?, steps. Input: scalar shorthand when value set and no description; else object with description?, value?, `required:false`?, `ask:false` unless (value nil && ask). Schedule: cron, timezone, `enabled:false`?, description?, values (by input position). Step: id, name, description?, model?, temperature?, tools?, prompt?, context?, expect?, output (only if ≠ name), output_description?, format (only if ≠ markdown → note: Rails emits the stored word e.g. `html`), `allow_failure:true`?, inputs?. Helper: id, name, kind, inputs. Step input: shorthand `from` string when source && required && no description; else object `from?`, `required:false`?, `description?`. Fold `defaults` when ≥2 pi steps share identical non-nil model/temperature/tools/format. YAML emitted with literal block scalars for multiline strings, no line wrapping, deterministic order. `fingerprint = sha256(export_text)`; filename `{parameterize(name) or "workflow"}.yml`.

**Importer**: parse (no existing) → create workflow (name) + `WorkflowCreated` → apply in same tx; apply failure rolls back everything, returns errors.

**Layout**: `ROOT=(120,120)`, `DX=320`, `DY=220`, clamp `(0..4000, 0..3000)`; place new steps in dependency order (ready-set over name graph, fallback to given order); a step lands right of its rightmost placed upstream, dropping by DY while the slot is occupied.

## Design

```
features/definition/
├── mod.rs
├── schema.json
├── domain/
│   ├── types.rs        // Document, InputDef, StepDef, StepInputDef, Source{Step|WorkflowInput}, ScheduleDef, DefinitionError{path, line, message}
│   ├── parser.rs       // pure: text (+ Option<ExistingSteps{id,name}>) -> Result<Document, Vec<DefinitionError>>
│   ├── schema.rs       // jsonschema compiled once (OnceLock), error rewrite
│   ├── line_index.rs
│   ├── exporter.rs     // pure: &Workflow -> Document -> yaml text; fingerprint
│   └── layout.rs
├── application/{apply.rs, import.rs, export.rs, parse.rs}   // apply/import mutate the workflows aggregate via workflows::Workflow domain methods + WorkflowRepository
├── grpc/mod.rs
└── http.rs             // GET /schemas/workflow.json
```
Cross-feature: `definition` uses `workflows::{Workflow, WorkflowRepository, revalidate}` public API only. Applier calls the same aggregate methods 0006 exposes (no duplicate persistence logic).

Crates: `jsonschema`, a YAML loader producing typed `serde_json::Value` (`serde_yaml_ng` or `serde-saphyr`), a marked parser for spans (`marked-yaml` or `saphyr` `MarkedYaml`), `indexmap` (serde preserve order), `sha2`, `base64`. Decide during task 1; requirement is: typed scalars, alias rejection, per-node line numbers.

Sample workflow: port `db/seeds/design_poc_tournament.rb` to `backend/seeds/design_poc_tournament.yml` (helper brief → participants → judges → aggregation; prompts verbatim). Dev command `nix run .#seed` imports it via `ImportWorkflow` (grpcurl) if no workflow with that name exists. Port `spec/db/design_poc_tournament_seed_spec.rb` as an import round-trip test.

## Tasks

1. Schema embedding + HTTP route + `jsonschema` compile; error rewrite → verify: port `schema_spec.rb` (each rewritten message), route test (headers, 200).
2. Line index + safe loader → verify: pointer→line map on `spec/fixtures/definitions/*.yml` (copy fixtures), alias doc rejected, size limit.
3. Parser reference checks + document build → verify: port `parser_spec.rb` fully.
4. Exporter + fingerprint → verify: port `exporter_spec.rb`; defaults folding; shorthand forms; fingerprint stable across two exports.
5. Layout → verify: port `layout_spec.rb`.
6. Applier → verify: port `applier_spec.rb` + `round_trip_spec.rb` (export → apply is a no-op: no events, same fingerprint).
7. Importer + `DefinitionService` + `ParseDefinition` dry run → verify: port `importer_spec.rb`, `requests/workflows_spec.rb` (import) and `components/workflows/yaml_editor_spec.rb` (conflict, errors, applied+issues) as gRPC tests.
8. Sample YAML + `nix run .#seed` → verify: import succeeds, workflow validates with no blocking issues except model availability.

## Acceptance

- YAML exported by the Rails app (`../glyph` → `GET /workflows/:id/definition`) imports into v2 without errors for `full.yml` and the tournament sample (models may be flagged unavailable — expected).
- Round-trip export→apply produces zero events and identical fingerprint.

## Out of scope

Frontend YAML editor UI.
