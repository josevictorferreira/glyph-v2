// useWorkflowLive (spec 0015): one WatchWorkflow server-streaming
// subscription per workflow. Events carry ids only, so each event maps to
// query invalidations; RESYNC invalidates everything. Reconnects with
// exponential backoff (1s → 30s, ±25% jitter). PROGRESS events are throttled
// to one invalidation per step run per 2s, and only when that step run is
// actually observed (its query exists in the cache).
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createClient } from "@connectrpc/connect";
import { useTransport } from "@connectrpc/connect-query";
import { EventType, LiveService, type WorkflowEvent } from "@/gen/glyph/v1/live_pb";
import { runKeys, workflowKeys } from "@/shared/api/keys";
import { markLive } from "@/shared/api/liveness";
import type { LiveStatus } from "@/shared/api/live";

export type { LiveStatus };

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const PROGRESS_THROTTLE_MS = 2_000;
/** consecutive failed attempts after which we report "offline" (still retrying) */
const OFFLINE_AFTER_ATTEMPTS = 5;

export interface UseWorkflowLiveOptions {
  workflowId: string;
  /** Extra routing per event (e.g. navigate away on RUN_DELETED). */
  onEvent?: (event: WorkflowEvent) => void;
}

export interface WorkflowLiveState {
  status: LiveStatus;
  /** Epoch ms of the last received event (HEARTBEAT included). */
  lastEventAt: number | undefined;
}

export function useWorkflowLive({ workflowId, onEvent }: UseWorkflowLiveOptions): WorkflowLiveState {
  const queryClient = useQueryClient();
  const transport = useTransport();
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [lastEventAt, setLastEventAt] = useState<number | undefined>(undefined);
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  // Register liveness so query hooks can serve cached data (staleTime ∞).
  useEffect(() => {
    markLive(workflowId, true);
    return () => markLive(workflowId, false);
  }, [workflowId]);

  useEffect(() => {
    let cancelled = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const client = createClient(LiveService, transport);
    const progressAt = new Map<string, number>();

    const isStepRunObserved = (runId: string, stepRunId: string) =>
      queryClient.getQueryState(runKeys.stepRun(workflowId, runId, stepRunId, transport)) !== undefined;

    const handleEvent = (ev: WorkflowEvent) => {
      const ts = ev.occurredAt;
      setLastEventAt(ts ? Number(ts.seconds) * 1000 + Math.round(ts.nanos / 1e6) : Date.now());
      const wid = ev.workflowId.length > 0 ? ev.workflowId : workflowId;
      switch (ev.type) {
        case EventType.WORKFLOW_UPDATED:
          void queryClient.invalidateQueries({ queryKey: workflowKeys.lists() });
          void queryClient.invalidateQueries({ queryKey: workflowKeys.detail(wid) });
          break;
        case EventType.RUN_QUEUED:
        case EventType.RUN_STARTED:
        case EventType.RUN_SUCCEEDED:
        case EventType.RUN_FAILED:
        case EventType.RUN_CANCELLED:
          void queryClient.invalidateQueries({ queryKey: runKeys.lists(wid) });
          void queryClient.invalidateQueries({ queryKey: workflowKeys.detail(wid) });
          void queryClient.invalidateQueries({ queryKey: workflowKeys.lists() });
          if (ev.runId !== undefined && ev.runId.length > 0) {
            void queryClient.invalidateQueries({ queryKey: runKeys.detail(wid, ev.runId) });
          }
          break;
        case EventType.RUN_DELETED:
          void queryClient.invalidateQueries({ queryKey: runKeys.lists(wid) });
          void queryClient.invalidateQueries({ queryKey: workflowKeys.detail(wid) });
          if (ev.runId !== undefined && ev.runId.length > 0) {
            // Evidence of a deleted run must not linger in the cache.
            void queryClient.removeQueries({ queryKey: runKeys.detail(wid, ev.runId, transport) });
          }
          break;
        case EventType.STEP_RUN_QUEUED:
        case EventType.STEP_RUN_STARTED:
        case EventType.STEP_RUN_SUCCEEDED:
        case EventType.STEP_RUN_FAILED:
        case EventType.STEP_RUN_SKIPPED:
        case EventType.STEP_RUN_CANCELLED:
          if (ev.runId !== undefined && ev.runId.length > 0) {
            void queryClient.invalidateQueries({ queryKey: runKeys.detail(wid, ev.runId) });
          }
          if (
            ev.runId !== undefined &&
            ev.runId.length > 0 &&
            ev.stepRunId !== undefined &&
            ev.stepRunId.length > 0 &&
            isStepRunObserved(ev.runId, ev.stepRunId)
          ) {
            void queryClient.invalidateQueries({
              queryKey: runKeys.stepRun(wid, ev.runId, ev.stepRunId),
            });
          }
          break;
        case EventType.STEP_RUN_PROGRESS:
          // High-frequency: only if observed, at most one invalidation per 2s.
          if (
            ev.runId !== undefined &&
            ev.runId.length > 0 &&
            ev.stepRunId !== undefined &&
            ev.stepRunId.length > 0 &&
            isStepRunObserved(ev.runId, ev.stepRunId)
          ) {
            const now = Date.now();
            const last = progressAt.get(ev.stepRunId);
            if (last === undefined || now - last >= PROGRESS_THROTTLE_MS) {
              progressAt.set(ev.stepRunId, now);
              void queryClient.invalidateQueries({
                queryKey: runKeys.stepRun(wid, ev.runId, ev.stepRunId),
              });
            }
          }
          break;
        case EventType.RESYNC:
          // Events may have been missed: refetch everything.
          void queryClient.invalidateQueries();
          break;
        case EventType.HEARTBEAT:
          break; // connection freshness only
        default:
          break;
      }
      onEventRef.current?.(ev);
    };

    const scheduleReconnect = () => {
      setStatus(attempt >= OFFLINE_AFTER_ATTEMPTS ? "offline" : "reconnecting");
      const base = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
      const delay = base * (0.75 + Math.random() / 2); // ±25% jitter
      attempt += 1;
      reconnectTimer = setTimeout(() => {
        controller = connect();
      }, delay);
    };

    const connect = (): AbortController => {
      setStatus(attempt === 0 ? "connecting" : attempt >= OFFLINE_AFTER_ATTEMPTS ? "offline" : "reconnecting");
      const ac = new AbortController();
      void (async () => {
        try {
          for await (const res of client.watchWorkflow({ workflowId }, { signal: ac.signal })) {
            if (cancelled) return;
            attempt = 0;
            setStatus("connected");
            if (res.event) handleEvent(res.event);
          }
          if (!cancelled) scheduleReconnect(); // server closed the stream
        } catch {
          if (!cancelled) scheduleReconnect();
        }
      })();
      return ac;
    };

    controller = connect();

    return () => {
      cancelled = true;
      controller?.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [workflowId, transport, queryClient]);

  return { status, lastEventAt };
}
