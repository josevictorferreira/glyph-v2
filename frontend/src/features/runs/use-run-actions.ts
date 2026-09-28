// Stop / retry / delete (spec 0020). Stop and retry return the updated run,
// which replaces the GetRun cache; delete drops the run's evidence from the
// cache. Backend reasons (RUN_FINISHED, STEP_NOT_FAILED, …) surface verbatim.
import { createClient } from "@connectrpc/connect";
import { useTransport } from "@connectrpc/connect-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { create } from "@bufbuild/protobuf";
import { GetRunResponseSchema, RunService } from "@/gen/glyph/v1/run_pb";
import type { Run } from "@/gen/glyph/v1/run_pb";
import { toAppError, type AppError } from "@/shared/api/errors";
import { runKeys, workflowKeys } from "@/shared/api/keys";

interface RunRef {
  workflowId: string;
  runId: string;
}

function useRunCache() {
  const queryClient = useQueryClient();
  const transport = useTransport();
  return {
    client: createClient(RunService, transport),
    put(run: Run | undefined) {
      if (!run) return;
      queryClient.setQueryData(
        runKeys.detail(run.workflowId, run.id, transport),
        create(GetRunResponseSchema, { run }),
      );
      void queryClient.invalidateQueries({ queryKey: runKeys.lists(run.workflowId) });
    },
    drop({ workflowId, runId }: RunRef) {
      queryClient.removeQueries({ queryKey: runKeys.detail(workflowId, runId, transport) });
      void queryClient.invalidateQueries({ queryKey: runKeys.lists(workflowId) });
      void queryClient.invalidateQueries({ queryKey: workflowKeys.detail(workflowId) });
    },
  };
}

export function useStopRun(onAppError?: (err: AppError) => void) {
  const cache = useRunCache();
  return useMutation({
    mutationFn: (ref: RunRef) => cache.client.stopRun(ref),
    onSuccess: (res) => cache.put(res.run),
    onError: (e) => onAppError?.(toAppError(e)),
  });
}

export function useRetryStep(onAppError?: (err: AppError) => void) {
  const cache = useRunCache();
  return useMutation({
    mutationFn: (ref: RunRef & { stepRunId: string }) => cache.client.retryStep(ref),
    onSuccess: (res) => cache.put(res.run),
    onError: (e) => onAppError?.(toAppError(e)),
  });
}

export function useDeleteRun(onAppError?: (err: AppError) => void) {
  const cache = useRunCache();
  return useMutation({
    mutationFn: (ref: RunRef) => cache.client.deleteRun(ref).then(() => ref),
    onSuccess: (ref) => cache.drop(ref),
    onError: (e) => onAppError?.(toAppError(e)),
  });
}
