# 0023 — Shared texts (workflow-level prompt constants with variables)

## Goal

Let a workflow define named texts once and have steps reference them from `prompt`, `context` and `expect`, optionally filling `{{variables}}` per step. This removes the copy-paste in workflows like `backend/seeds/design_poc_tournament.yml`, where the same participant prompt appears four times and the judge prompt and scorecard twice.

Not a Rails port: this is new behaviour. Rails-exported YAML (no `texts`) must keep importing unchanged.

## Depends on

0006 (workflow design), 0007 (YAML definition), 0018 (step editing), 0021 (definition mode).

## Decisions

- **Scope: one workflow.** Texts belong to a workflow, are deleted with it, and are not shared across workflows.
- **First-class storage, not a YAML macro.** References are stored, so export → apply round-trips with the references intact. YAML anchors stay forbidden (`yaml.rs`).
- **Resolved at snapshot time.** A run's snapshot holds the fully rendered text, exactly like today's plain prompts. Runs never see references, so the rule that runs are immutable evidence still holds. Editing a shared text affects only future runs.
- **Variables reuse the existing `{{name}}` syntax** (validator regex `[A-Za-z0-9_ -]+`, trimmed). Rendering is layered:
  1. Snapshot: tokens named in the reference's `vars` are replaced.
  2. Run time: the remaining tokens go through the existing `interpolate` (step inputs, then workflow values) for `prompt` and `context`.

  An unfilled variable therefore falls back to a step input or workflow value of the same name. If none exists, the existing readiness error reports it (`“X” uses “{{t}}” but no workflow value or input provides it…`).
- **`expect` is not interpolated at run time** (`system_prompt` uses it raw). Every token in a text referenced from `expect` must therefore be filled by `vars`, and the validator reports any that are not.
- **Variable values are plain strings** (scalars are converted to strings, like constant inputs). A value can itself contain `{{input}}` tokens; run-time interpolation expands them.
- **No templates/`extends`, no default values for variables, no cross-workflow library.** All are out of scope.

## YAML shape

```yaml
inputs:
  feature_brief:
    description: …
texts:
  designer_brief: |
    You are a distinguished product designer…
  judge_prompt: |
    You are conducting a blind UI/UX review…
  scorecard:
    description: Rubric shown to every judge.
    body: |
      # UX/UI Evaluation Scorecard …
steps:
  - name: Generate — GLM 5.3
    model: velox/glm-5-3
    prompt: { ref: designer_brief }
    expect: A complete, self-contained HTML document…
  - name: Judge — Sauron
    model: velox/sauron
    prompt: { ref: judge_prompt, vars: { judge_name: Sauron } }
    context: { ref: scorecard }
```

- `texts` is a map from key to either a scalar (shorthand for the body) or `{ body, description? }`. Keys use the input-name pattern (`must start with a letter and use letters, digits, spaces or underscores`).
- `prompt`, `context` and `expect` each accept either a string, as today, or `{ ref, vars? }`. Helper steps still allow none of them.
- Exporter key order: `name, description?, fail_fast?, defaults?, inputs?, texts?, schedule?, steps`. `texts` uses the scalar shorthand when there is no description, `vars` is omitted when empty, and texts are emitted in position order.

## Storage (migration `0006_shared_texts.sql`)

```sql
CREATE TABLE workflow_texts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id uuid NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
    key text NOT NULL,
    description text,
    body text NOT NULL DEFAULT '',
    position integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX index_workflow_texts_on_workflow_id_and_lower_key
    ON workflow_texts (workflow_id, lower(key));

CREATE TABLE step_text_refs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_step_id uuid NOT NULL REFERENCES workflow_steps (id) ON DELETE CASCADE,
    workflow_text_id uuid NOT NULL REFERENCES workflow_texts (id) ON DELETE RESTRICT,
    field text NOT NULL
        CONSTRAINT step_text_refs_field_check CHECK (field IN ('prompt', 'context', 'expect')),
    vars jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX index_step_text_refs_on_step_and_field
    ON step_text_refs (workflow_step_id, field);
CREATE INDEX index_step_text_refs_on_workflow_text_id ON step_text_refs (workflow_text_id);
```

When a field has a reference, the step's own column (`prompt` / `additional_context` / `expected_output`) is `NULL`. `ON DELETE RESTRICT` means an in-use text can't be deleted by accident. The application layer reports this before the database does.

No change to `step_runs` or the snapshot schema: `SnapshotStep.prompt` etc. receive the rendered text, and `snapshot::VERSION` stays 3.

