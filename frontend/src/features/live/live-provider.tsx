// LiveProvider (spec 0015): mounts the WatchWorkflow subscription for one
// workflow and exposes connection status to the tree via context. Consumed
// by the workspace route; indicators read useLiveStatus().
import { createContext, useContext, type ReactNode } from "react";
import { useWorkflowLive, type LiveStatus } from "./use-workflow-live";
import type { WorkflowEvent } from "@/gen/glyph/v1/live_pb";

const LiveStatusContext = createContext<LiveStatus>("connecting");
const LiveLastSeenContext = createContext<number | undefined>(undefined);

export interface LiveProviderProps {
  workflowId: string;
  onEvent?: (event: WorkflowEvent) => void;
  children: ReactNode;
}

export function LiveProvider({ workflowId, onEvent, children }: LiveProviderProps) {
  const { status, lastEventAt } = useWorkflowLive({ workflowId, onEvent });
  return (
    <LiveStatusContext value={status}>
      <LiveLastSeenContext value={lastEventAt}>{children}</LiveLastSeenContext>
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
