# 0016 — Home, workflow library, command palette, create/import

## Goal

The operator's front door: a Home overview that answers "what needs me, what is running, what runs next", a persistent sidebar library, a command palette, and one entry point to create or import a workflow.

## Depends on

0015.

## Design

### Sidebar library (always visible, collapsible to icons)

- Search box (debounced 200ms → `ListWorkflows{query}`), status filter chips (All · Active · Draft · Paused · Needs attention), `New` button.
- Rows: status dot, name, one secondary line that changes by state: "Running · 2m" / "Failed 12m ago" / "Next 09:00" / "Draft". Current workflow highlighted.
- Sort: needs attention first, then running, then by `updated_at` (client-side over the ≤100 returned).
- Keyboard: `/` focuses search; ↑/↓ + Enter navigate.

### Home (`/`)

Four sections, each hidden when empty; a first-run empty state replaces all of them when no workflow exists ("Build your first workflow" with New and Import actions).

1. **Needs attention**: workflows with status `NEEDS_ATTENTION` and workflows whose `last_run_status = FAILED`. Each card: name, one-line reason (for needs-attention: first blocking issue via `ValidateWorkflow`, fetched lazily per visible card; for failed: "Last run failed 12m ago"), actions: Open, Fix (opens workspace with readiness panel), View run.
2. **Running now**: workflows with `last_run_status ∈ {QUEUED, RUNNING}`: name, elapsed since `last_run_at`, link to the run (latest run from `ListRuns{limit:1}`).
3. **Up next**: active workflows with `next_run_at`, soonest first, relative + exact time, schedule summary.
4. **Recently finished**: latest runs across workflows is not an RPC; show workflows ordered by `last_run_at` with last status. (Documented limitation; a cross-workflow `ListRecentRuns` RPC would improve it.)

Data: `ListWorkflows` (limit 100) polled every 15s while Home is visible (`document.visibilityState`); per-card lazy queries only for rendered cards.

### Command palette (⌘K / Ctrl+K)

- Built on a Combobox in a Dialog; fuzzy match (e.g. `cmdk`-style scoring, implemented locally or with `cmdk`).
- Groups: Navigation (workflows by name, Home), Actions for the current workflow (Run now, Activate/Pause/Resume, Add step, Tidy up, Export YAML, Open definition), Steps of the current workflow ("Go to step Research"), Global (New workflow, Import YAML, Refresh models, Toggle theme).
- Features register commands through `registerCommands(scope, commands)` from their index; palette lives in `app/`.

### Create / import (one dialog, 3 tabs)

- **Blank**: name (optional, backend defaults "Untitled workflow"), description → `CreateWorkflow` → navigate to workspace with the settings panel open and a canvas empty state inviting "Add first step".
- **From YAML**: paste or drop a `.yml` file; debounced `ParseDefinition` dry run shows errors with line numbers inline; Import → `ImportWorkflow` → navigate; issues returned are shown in the workspace readiness panel.
- **Duplicate existing**: pick a workflow → client runs `ExportDefinition` then strips step `id`s and renames to "{name} (copy)" before `ImportWorkflow`. (Schedule stays but workflow is draft, so it will not dispatch.)
- Drag-and-drop a `.yml` file anywhere on Home opens the dialog on the YAML tab.

## Tasks

1. Sidebar library with search, filters, live-ish summaries → verify: unit tests with fake list data (sorting, secondary line by state); e2e search.
2. Home sections + empty state + visibility-aware polling → verify: component tests per section; fake timers for polling; e2e after a fake run fails the workflow shows in Needs attention.
3. Command palette + command registry → verify: tests for registration, scoping to current workflow, keyboard flow; e2e ⌘K → "Run now".
4. Create dialog (blank, YAML with dry-run errors, duplicate) → verify: e2e for each tab; YAML errors show line numbers from `DefinitionError.line`.
5. Responsive: below 768px the sidebar becomes a drawer and Home is the default read-only view → verify: Playwright mobile viewport snapshot.

## Acceptance

- Features acceptance criteria 1 (create a named draft from empty state), 8 (see when a scheduled workflow runs next) demonstrated end to end.
- From a cold start the user reaches any workflow in ≤ 2 interactions (sidebar click or ⌘K + Enter).

## Out of scope

Workspace internals (0017+).
