# glyph web client — contributor guide

Layout, commands and boundaries are documented in `README.md`; ESLint enforces
them. This file records the **data-layer pattern** (spec 0015). Later specs
(components, screens, editor) must use only these building blocks — no direct
`useQuery(WorkflowService…)`, no raw `ConnectError` handling in screens.

## Queries

- Named hooks per feature (`features/workflows/hooks.ts`, `features/runs/hooks.ts`,
  `features/catalog/hooks.ts`). Screens import hooks from the feature's
  `index.ts`; never call `useQuery` with a service method directly.
- Cache keys come from `@/shared/api/keys.ts` (`workflowKeys`, `runKeys`,
  `catalogKeys`). Partial keys (no transport) are for `invalidateQueries`
  filters; exact keys (with the `useTransport()` instance) are for
  `setQueryData`/`getQueryData`/`removeQueries`.
- Freshness: while a workflow has a live subscription open (`useIsLive(id)`),
  its queries use `staleTime: Infinity` — live events drive invalidation.
  Without a subscription, 30s detail / 15s list.
- `markLive(workflowId, on)` is owned by `features/live` (`useWorkflowLive`).
  Nobody else touches the liveness registry.

## Mutations

- Every RPC that returns the `{workflow, issues}` aggregate goes through
  `useWorkflowMutation(rpc, options)` (`features/workflows`):
  - Success replaces the `GetWorkflow` cache with the server response
    (no refetch needed) and invalidates list summaries.
  - `optimistic(workflow, request)` patches the cached workflow first
    (canvas MoveStep); the snapshot rolls back on failure.
  - Errors reach the caller as `AppError` via `onAppError` — map them with
    `appErrorToast` or field-level handling; never inspect `ConnectError`.
- No retries for execution-affecting mutations (backend convention: repeated
  agent-side work makes diagnostics ambiguous).

## Errors

- `toAppError(err)` (`@/shared/api/errors.ts`) maps transport failures to
  `AppError`: `validation` (issues attached), `conflict` (connection exists,
  stale fingerprint), `not-found`, `unavailable` (banner + retry),
  `unauthenticated`, `internal` (toast + copyable detail).
- Screens branch on `AppError.kind`; copy stays Rails-verbatim where the Rails
  app had wording.

## Autosave

- Editable fields use `useAutosaveField({ value, save, debounceMs? })`
  (`@/shared/lib/autosave.ts`). Display order: draft > focus-frozen >
  echo-pending committed > upstream. Blur flushes; unmount and `beforeunload`
  flush/warn. `remoteUpdated` + `takeRemote()` implement "Changed elsewhere ·
  Use theirs".
- **`save` must be a stable reference** (`useCallback`) — it is an effect
  dependency; a new identity per render triggers immediate saves.
- Grouped fields (e.g. output name + format + expected output share one RPC)
  save one object value.
- Headers aggregate several fields with `combineAutosaveStatuses` and render
  `SaveIndicator`.

## Live sync

- `LiveProvider` mounts exactly once per workspace (the `/workflows/$id`
  layout). Everything below reads `useLiveStatus()` /
  `LiveConnectionIndicator` from `features/live`.
- `useWorkflowLive` owns `WatchWorkflow`: connect/abort, exponential backoff
  (1s → 30s, jitter; `offline` after 5 failed attempts, still retrying) and
  the event → invalidation map (details in `use-workflow-live.ts`).
- `STEP_RUN_PROGRESS` invalidates only **observed** step-run queries, at most
  once per 2s per step run. A query is "observed" when it exists in the cache
  (`getQueryState` with the exact key).
- Invalidation must never reset UI state: keys are stable, lists key by entity
  id. Own writes arriving as events are harmless (same data, deduped).
- `LiveStatus` lives in `@/shared/api/live.ts` so `shared/ui` can consume it
  without importing features.
