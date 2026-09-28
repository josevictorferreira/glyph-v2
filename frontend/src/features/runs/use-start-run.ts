// StartRun mutation (spec 0016 palette "Run now"). Not an aggregate mutation:
// the response is the created run, so run lists invalidate instead of the
// workflow cache.
import { useTransport } from "@connectrpc/connect-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@connectrpc/connect";
import { RunService } from "@/gen/glyph/v1/run_pb";
import { runKeys } from "@/shared/api/keys";
import { toAppError, type AppError } from "@/shared/api/errors";

export function useStartRun(onAppError?: (err: AppError) => void) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ["glyph.v1.RunService", "startRun"],
    mutationFn: (request: { workflowId: string; values?: Record<string, string> }) =>
      createClient(RunService, transport).startRun({
        workflowId: request.workflowId,
        values: request.values ?? {},
      }),
    onSuccess: (_res, request) => {
      void queryClient.invalidateQueries({ queryKey: runKeys.lists(request.workflowId) });
    },
    onError: (error) => onAppError?.(toAppError(error)),
  });
}
