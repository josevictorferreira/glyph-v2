// DeleteWorkflow (no aggregate comes back): drop the workflow's cached
// detail and refresh the lists. WORKFLOW_HAS_RUNS surfaces verbatim via
// AppError.
import { createClient } from "@connectrpc/connect";
import { useTransport } from "@connectrpc/connect-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { WorkflowService } from "@/gen/glyph/v1/workflow_pb";
import { toAppError, type AppError } from "@/shared/api/errors";
import { workflowKeys } from "@/shared/api/keys";

export function useDeleteWorkflow(onAppError?: (err: AppError) => void) {
  const queryClient = useQueryClient();
  const transport = useTransport();
  const client = createClient(WorkflowService, transport);
  return useMutation({
    mutationFn: (id: string) => client.deleteWorkflow({ id }).then(() => id),
    onSuccess: (id) => {
      queryClient.removeQueries({ queryKey: workflowKeys.detail(id, transport) });
      void queryClient.invalidateQueries({ queryKey: workflowKeys.lists() });
    },
    onError: (e) => onAppError?.(toAppError(e)),
  });
}
