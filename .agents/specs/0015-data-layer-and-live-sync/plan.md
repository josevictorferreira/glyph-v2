# 0015 — Data layer, error model, autosave, live sync

## Goal

The conventions every screen uses to read, mutate and stay live: typed query keys, mutations that reconcile to the returned aggregate, one error model decoding backend details, a field autosave hook, and a `WatchWorkflow` subscription that invalidates the right queries.

## Depends on

0014.

## Design

### Queries (`shared/api` + per-feature hooks)

connect-query hooks per RPC; features wrap them in named hooks (`useWorkflow(id)`, `useRuns(workflowId)`, `useRun(wid, rid)`, `useStepRun(wid, rid, sid)`, `useModels()`, `useTools()`, `useWorkflowList(filter)`).

Stale times: catalog 5 min; workflow/run/step run `Infinity` while a live subscription is open (freshness comes from events), 30s otherwise; workflow list 15s with `refetchInterval` 15s on Home (no cross-workflow stream).

### Mutations reconcile to the aggregate

Every `WorkflowService` mutation and `ApplyDefinition` returns `{ workflow, issues }`. One helper:

```ts
useWorkflowMutation(rpc, { optimistic?: (wf, req) => Workflow })
// onMutate: optional optimistic patch (used only for MoveStep)
// onSuccess: setQueryData(GetWorkflow(id), { workflow, issues }); invalidate list summary
// onError: rollback optimistic patch; surface error (below)
```

Issues are cached with the workflow: `useIssues(workflowId)` returns them indexed by `(entityType, entityId, field)` for inline display.

### Error model (`shared/api/errors.ts`)

```ts
type AppError =
  | { kind: "invalid"; message: string; definitionErrors?: DefinitionError[] }     // INVALID_ARGUMENT
  | { kind: "precondition"; reason: string; message: string; metadata: Record<string,string>; issues?: Issue[] } // FAILED_PRECONDITION (ErrorInfo + ValidationIssues)
  | { kind: "conflict"; message: string }                                          // ABORTED
  | { kind: "not_found"; message: string }
  | { kind: "unavailable"; message: string }                                       // network / UNAVAILABLE
  | { kind: "internal"; message: string };
export function toAppError(e: unknown): AppError   // ConnectError.findDetails(ErrorInfo | ValidationIssues | DefinitionErrors)
```

Presentation rules:
- `invalid` on a field edit → inline under the field, field keeps the user's text.
- `precondition` → handled by the caller's flow (e.g. `CONNECTION_SOURCE_EXISTS` → replace confirmation; `VALIDATION_FAILED` → open readiness panel with issues; `MISSING_VALUES` → run sheet highlights fields). Unhandled reasons → toast with message.
- `conflict` → only from YAML apply (0021).
- `not_found` on a route entity → route-level "This workflow no longer exists" state.
- `unavailable` → global connection banner (shared with live sync), mutations queued? No: fail fast, show Retry.
- `internal` → toast "Something went wrong" + copyable detail.

### Autosave (`useAutosaveField`)

```ts
const field = useAutosaveField({ value: step.prompt ?? "", save: (v) => mutate({...}), debounceMs: 600 });
// field.value / onChange / onBlur (flush) / status: "idle"|"dirty"|"saving"|"saved"|"error" / error / retry()
```
- Local draft wins while the field is focused or dirty; server updates (live or mutation) replace it only when clean. When a remote change arrives while dirty, show a subtle "Changed elsewhere · Use theirs" affordance.
- Flush on blur, route change and `beforeunload` (warn if a save is in flight or failed).
- Workspace header aggregates statuses into one save indicator.
- Grouped fields (e.g. output name + format + expected output share `UpdateStepOutput`) save together: hook accepts an object value.

### Live sync (`features/live`)

`useWorkflowLive(workflowId)` mounted by the workspace route:

- Opens `LiveService.WatchWorkflow` via the transport with an `AbortController`; reconnects with exponential backoff (1s → 30s, jitter); after reconnect behaves as RESYNC.
- Event → invalidation map:

| Event | Invalidate |
|---|---|
| `WORKFLOW_UPDATED` | `GetWorkflow`, list |
| `RUN_QUEUED/STARTED/SUCCEEDED/FAILED/CANCELLED` | `ListRuns`, `GetRun(run_id)`, `GetWorkflow` (last run, next run) |
| `RUN_DELETED` | `ListRuns`, remove `GetRun(run_id)`; if viewing it, route to runs list with toast |
| `STEP_RUN_*` (not progress) | `GetRun(run_id)`, `GetStepRun(step_run_id)` |
| `STEP_RUN_PROGRESS` | `GetStepRun(step_run_id)` only if observed, throttled to 1 per 2s |
| `RESYNC` | everything under this workflow |
| `HEARTBEAT` | update "last seen" only |

- Connection state exposed (`connected | reconnecting | offline`) → small indicator in the header; stale data is still shown.
- Invalidation never resets UI state (selection, scroll, open disclosures): keys are stable, components key by entity id.
- Own writes also arrive as events; the resulting refetch is harmless (same data) and deduped by React Query.

## Tasks

1. Query hooks + key conventions → verify: unit tests with fake transport for each named hook.
2. `toAppError` → verify: tests constructing `ConnectError` with each detail type (ErrorInfo + ValidationIssues, DefinitionErrors, plain codes).
3. `useWorkflowMutation` with optimistic + rollback → verify: tests: success replaces cache with response; failure rolls back MoveStep optimistic position.
4. `useAutosaveField` → verify: tests for debounce, flush on blur, dirty-while-remote-change, error + retry, grouped values.
5. `useWorkflowLive` → verify: fake streaming service emits scripted events; assert invalidations, throttle of PROGRESS, RESYNC refetch, reconnect backoff with fake timers, abort on unmount.
6. Header save + connection indicators (shared components) → verify: component tests.

## Acceptance

- One documented pattern (in `frontend/AGENTS.md`) for queries, mutations, errors and autosave; later specs use only these.
- A live e2e: two browser tabs on the same workflow; renaming in tab A updates tab B within 1s.

## Out of scope

Screens themselves.
