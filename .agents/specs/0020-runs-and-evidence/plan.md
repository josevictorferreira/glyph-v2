# 0020 — Runs and evidence

## Goal

Start runs, follow them live, and reconstruct exactly what happened: run sheet, run strip and history, the Run lens on the canvas, the step run panel (inputs, live transcript, outputs by format, configuration used, errors), a timeline view, and stop/retry/delete.

## Depends on

0015; 0017 lens API for the Run lens.

## Design

### Run sheet

- Opened from primary action, palette, run strip "+" or Home.
- Lists workflow inputs with `ask_at_run_time`: label, description, required marker, textarea (auto-grow; JSON-looking values get mono font), prefilled from the stored default, else from the latest run's `supplied_values` ("Used last time" hint).
- Constants shown read-only in a collapsed "Fixed values" section.
- Draft workflows: banner "This is a test run of a draft. It won't activate the workflow."
- Pre-flight: current readiness issues shown at the top; Start disabled while blocking issues exist, with "Review issues" link.
- Start → `StartRun{values by name}`; `MISSING_VALUES` highlights fields; success closes the sheet and navigates to the new run's lens. `⌘Enter` submits.
- No required asked values → "Run now" skips the sheet and starts immediately (toast with "View run").

### Run strip (bottom of workspace, all modes)

Last 20 runs as chips (status color, trigger icon manual/scheduled, draft-test marker), newest right; hover shows start time, duration, failure summary. Click enters the Run lens. "View all" → Runs mode. Live via 0015 invalidations.

### Runs mode (`/workflows/:id/runs`)

Table: status, started (relative + exact), trigger, duration (live while running), failure summary truncated, draft marker. Infinite scroll via `ListRuns{before}` cursor (page 20). Row actions: Open, Stop (live), Delete (confirm: "Deletes this run's evidence permanently."). Empty state: "No runs yet" + Run now.

### Run lens (`/workflows/:id/runs/:runId`)

- Header switches to run context: run status, trigger, queued/started/ended, duration, "Snapshot captured {time}" with a note when the workflow changed since (compare snapshot vs current step count/updated_at): "This run used an earlier version of the workflow."
- Actions: Stop (while live) → `StopRun`; Delete; "Back to build".
- Failure summary banner links to first failed step.
- View toggle: **Graph** (canvas lens, 0017) · **Timeline** (waterfall: one row per step run ordered by `started_at`, bars from queued→started→ended, shows parallelism and waiting; live-growing bars).
- Supplied values disclosure (from `Run.supplied_values`).
- Canvas and timeline render from the snapshot only, never the current workflow.

### Step run panel (right panel in lens)

Order optimized for diagnosis; sections collapse, state remembered per section:

1. **Status**: badge, started/ended exact times, duration (live), skipped reason or cancellation reason.
2. **Error** (failed only, expanded): `human_error` prominent; `technical_error` in a disclosure with copy; **Retry step** (enabled only when the run is terminal and step failed; errors from backend reasons shown verbatim) → `RetryStep`.
3. **Inputs**: each `ResolvedInput`: name, source label (link to the source step run when `step_run_id`), value rendered (string → text/markdown toggle; JSON → tree), long values clipped with expand + copy.
4. **Session** (Pi): transcript blocks: text as markdown, thinking as muted collapsible, tool calls as rows with name, summary and state icon. Live while running: refetch on progress events, auto-scroll pinned to bottom unless the user scrolled up ("Jump to latest"). Agent messages list (role, text, tool call count, stop reason, error) as a secondary tab.
5. **Output**: by `output_file_format`:
   - Markdown: rendered (sanitized) with Raw toggle.
   - HTML: sandboxed `<iframe sandbox src={preview_path}>` (backend sets strict CSP) with "Open in new tab" and Raw source toggle.
   - JSON / helper output: collapsible tree from `output_json` + Raw.
   - ZIP: file card with Download (no inline listing).
   - Always: Download (`download_path`) and Copy.
6. **Configuration used** (collapsed): prompt, additional context, expected output, model, temperature, tools — from the step run, i.e. the snapshot.

### Live behaviour

The lens mounts `useWorkflowLive`; `GetRun` refetches on run/step events, `GetStepRun` refetches only for the selected step run. Durations tick locally from timestamps. Selection and scroll persist across refetches.

## Tasks

1. Run sheet (prefill, constants, draft banner, pre-flight, MISSING_VALUES) → verify: tests with fake transport; e2e start a run with asked values.
2. Run strip + Runs mode table with cursor pagination and row actions → verify: tests; e2e delete run updates strip live.
3. Run lens header, failure banner, stale-snapshot note, stop/delete → verify: e2e stop a running fake run shows queued steps skipped.
4. Timeline view → verify: component tests (bar geometry from timestamps, parallel rows); live growth with fake timers.
5. Step run panel: status, error + retry, inputs → verify: e2e fail → retry → succeed with fake runner.
6. Transcript live view with pinned auto-scroll → verify: fake stream progress events append blocks; scroll pin behaviour test.
7. Output renderers per format + download/copy; sanitization test (script tags stripped from markdown; iframe sandbox attrs present) → verify: component tests per format.
8. Configuration used section from snapshot → verify: editing the workflow after the run does not change the panel (e2e).

## Acceptance

- Features acceptance 9–14 (manual trigger with inputs, live updates, inspect runs and step runs, understand why a step did not complete, edits do not alter past evidence) demonstrated end to end with the fake runner.
- A failed run opens directly on the failing step's error in one click from Home.

## Out of scope

Comparing two runs side by side (candidate follow-up), re-run with same inputs as a single action (can be added: "Run again with these values" prefilling the sheet — include if cheap during task 1).
