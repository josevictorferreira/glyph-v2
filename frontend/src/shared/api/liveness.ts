// Liveness registry (spec 0015): which workflows currently have an open
// WatchWorkflow subscription. Query hooks read it to choose staleTime —
// Infinity while live (freshness comes from events), 30s otherwise.
import { useSyncExternalStore } from "react";

const counts = new Map<string, number>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** Toggle from an effect: markLive(id, true) when a subscription opens. */
export function markLive(workflowId: string, on: boolean): void {
  const current = counts.get(workflowId) ?? 0;
  const next = on ? current + 1 : Math.max(0, current - 1);
  if (next === current) return;
  if (next === 0) counts.delete(workflowId);
  else counts.set(workflowId, next);
  emit();
}

export function isLive(workflowId: string): boolean {
  return (counts.get(workflowId) ?? 0) > 0;
}

/** Reactive form; re-renders when liveness of this workflow changes. */
export function useIsLive(workflowId: string | undefined): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (workflowId ? isLive(workflowId) : false),
    () => false,
  );
}
