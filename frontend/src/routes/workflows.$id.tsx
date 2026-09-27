import { useCallback } from "react";
import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useRegisterCommands } from "@/app/commands";
import { EditorChromeProvider, ReadinessSheet, WorkspaceHeader } from "@/features/editor";
import { LiveProvider } from "@/features/live";
import { useWorkflowCommands } from "@/features/workflows";

export const Route = createFileRoute("/workflows/$id")({
  component: WorkspaceLayout,
});

// Workspace layout: one LiveProvider for the whole workspace; the editor
// chrome (header + readiness sheet) is shared across the Build/Runs/Definition
// tabs so readiness deep links can navigate back into Build.
function WorkspaceLayout() {
  const { id } = Route.useParams();
  const navigate = useNavigate({ from: Route.fullPath });
  useRegisterCommands("workspace", useWorkflowCommands(id));

  // Deep links select canvas steps through the shared URL (?step=).
  const selectStep = useCallback(
    (stepId: string | null) => {
      void navigate({ to: "/workflows/$id", params: { id }, search: stepId ? { step: stepId } : {} });
    },
    [navigate, id],
  );

  return (
    <LiveProvider workflowId={id}>
      <EditorChromeProvider selectStep={selectStep}>
        <div className="flex h-full flex-col">
          <WorkspaceHeader workflowId={id} />
          <div className="min-h-0 flex-1">
            <Outlet />
          </div>
        </div>
        <ReadinessSheet workflowId={id} />
      </EditorChromeProvider>
    </LiveProvider>
  );
}
