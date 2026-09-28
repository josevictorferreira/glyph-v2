// Workspace command palette scope (spec 0016): actions for the current
// workflow, registered while the workspace layout is mounted.
import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useTransport } from "@connectrpc/connect-query";
import { WorkflowStatus } from "@/gen/glyph/v1/common_pb";
import { DefinitionService } from "@/gen/glyph/v1/definition_pb";
import { WorkflowService } from "@/gen/glyph/v1/workflow_pb";
import { createClient } from "@connectrpc/connect";
import type { CommandDef } from "@/app/commands";
import { useRunSheet } from "@/features/runs";
import { useWorkflow } from "./hooks";
import { useWorkflowMutation } from "./use-workflow-mutation";
import { appErrorToast } from "@/shared/api/errors";

/** Commands for the open workflow; register with useRegisterCommands. */
export function useWorkflowCommands(workflowId: string): CommandDef[] {
  const navigate = useNavigate();
  const transport = useTransport();
  const { data } = useWorkflow(workflowId);
  const workflow = data?.workflow;
  const status = workflow?.summary?.status;
  const { runNow } = useRunSheet();

  const lifecycleArgs = { onAppError: appErrorToast } as const;
  const activate = useWorkflowMutation(WorkflowService.method.activateWorkflow, lifecycleArgs);
  const pause = useWorkflowMutation(WorkflowService.method.pauseWorkflow, lifecycleArgs);
  const resume = useWorkflowMutation(WorkflowService.method.resumeWorkflow, lifecycleArgs);

  return useMemo<CommandDef[]>(() => {
    const actions: CommandDef[] = [
      {
        id: `wf:${workflowId}:run`,
        group: "Actions",
        label: "Run now",
        keywords: "start execute",
        run: runNow,
      },
    ];
    if (status === WorkflowStatus.DRAFT) {
      actions.push({
        id: `wf:${workflowId}:activate`,
        group: "Actions",
        label: "Activate workflow",
        run: () => void activate.mutateAsync({ id: workflowId }),
      });
    } else if (status === WorkflowStatus.ACTIVE) {
      actions.push({
        id: `wf:${workflowId}:pause`,
        group: "Actions",
        label: "Pause workflow",
        run: () => void pause.mutateAsync({ id: workflowId }),
      });
    } else if (status === WorkflowStatus.PAUSED) {
      actions.push({
        id: `wf:${workflowId}:resume`,
        group: "Actions",
        label: "Resume workflow",
        run: () => void resume.mutateAsync({ id: workflowId }),
      });
    }
    actions.push(
      {
        id: `wf:${workflowId}:export`,
        group: "Actions",
        label: "Export YAML",
        keywords: "download definition",
        run: async () => {
          const exported = await createClient(DefinitionService, transport).exportDefinition({
            workflowId,
          });
          const url = URL.createObjectURL(new Blob([exported.yaml], { type: "text/yaml" }));
          const a = document.createElement("a");
          a.href = url;
          a.download = exported.filename || "workflow.yml";
          a.click();
          URL.revokeObjectURL(url);
        },
      },
      {
        id: `wf:${workflowId}:definition`,
        group: "Actions",
        label: "Open definition",
        keywords: "yaml",
        run: () => void navigate({ to: "/workflows/$id/definition", params: { id: workflowId } }),
      },
    );

    const steps: CommandDef[] = (workflow?.steps ?? []).map((s) => ({
      id: `wf:${workflowId}:step-${s.id}`,
      group: "Steps",
      label: `Go to step ${s.name}`,
      keywords: "jump canvas",
      run: () =>
        void navigate({ to: "/workflows/$id", params: { id: workflowId }, hash: `step-${s.id}` }),
    }));
    return [...actions, ...steps];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mutateAsync identities are stable in v5; commands refresh when workflow data changes
  }, [
    workflowId,
    status,
    workflow?.steps,
    navigate,
    transport,
    activate.mutateAsync,
    pause.mutateAsync,
    resume.mutateAsync,
    runNow,
  ]);
}