## Design

### Domain (`features/workflows/domain`)

- `model.rs`: `SharedText { id, key, description, body, position }`, `Workflow.texts: Vec<SharedText>`, `TextRef { text_id, vars: BTreeMap<String, String> }`, and `Step.{prompt_ref, context_ref, expect_ref}: Option<TextRef>`.
- New `shared_text.rs` (pure):
  - `render(body, vars) -> String`: replaces only tokens whose trimmed name is in `vars`, leaves others verbatim, single pass. It uses the same token regex as `validator::variable_tokens`; both import it from one place in the workflows domain.
  - `Workflow::effective_prompt(&step)`, `effective_context`, `effective_expect`: return the rendered ref if set, else the step's own field.
- `snapshot.rs`: fill `prompt`, `additional_context` and `expected_output` from the `effective_*` functions.
- `validator.rs`:
  - "needs a prompt" and `check_prompt_variables` use the effective texts.
  - New: `“{step}” sets “{var}”, which the shared text “{key}” doesn’t use.`
  - New, for `expect` refs: `“{step}” leaves “{{t}}” unfilled in its expected output. Set it in vars.`
- `Step::configured` (`model.rs:162`) uses the effective prompt.
- New aggregate methods (with events):
  - `add_text`, `update_text` (key/description/body; key unique ci), `remove_text` (refuse when used: `“{key}” is used by {n} steps. Detach them first.`).
  - `set_step_text_ref(step, field, Option<TextRef>)`. Passing `None` detaches: the rendered text is copied into the step's own field, so nothing is lost.
  - Events: reuse `WORKFLOW_UPDATED` for text changes and `WORKFLOW_STEP_UPDATED` for ref changes. No new event types.
  - `update_step_prompt` with plain text clears the `prompt` ref. Same for context and expect.
  - `extract_text(step, field, key)` ("Make shared"): creates a shared text from the step's own field, links the step with empty `vars`, and clears the step's own field, all in one change. The new key must be unique (ci). A blank field is refused: `There is nothing to share yet. Write the text first.`
  - `duplicate_step` copies the step's text refs (same `text_id`, same `vars`), so the copy stays linked instead of getting a pasted copy of the text.

### Infrastructure

- Workflow repository: load `workflow_texts` and `step_text_refs` with the aggregate, and persist them in the same transaction as the step changes.
- Re-run `sqlx_prepare`.

### Definition (`features/definition`)

- `schema.json`:
  - Add `texts` (`propertyNames` pattern; value is string or `{body, description}` with `additionalProperties: false`).
  - Add `$defs/textField = string | {ref: string, vars?: {string: scalar}}`, used for `prompt`, `context` and `expect`.
  - Document the divergence from Rails's `schema.json` in `0012-hardening-deploy-cutover/parity.md`.
- `types.rs`: `TextDef { key, description, body }`, `Document.texts: Vec<TextDef>`, and `TextField = Inline(String) | Ref { key, vars }` for `StepDef.{prompt, context, expect}`.
- `parser.rs` reference checks (with line numbers via the existing pointer index):
  - Duplicate text key (ci): `The workflow already has a shared text named “{k}”.`
  - Unknown ref: `“{r}” is not a shared text. Check the spelling.`
  - A var that the text doesn't use: `“{v}” is not used by the shared text “{r}”.`
- `applier.rs`, in order inside the existing transaction:
  1. Upsert texts by ci-key (positions).
  2. Steps and their refs.
  3. Remove texts absent from the document, after the steps so their refs are already gone.

  Unchanged texts or refs produce no events, so the round-trip no-op still holds.
- `exporter.rs`: emit `texts` and `{ ref, vars? }`. The `defaults` folding is unaffected.

### gRPC (`proto/glyph/v1/workflow.proto`)

- `message SharedText { string id; string key; optional string description; string body; int32 position; }` and `Workflow.texts`.
- `message TextRef { string text_id; map<string,string> vars; }` and `Step.{prompt_ref = 20, context_ref = 21, expect_ref = 22}`.
- `Step.prompt`, `additional_context` and `expected_output` carry the effective (rendered) text, so the canvas, run preview and existing clients keep working. The refs tell the editor that the field is linked.
- RPCs: `AddSharedText`, `UpdateSharedText`, `RemoveSharedText` (`FAILED_PRECONDITION` with the message above), `SetStepTextRef { step_id, field, optional TextRef ref }` and `ExtractSharedText { step_id, field, key }` (returns the updated workflow).
- Run `buf lint` and `buf breaking`. All additions are additive.

