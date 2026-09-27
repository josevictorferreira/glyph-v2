# 0017 — Canvas (Build mode and Run lens)

## Goal

The DAG canvas that is the spine of the workspace: legible step cards with input/output ports, typed connections, direct manipulation with keyboard equivalents, automatic tidy layout, and a lens API so the same canvas renders run evidence.

## Depends on

0015. Consumes `Workflow` (build) or `Run.snapshot` + `step_runs` (lens).

## Design

### Model mapping

- Node per `Step` (build) or `SnapshotStep` (lens), position `canvas_x/canvas_y`.
- Handles: one output handle (right) labeled with `output_name`; one input handle per `StepInput` (left), ordered by `position`, labeled with name and required marker.
- Workflow-value-mapped inputs show a small inline chip "← topic" instead of an edge (values are not nodes; keeps the graph about step dependencies).
- Edge per `Connection` from source output handle to destination input handle. Snapshot connections in the lens.

### Step card (build)

Compact by design: kind icon (Pi / Helper), name (or "Untitled step" muted), one-line purpose (description or first line of prompt), model short name, tool icons, readiness badge (issue count for this step's entity id and its inputs), `allow_failure` marker. Never the full prompt. Width fixed, height grows with inputs.

### Step card (lens)

Same geometry, painted by `StepRunSummary.status` using the status tokens: running pulse, elapsed time live, failed shows first line of `human_error`, skipped shows "Did not run", cancelled muted. Edges colored by source status (succeeded solid, failed red, pending dashed). First failed step (`first_failed_step_run_id`) gets a focus ring and is auto-selected when opening a failed run.

### Interactions (build)

| Action | Pointer | Keyboard / form alternative | RPC |
|---|---|---|---|
| Add step | Double-click empty canvas or context menu "Add Pi step / Helper step" at cursor; toolbar "+" places at viewport center | `A` (Pi), `Shift+A` (helper) at viewport center; palette | `AddStep{kind, canvas_x, canvas_y}` → select new step, focus name field |
| Move | Drag card | Arrow keys move selected by 20px (Shift: 100px) | `MoveStep` on drag end / after 400ms key idle; optimistic |
| Connect | Drag output handle → input handle | Step editor Inputs tab source picker (0018) | `CreateConnection` |
| Connect creating input | Drag output handle → card body | — (editor: "Add input from step") | `ConnectOutputToStep` |
| Replace existing source | drop on a fed input → popover "Replace connection from X?" | same confirm in picker | `CreateConnection{replace_existing:true}` |
| Delete connection | Select edge + Delete / edge context menu | editor source picker → "Not connected" | `RemoveConnection` (confirm: "This also removes input “{name}” from {step}." since backend deletes the destination input) |
| Delete step | Delete key / context menu | editor danger zone | `DeleteStep`, confirm dialog naming step and count of connections removed |
| Duplicate | `Ctrl+D` / context menu | editor menu | `DuplicateStep` |
| Select | Click; click empty canvas clears | Tab / Shift+Tab cycles nodes in topological order; Enter opens editor | URL `?step=` |
| Pan / zoom / fit | Drag empty space, wheel/pinch; controls | `F` fit, `+`/`-`, `0` reset | local only |

Connection validity is pre-checked while dragging: invalid targets dim with a reason tooltip (self, would create cycle — computed client-side from the edge list, source without `output_name`). Server remains authoritative; its error message is shown if it disagrees.

Cycle check helper in `features/canvas/lib/dag.ts` (reachability), unit-tested.

### Tidy up

Toolbar "Tidy up" runs `elkjs` layered layout (left→right, respecting input handle order), animates to the new positions, then issues `MoveStep` for every moved node (batched, concurrency 4). Before it runs, positions are kept so a toast offers "Undo tidy" (re-issues previous `MoveStep`s). This is the one local undo.

### Viewport

Per-workflow viewport persisted in `localStorage`; first open fits to content. Minimap bottom-right, collapsible. Empty canvas state: centered "Add your first step" button + hint about YAML import.

### Lens API

```ts
<WorkflowCanvas mode="build" workflow={wf} issues={issues} selectedStepId onSelect />
<WorkflowCanvas mode="lens" snapshot={run.snapshot} stepRuns={run.step_runs} selectedStepRunId onSelect />
```
Lens is read-only (no drag, no connect, no context menu edits).

### Performance

Memoized node components; stable node/edge arrays derived with `useMemo` keyed by aggregate `updated_at`; target 60fps drag at 100 steps.

## Tasks

1. Mapping workflow/snapshot → nodes/edges + DAG helper → verify: unit tests (handles order, value chips, cycle detection, topological order).
2. Build step card + readiness badge + empty state → verify: component tests, visual review in `/dev/ui`.
3. Move (pointer + keyboard) with optimistic `MoveStep` → verify: test rollback on error; e2e drag persists after reload.
4. Connect / connect-to-card / replace / delete edge with confirmations → verify: e2e for each; invalid target tooltip for cycle.
5. Add / duplicate / delete step with context menu and shortcuts → verify: e2e; delete confirmation copy includes connection count.
6. Keyboard navigation and focus management → verify: keyboard-only e2e builds a 3-step chain.
7. Tidy up with undo → verify: e2e positions change and persist; undo restores.
8. Lens rendering → verify: component tests per status; failed run auto-selects first failed step.
9. Performance check with a generated 100-step workflow → verify: drag profile ≥ 50fps on a mid laptop (manual, recorded).

## Acceptance

- Features acceptance 2, 4, 5 (add practical number of steps, connect named output to named input, prevented from cyclic graphs) demonstrated.
- Every canvas action has a keyboard or form path.

## Out of scope

Step configuration forms (0018), run panels (0020).
