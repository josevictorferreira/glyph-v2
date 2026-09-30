# 0022 — Acceptance audit

The epic's definition of done, recorded from passing tests. Test locations:
`frontend/e2e/*.spec.ts` (Playwright, fake runner). Criteria quoted from
`../glyph/features.md` ("Acceptance criteria").

## The 14 acceptance criteria

| # | Criterion (abridged) | Demonstrated by |
|---|---|---|
| 1 | Create a named workflow draft from an empty state | `library.spec.ts` — "first run: create a named draft from the empty state" (Home empty state → New → named draft) |
| 2 | Add any practical number of AI steps to a visual canvas | `workflow-canvas.spec.ts` — "add a step from the empty state; selecting a card updates ?step=" and "keyboard-only: add steps, cycle selection, nudge, duplicate" (three steps added keyboard-only); drag positions persist after reload |
| 3 | Configure each step’s inputs, prompt, additional context, tools, model configuration, expected output, and output definition | `editing.spec.ts` — “adds a constant and an asked value and maps one to a step input” (inputs + mapping); “readiness deep link focuses the step's prompt”; prompt/model/tools/output exercised end to end by every workflow built through the API helpers (`addStep` in `runs.spec.ts`, `a11y.spec.ts`); unit: `editor/StepEditor.test.tsx` (prompt editor, model picker) |
| 4 | Connect a named step output to a named input and see the dependency on the canvas | `workflow-canvas.spec.ts` — "connect to card body, replace with confirmation, block cycles, delete edge" (edge appears, replace confirm, delete with Rails copy); `editing.spec.ts` — "connects two steps purely from the source picker" (non-drag path) |
| 5 | Be prevented from creating invalid or cyclic dependency graphs | `workflow-canvas.spec.ts` — cycle guard toast “This would create a cycle.” with no edge created; `canvas/WorkflowCanvas.test.tsx` covers the canvas layer (selection, moves, context menu); duplicate/cyclic connections are refused by the backend and surfaced verbatim (`Connection already exists` copy asserted in backend tests) |
| 6 | Define unresolved required values as workflow-level run inputs | `editing.spec.ts` — "adds a constant and an asked value and maps one to a step input"; `schedule.spec.ts` — "required asked input without a schedule value blocks until filled" |
| 7 | Validate, activate, pause, resume, and schedule a workflow | `editing.spec.ts` — "draft → activate blocked → fix → activate → pause → resume" (readiness gates activation); `schedule.spec.ts` — "weekly schedule on an active workflow shows the next run" |
| 8 | See when an active scheduled workflow will run next | `schedule.spec.ts` — "weekly schedule on an active workflow shows the next run" (composer preview + server `next_run_at`); unit: `schedule/Schedule.test.tsx` summaries with "Next:" from `Schedule.next_run_at` |
| 9 | Trigger a valid workflow manually, supplying required run inputs | `runs.spec.ts` — “starts a run with asked values and inspects the evidence” (run sheet prefills asked value “topic”; MISSING_VALUES and pre-flight covered in `runs/RunSheet.test.tsx`; ⌘Enter submit implemented in `RunSheet.tsx`) |
| 10 | Observe queued and running work update in the runs view | `runs.spec.ts` — "stopping a running run cancels the queued downstream step" (live status through stop; timeline shows Cancelled/Skipped); `live-sync.spec.ts` — "renaming in one tab updates the other within 1s" (WatchWorkflow → invalidation pipeline); "deleting a run updates the run strip live" |
| 11 | Inspect every run's status, trigger source, timestamps, elapsed time, and step outcomes | `runs.spec.ts` — run header assertions (status, times via `run-header`), Runs table rows (`run-row`), timeline view (`Timeline` tab) |
| 12 | Inspect every step run's resolved inputs, output, messages, agent session content, and errors | `runs.spec.ts` — "starts a run with asked values and inspects the evidence" (resolved input + output panel) and "a failed run opens on the failing step from Home, and retry re-runs it" (error panel); unit: `runs/StepRunPanel.test.tsx` (session transcript, messages tab, output formats) |
| 13 | Understand precisely why a run or downstream step did not complete | `runs.spec.ts` — failure opens on the failing step with the human error, retry; stopping shows queued steps skipped/cancelled (skipped-reason copy in `StepRunPanel`); unit: `runs/RunLens.test.tsx` failure banner → first failed step |
| 14 | Edit a workflow without altering the evidence captured by its prior runs | `runs.spec.ts` — "editing the workflow after a run does not change its evidence" (snapshot note + configuration-used from the snapshot) |

