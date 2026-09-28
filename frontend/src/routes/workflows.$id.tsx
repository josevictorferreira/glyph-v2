import { useCallback } from "react";
import { createFileRoute, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { useRegisterCommands } from "@/app/commands";
import {
  EditorChromeProvider,
  ReadinessSheet,
  useEditorChrome,
  WorkspaceHeader,
} from "@/features/editor";
import { LiveProvider } from "@/features/live";
import { RunSheetProvider, RunStrip } from "@/features/runs";
import { useWorkflowCommands } from "@/features/workflows";

export const Route = createFileRoute("/workflows/$id")({
  component: WorkspaceLayout,
});

// Workspace layout: one LiveProvider for the whole workspace; the editor
// chrome (header + readiness sheet) is shared across the Build/Runs/Definition
// tabs so readiness deep links can navigate back into Build.
function WorkspaceLayout() {
  const { id } = Route.useParams();
  const { runId: activeRunId } = useParams({ strict: false });
  const navigate = useNavigate({ from: Route.fullPath });

  // Deep links select canvas steps through the shared URL (?step=).
  const selectStep = useCallback(
    (stepId: string | null) => {
      void navigate({
        to: "/workflows/$id",
        params: { id },
        search: stepId ? { step: stepId } : {},
      });
    },
    [navigate, id],
  );

  return (
    <LiveProvider workflowId={id}>
      <EditorChromeProvider selectStep={selectStep}>
        <WorkspaceRunSheet workflowId={id}>
          <div className="flex h-full flex-col">
            <WorkspaceHeader workflowId={id} />
            <div className="min-h-0 flex-1">
              <Outlet />
            </div>
            <RunStrip workflowId={id} activeRunId={activeRunId} />
          </div>
        </WorkspaceRunSheet>
        <ReadinessSheet workflowId={id} />
      </EditorChromeProvider>
    </LiveProvider>
  );
}

/** The run sheet sends "Review issues" to the readiness sheet. */
function WorkspaceRunSheet({
  workflowId,
  children,
}: {
  workflowId: string;
  children: React.ReactNode;
}) {
  const { setReadinessOpen } = useEditorChrome();
  return (
    <RunSheetProvider workflowId={workflowId} onReviewIssues={() => setReadinessOpen(true)}>
      <WorkspaceCommands workflowId={workflowId} />
      {children}
    </RunSheetProvider>
  );
}

/** Palette actions for this workflow ("Run now" goes through the run sheet). */
function WorkspaceCommands({ workflowId }: { workflowId: string }) {
  useRegisterCommands("workspace", useWorkflowCommands(workflowId));
  return null;
}
