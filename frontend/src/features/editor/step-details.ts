// Step details autosave (spec 0018): name (editor header) + description and
// allow failure (Settings tab) share one UpdateStepDetails payload.
import { useCallback } from "react";
import { WorkflowService } from "@/gen/glyph/v1/workflow_pb";
import type { Step } from "@/gen/glyph/v1/workflow_pb";
import { useWorkflowMutation } from "@/features/workflows";
import { appErrorToast } from "@/shared/api/errors";
import { useAutosaveField } from "@/shared/lib/autosave";

/** Fields saved together by UpdateStepDetails (name header + Settings tab). */
export interface StepDetailsValue {
  name: string;
  description: string;
  allowFailure: boolean;
}

export function useStepDetailsField(workflowId: string, step: Step) {
  const { mutateAsync } = useWorkflowMutation(WorkflowService.method.updateStepDetails, {
    onAppError: appErrorToast,
  });
  const save = useCallback(
    (next: StepDetailsValue) =>
      mutateAsync({
        workflowId,
        stepId: step.id,
        name: next.name,
        description: next.description || undefined,
        allowFailure: next.allowFailure,
      }).then(() => undefined),
    [mutateAsync, workflowId, step.id],
  );
  return useAutosaveField<StepDetailsValue>({
    value: {
      name: step.name,
      description: step.description ?? "",
      allowFailure: step.allowFailure,
    },
    save,
    equals: (a, b) =>
      a.name === b.name && a.description === b.description && a.allowFailure === b.allowFailure,
  });
}