All rows reference tests in the suite wired into `nix run .#check` (`pnpm e2e`).

## RPC coverage

Every method in `proto/glyph/v1/*.proto` → the screen/hook that calls it, or
"intentionally unused". "via `useWorkflowMutation`" means the RPC is a workflow
mutation wired through `features/workflows/use-workflow-mutation.ts` (aggregate
reconciliation).

### CatalogService (`catalog.proto`)

| Method | Caller |
|---|---|
| `ListModels` | `features/catalog/hooks.ts` — model picker (`StepTabs`), create-dialog model default |
| `ListTools` | `features/catalog/hooks.ts` — tools tab (`StepTabs`) |
| `RefreshModels` | `features/catalog/hooks.ts` + `app/commands.tsx` — palette "Refresh model catalog", Home attention action |

### DefinitionService (`definition.proto`)

| Method | Caller |
|---|---|
| `ExportDefinition` | `features/definition/Definition.tsx` (source of truth on entry), `features/workflows/workspace-commands.ts` (download), `features/library/create-dialog.tsx` (duplicate tab) |
| `GetSchemaUrl` | **Intentionally unused** — the editor loads the schema from the same-origin static route `/schemas/workflow.json` (see `features/definition/monaco-loader.ts`); the URL never varies per deployment |
| `ParseDefinition` | `features/definition/Definition.tsx` (debounced dry-run markers), `features/library/create-dialog.tsx` (import/duplicate dry-run) |
| `ApplyDefinition` | `features/definition/Definition.tsx` (Apply changes, ⌘S, conflict resolutions) |
| `ImportWorkflow` | `features/library/create-dialog.tsx` (YAML import tab), duplicate tab |

### LiveService (`live.proto`)

| Method | Caller |
|---|---|
| `WatchWorkflow` | `features/live/use-workflow-live.ts` — mounted by workspace and run lens; drives invalidation |

### RunService (`run.proto`)

| Method | Caller |
|---|---|
| `StartRun` | `features/runs/use-start-run.ts` — run sheet, Run now, palette, Home, runs-empty |
| `ListRuns` | `features/runs/hooks.ts` — Runs table (cursor pagination), run strip |
| `GetRun` | `features/runs/hooks.ts` — run lens header, canvas lens, timeline |
| `GetStepRun` | `features/runs/hooks.ts` — step run panel |
| `StopRun` | `features/runs/use-run-actions.ts` — lens header/stop, runs table row action |
| `RetryStep` | `features/runs/use-run-actions.ts` — step run panel error section |
| `DeleteRun` | `features/runs/use-run-actions.ts` — lens header, runs table row action (confirm) |

### WorkflowService (`workflow.proto`)

