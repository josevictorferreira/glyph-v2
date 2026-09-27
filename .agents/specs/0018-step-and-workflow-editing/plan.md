# 0018 — Step and workflow editing, readiness, lifecycle

## Goal

Everything in Build mode outside the canvas geometry: the step editor, the workflow settings panel (details, values), the readiness panel with deep links, the model/tool pickers, and lifecycle actions (activate, pause, resume) with clear pre-conditions.

## Depends on

0015, 0017 (selection), catalog hooks.

## Design

### Workspace header (Build mode)

`Name` (inline editable) · StatusBadge · Readiness pill ("Ready" / "3 issues") · save indicator · live indicator · mode switch (Build · Runs · Definition) · primary action:

| Status | Primary | Secondary (menu) |
|---|---|---|
| Draft | Activate (disabled with reason tooltip while issues exist) | Test run |
| Active | Run now | Pause |
| Paused | Resume | Run now |
| Needs attention | Review issues | Run now (disabled while blocking), Pause |

"Test run" / "Run now" open the run sheet (0020).

### Contextual panel (right)

Nothing selected → **Workflow panel**; step selected → **Step editor**. Panel is resizable, remembers width, collapses with `]`.

### Step editor

Header: kind icon, name field (autofocus on new step), overflow menu (Duplicate, Delete). Tabs, each tab label shows a red dot when it contains issues:

1. **Instructions** (Pi only)
   - Prompt editor: monospace auto-growing textarea with `{{variable}}` highlighting (CodeMirror 6 lightweight setup) and autocomplete on `{{` listing this step's inputs + workflow values; unknown tokens underlined with the validator message.
   - Available variables list below as clickable chips (insert at cursor).
   - Additional context: collapsible second editor with the same features.
   - Saves via `UpdateStepPrompt` (grouped).
2. **Inputs**
   - One row per input: name, required toggle, **Source picker** (Combobox): "Not connected", "Output of ‹step›" (all steps that would not create a cycle, disabled with reason otherwise), "Workflow value ‹name›", "+ New workflow value…". Choosing maps to `CreateConnection` / `MapStepInput` / `RemoveConnection`; replacing an existing source asks inline.
   - Add input row (name + required) → `AddStepInput`; remove → `RemoveStepInput` with confirm when connected.
   - Helper steps: explanatory note "Collects its inputs into one structured output; no model is called."
3. **Model & tools** (Pi only)
   - Model picker: Combobox grouped by provider, search by name/id, shows capabilities badges; unavailable models listed in a separate group and the current unavailable selection stays visible with a warning (matches validator). "Catalog may be out of date · Refresh" when `ListModels.stale`, calls `RefreshModels`.
   - Temperature: slider + number (0–2) shown only when the selected model has the `temperature` capability; clearing removes it (`UpdateStepModel` without temperature).
   - Tools: checklist from `ListTools` with description; each toggle → `ToggleStepTool`. Warning copy that tools run inside an isolated working directory.
4. **Output**
   - Output name (defaults hint: step name), format segmented control (Markdown · HTML · JSON · ZIP) with one-line explanation each, expected output (required for Pi), output description. Grouped save `UpdateStepOutput`. Renaming an output with downstream connections shows "Updates N connections" hint.
5. **Settings**: description, allow failure switch with explanation ("Downstream steps run without this input if it fails"). `UpdateStepDetails`.

Inline issues: each field shows the validator messages for `(entity_type, entity_id, field)` from cached issues.

### Workflow panel

Sections (disclosures, all open on a new workflow):
- **Details**: name, description, fail fast switch with explanation → `UpdateWorkflow`.
- **Workflow values**: table of `WorkflowInput`: name, kind (Asked at run time / Constant), required, value/default, description, "used by N steps". Add/edit inline row → `Add/UpdateWorkflowInput`; remove confirms and lists affected steps → `RemoveWorkflowInput`. Name validation mirrors backend regex client-side for instant feedback; backend message wins.
- **Schedule**: summary + edit (0019).
- **Danger zone**: none for now (no workflow deletion in backend).

### Readiness panel

Opened from the readiness pill or `Review issues`. Issues grouped by entity (Workflow, each step by name, values, schedule). Click → selects entity, opens the right tab, focuses the field, and pans the canvas to the node. Updates live as issues change; celebrates "Ready to activate" with the Activate button inside.

### Lifecycle

- Activate → `ActivateWorkflow`; `VALIDATION_FAILED` precondition opens the readiness panel with returned issues.
- Pause → confirm sheet ("Scheduled runs stop. Manual runs stay available. History is kept.") → `PauseWorkflow`.
- Resume → `ResumeWorkflow`; if the response status is `NEEDS_ATTENTION`, open readiness panel with issues and explain why.

## Tasks

1. Header + primary action matrix → verify: component tests per status with disabled reasons.
2. Step editor shell + tabs with issue dots + autosave wiring → verify: tests that each field calls the right RPC with grouped payloads.
3. Prompt editor with variable highlighting, autocomplete, chips → verify: unit tests for token parsing (same regex as backend `\{\{([A-Za-z0-9_ -]+)\}\}`), autocomplete list contents.
4. Inputs tab with source picker (connect, map, clear, replace, new value) → verify: e2e connects two steps purely from the picker.
5. Model picker, temperature gating, stale refresh, tools → verify: tests with fake catalog incl. unavailable current model.
6. Output + Settings tabs → verify: tests; downstream-connections hint.
7. Workflow panel (details, values table) → verify: e2e add constant + asked value, map to a step input.
8. Readiness panel deep links → verify: e2e: click issue "needs a prompt" focuses prompt field of that step.
9. Lifecycle flows → verify: e2e draft → activate blocked → fix → activate → pause → resume.

## Acceptance

- Features acceptance 3, 6, 7 (configure every step field, define workflow-level values, validate/activate/pause/resume) demonstrated.
- No field requires a save button; every field shows save state and inline validator messages.

## Out of scope

Schedule composer details (0019), run sheet (0020).
