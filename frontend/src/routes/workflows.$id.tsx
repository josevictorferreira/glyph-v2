import { useCallback } from "react";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useRegisterCommands } from "@/app/commands";
import { LiveConnectionIndicator, LiveProvider } from "@/features/live";
import { useWorkflow, useWorkflowCommands, useWorkflowMutation } from "@/features/workflows";
import { WorkflowService } from "@/gen/glyph/v1/workflow_pb";
import { appErrorToast } from "@/shared/api/errors";
import { useAutosaveField } from "@/shared/lib/autosave";
import { Input, SaveIndicator } from "@/shared/ui";

export const Route = createFileRoute("/workflows/$id")({
  component: WorkspaceLayout,
});

// Workspace layout (spec 0015): one LiveProvider for the whole workspace; the
// header shows the live connection and the aggregate save state.
function WorkspaceLayout() {
  const { id } = Route.useParams();
  useRegisterCommands("workspace", useWorkflowCommands(id));
  return (
    <LiveProvider workflowId={id}>
      <div className="flex h-full flex-col">
        <WorkspaceHeader workflowId={id} />
        <div className="min-h-0 flex-1">
          <Outlet />
        </div>
      </div>
    </LiveProvider>
  );
}

/**
 * Workspace header. Renaming is the only editing affordance until the
 * step editor arrives (spec 0018); it exercises the full 0015 data layer:
 * query → autosave → mutation → live event.
 */
export function WorkspaceHeader({ workflowId }: { workflowId: string }) {
  const { data } = useWorkflow(workflowId);
  const name = data?.workflow?.summary?.name ?? "";
  const { mutateAsync } = useWorkflowMutation(WorkflowService.method.updateWorkflow, {
    onAppError: appErrorToast,
  });

  const saveName = useCallback(
    (next: string) => mutateAsync({ id: workflowId, name: next }).then(() => undefined),
    [mutateAsync, workflowId],
  );
  const field = useAutosaveField({ value: name, save: saveName });

  return (
    <div
      data-testid="workspace-header"
      className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-surface px-3"
    >
      <Input
        aria-label="Workflow name"
        data-testid="workflow-name"
        value={field.value}
        onChange={(e) => field.setValue(e.target.value)}
        onFocus={field.onFocus}
        onBlur={field.onBlur}
        className="h-7 w-64 text-sm font-medium"
      />
      <SaveIndicator status={field.status} onRetry={field.retry} />
      <div className="ml-auto flex items-center gap-2">
        <LiveConnectionIndicator />
      </div>
    </div>
  );
}
