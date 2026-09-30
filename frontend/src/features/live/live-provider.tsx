// LiveProvider (spec 0015): mounts the WatchWorkflow subscription for one
// workflow and exposes connection status to the tree via context. Consumed
// by the workspace route; indicators read useLiveStatus().
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useWorkflowLive, type LiveStatus } from "./use-workflow-live";
import type { WorkflowEvent } from "@/gen/glyph/v1/live_pb";

const LiveStatusContext = createContext<LiveStatus>("connecting");
const LiveLastSeenContext = createContext<number | undefined>(undefined);
const EventListenersContext = createContext<Set<(event: WorkflowEvent) => void> | null>(null);

type EventListener = (event: WorkflowEvent) => void;

export interface LiveProviderProps {
  workflowId: string;
  onEvent?: (event: WorkflowEvent) => void;
  children: ReactNode;
}

export function LiveProvider({ workflowId, onEvent, children }: LiveProviderProps) {
  // Stable Set held in state: readable during render for the context value.
  const [listeners] = useState(() => new Set<EventListener>());
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  });
  // Query invalidations run first (use-workflow-live); subscribers see the
  // event after the cache is already refreshing.
  const fanOut = (event: WorkflowEvent) => {
    onEventRef.current?.(event);
    for (const listener of listeners) listener(event);
  };
  const { status, lastEventAt } = useWorkflowLive({ workflowId, onEvent: fanOut });
  return (
    <LiveStatusContext value={status}>
      <LiveLastSeenContext value={lastEventAt}>
        <EventListenersContext value={listeners}>{children}</EventListenersContext>
      </LiveLastSeenContext>
    </LiveStatusContext>
  );
}

/** Connection status of the enclosing workflow's live subscription. */
export function useLiveStatus(): LiveStatus {
  return useContext(LiveStatusContext);
}

/** Epoch ms of the last event; undefined before the first one. */
export function useLiveLastSeen(): number | undefined {
  return useContext(LiveLastSeenContext);
}

/** Subscribe to the enclosing workflow's live events (spec 0021, e.g. the
 * definition mode's silent re-export while clean). */
export function useWorkflowEvents(handler: EventListener) {
  const listeners = useContext(EventListenersContext);
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(() => {
    if (!listeners) return; // no provider: tests and standalone mounts
    const listener: EventListener = (event) => handlerRef.current(event);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [listeners]);
}