### Frontend

- Workflow panel: a "Shared texts" section that lists texts with "Used by N steps", supports add, rename, and editing the body (reusing `PromptEditor` token highlighting), and disables remove while a text is in use.
- Step tabs (prompt / context / expect): a "Use shared text" picker. When linked:
  - The tab shows a read-only rendered preview, with variable highlighting and a "Detach" button.
  - Below it is a vars form with one row per token in the text. Each row shows its fallback ("falls back to input `x`" or "unresolved").
  - When not linked and the field has text, a "Make shared" action asks for a key (pre-filled from the step name, e.g. `generate_glm_5_3_prompt`) and calls `ExtractSharedText`.
- Canvas step card: a small marker per linked field showing the text key (e.g. `⧉ designer_brief`), with a tooltip "Prompt from shared text “designer_brief”". Hovering a text in the panel highlights the steps that use it.
- Duplicate step (existing action): no UI change; the copy is linked because the backend copies refs.
- Definition mode: no change beyond the schema. Semantic errors come from `ParseDefinition` as today.

### Seed

Rewrite `backend/seeds/design_poc_tournament.yml` with `texts: designer_brief, judge_prompt, scorecard`. Also fix the existing `poc_saruman: Generate — Sauron` typo; it should be `Generate — Saruman`.

## Tasks

1. `shared_text::render` and the `effective_*` functions → verify: unit tests for filled, unfilled, trimmed (`{{ x }}`) and repeated tokens, and a var value containing `{{input}}` left for run time.
2. Domain model, aggregate methods, validator rules and `configured` → verify: domain tests for each new message, remove-in-use refused, detach copies the rendered text, plain-prompt update clears the ref, `extract_text` creates and links the text and clears the field (blank and duplicate-key cases refused), and `duplicate_step` keeps every ref and its `vars`.
3. Migration and repository load/persist → verify: `nix run .#test -- workflows` repository tests round-trip texts and refs; deleting the workflow cascades.
4. Snapshot uses effective texts → verify: snapshot test where the shared body changes after the snapshot and the snapshot keeps the old rendered text. Also an engine test where an unfilled var is filled by a step input at run time.
5. Schema, parser, applier, exporter → verify:
   - parser tests for each new error with its line;
   - export → apply on a workflow with texts produces zero events and the same fingerprint;
   - renaming a text key in YAML re-links its steps;
   - Rails fixtures still import.
6. Proto and gRPC handlers → verify: `buf lint`/`breaking`; gRPC tests for the five RPCs, including the `FAILED_PRECONDITION` path and `ExtractSharedText`; a `DuplicateStep` test that the response's copy has the same refs.
7. Frontend panel, picker, vars form, "Make shared" and canvas marker → verify:
   - component tests: picker links/detaches, vars rows and fallbacks, remove disabled when used, "Make shared" key prompt, and the card marker rendered for each linked field;
   - e2e, building the tournament by clicking: write one Generate prompt, "Make shared", duplicate the step three times, change the models; Definition mode shows a single `texts.designer_brief` and four `{ ref: designer_brief }`; run with the fake runner; each step run's prompt is the rendered text.
8. Seed rewrite → verify: `nix run .#seed` imports, and the workflow has no blocking issues besides model availability.
9. `nix run .#check` → verify: green, including `tests/architecture.rs` (no new cross-feature imports outside `mod.rs` re-exports).

## Acceptance

- The tournament seed has each prompt and the scorecard exactly once.
- A run created before a shared-text edit still shows and executes the old text.
- Export → apply unchanged is a no-op (no events, stable fingerprint).
- YAML without `texts` behaves exactly as before.
- The tournament can be built entirely in Build mode with each prompt written once: "Make shared" plus duplicate keeps every copy linked, and the canvas shows which steps share which text.

## Alternatives considered

- **YAML anchors**: the macro is lost on the first export (the database stores the expanded text), and lifting the alias ban reopens the alias-bomb risk.
- **A constant workflow input plus `prompt: "{{designer_brief}}"`**: works today with no code, because constant inputs are interpolated at run time. But the text is not expanded recursively, so variables inside it don't work. It also shows up as a workflow input, and its text is only substituted at run time instead of being frozen in the snapshot's `prompt` field. Worth mentioning to users as a stopgap.
- **Step templates (`extends`)**: deferred. It could later build on the `workflow_texts` storage.

## Out of scope

Cross-workflow text library, step templates, variable defaults, completion of `ref` keys in Monaco.
