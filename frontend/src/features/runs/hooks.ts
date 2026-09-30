// Named run query hooks (spec 0015).
import { useQuery } from "@connectrpc/connect-query";
import { RunService } from "@/gen/glyph/v1/run_pb";
import type { Run } from "@/gen/glyph/v1/run_pb";
import { useIsLive } from "@/shared/api/liveness";
import { useNow } from "@/shared/lib/time";
import { elapsedMs } from "./lib/run-view";

/**
 * A run's duration, ticking every second while it is live: stored ms once
 * finished, otherwise `activeMs + (now - (resumedAt ?? startedAt))` so the
 * dead time between a failure and a retry never counts (audit ticket 4).
 */
export function useRunDuration(
  run: Pick<Run, "startedAt" | "endedAt" | "elapsedMs" | "activeMs" | "resumedAt">,
): number | undefined {
  const now = useNow(1000).getTime();
  return elapsedMs(run, now);
}

/** Runs of one workflow, newest first. */
export function useRuns(workflowId: string, limit = 20) {
  const live = useIsLive(workflowId);
  return useQuery(
    RunService.method.listRuns,
    { workflowId, limit },
    { staleTime: live ? Infinity : 30_000, enabled: workflowId.length > 0 },
  );
}

export function useRun(workflowId: string, runId: string) {
  const live = useIsLive(workflowId);
  return useQuery(
    RunService.method.getRun,
    { workflowId, runId },
    { staleTime: live ? Infinity : 30_000, enabled: workflowId.length > 0 && runId.length > 0 },
  );
}

export function useStepRun(workflowId: string, runId: string, stepRunId: string) {
  const live = useIsLive(workflowId);
  return useQuery(
    RunService.method.getStepRun,
    { workflowId, runId, stepRunId },
    { staleTime: live ? Infinity : 30_000, enabled: runId.length > 0 && stepRunId.length > 0 },
  );
}