| Method | Caller |
|---|---|
| `ListWorkflows` | `features/workflows/hooks.ts` — sidebar library, Home |
| `GetWorkflow` | `features/workflows/hooks.ts` — workspace, every aggregate reconciliation |
| `CreateWorkflow` | via `useWorkflowMutation` — create dialog (blank tab) |
| `UpdateWorkflow` | via `useWorkflowMutation` — name/description autosave (`WorkspaceHeader`, `WorkflowPanel`) |
| `ValidateWorkflow` | `features/workflows/hooks.ts` — readiness queries |
| `AddStep` | via `useWorkflowMutation` — canvas empty state/keyboard "a", editor inputs tab |
| `DuplicateStep` | via `useWorkflowMutation` — canvas Ctrl+D, step editor |
| `UpdateStepDetails` | via `useWorkflowMutation` — step editor details (`editor/step-details.ts`) |
| `UpdateStepPrompt` | via `useWorkflowMutation` — prompt tab (`StepTabs`) |
| `UpdateStepOutput` | via `useWorkflowMutation` — output tab (`StepTabs`) |
| `UpdateStepModel` | via `useWorkflowMutation` — model tab (`StepTabs`) |
| `ToggleStepTool` | via `useWorkflowMutation` — tools tab (`StepTabs`) |
| `MoveStep` | via `useWorkflowMutation` (optimistic) — canvas drag/nudge, tidy up |
| `DeleteStep` | via `useWorkflowMutation` — canvas context menu, step editor |
| `AddStepInput` | via `useWorkflowMutation` — inputs tab (`InputsTab`) |
| `RemoveStepInput` | via `useWorkflowMutation` — inputs tab; connection delete |
| `MapStepInput` | via `useWorkflowMutation` — inputs tab source picker |
| `AddWorkflowInput` | via `useWorkflowMutation` — values tab (`WorkflowValues`), inputs tab |
| `UpdateWorkflowInput` | via `useWorkflowMutation` — values tab |
| `RemoveWorkflowInput` | via `useWorkflowMutation` — values tab |
| `CreateConnection` | via `useWorkflowMutation` — inputs tab source picker |
| `ConnectOutputToStep` | via `useWorkflowMutation` — canvas drag-connect (card body/handles) |
| `RemoveConnection` | via `useWorkflowMutation` — canvas edge delete (confirm), inputs tab |
| `SaveSchedule` | via `useWorkflowMutation` — schedule composer (`ScheduleComposer`), remove |
| `SetScheduleValue` | via `useWorkflowMutation` — scheduled values (`ScheduleValues`) |
| `ActivateWorkflow` | via `useWorkflowMutation` — workspace header, readiness sheet, palette |
| `PauseWorkflow` | via `useWorkflowMutation` — workspace header, palette |
| `ResumeWorkflow` | via `useWorkflowMutation` — workspace header, palette |

Coverage: 40/41 methods called by the UI; 1 intentionally unused (`GetSchemaUrl`).

## Keyboard-only walkthrough

Create → configure → connect → activate → run → inspect, keyboard only
(demonstrated by tests, not a separate suite):

- **Library / create**: ⌘K opens the palette (`library.spec.ts` — "command palette:
  ⌘K opens and New workflow runs"); type the name, Enter creates.
- **Canvas**: `a` adds a step, `Tab` cycles selection, Shift+Arrows nudge,
  `Ctrl+D` duplicates (`workflow-canvas.spec.ts` — "keyboard-only: add steps,
  cycle selection, nudge, duplicate"; context menu reachable via keyboard in
  `ContextMenu` unit tests).
- **Configure**: the contextual panel opens per selection; every field is a
  labelled input with autosave (component tests across `features/editor`).
- **Connect without dragging**: inputs tab source picker (`editing.spec.ts` —
  "connects two steps purely from the source picker").
- **Readiness/activate**: the readiness sheet deep-links Enter → offending
  field (`editing.spec.ts` — "readiness deep link focuses the step's prompt");
  header action matrix enables Activate only when ready.
- **Run**: ⌘K → “Run…” / Run now opens the sheet where present; ⌘Enter starts
  (`RunSheet.tsx` keyboard handler; `runs/RunSheet.test.tsx`);
  “View run” focus lands in the lens.
- **Inspect**: Tab through lens tabs (Graph/Timeline), Enter selects step
  cards; panel sections are native `<details>` disclosures (axe-clean).
- **Dialogs and toasts**: focus trap and Escape handling are Radix primitives
  (`shared/ui/primitives.test.tsx`); axe scans (Home, Build,
  Definition, Evidence view) report **zero serious/critical violations**
  (`a11y.spec.ts`).
