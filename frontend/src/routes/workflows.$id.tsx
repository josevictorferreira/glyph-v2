import { useCallback, useEffect } from "react";
import {
  createFileRoute,
  Link,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { useRegisterCommands } from "@/app/commands";
import { useWorkflow } from "@/features/workflows";
import {
  EditorChromeProvider,
  ReadinessSheet,
  useEditorChrome,
  WorkspaceHeader,
} from "@/features/editor";
import { LiveProvider } from "@/features/live";
import { RunSheetProvider, RunStrip } from "@/features/runs";
import { useWorkflowCommands } from "@/features/workflows";
import { toAppError } from "@/shared/api/errors";
import { Button, Skeleton } from "@/shared/ui";

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
  const { data, isLoading, error } = useWorkflow(id);

  const location = useLocation();

  // Set document.title and update on tab/workflow change (fixes.md #12)
  useEffect(() => {
    const name = data?.workflow?.summary?.name;
    if (!name) return;
    let tab = "Build";
    if (location.pathname.includes("/runs")) tab = "Runs";
    else if (location.pathname.includes("/definition")) tab = "Definition";
    document.title = `${name} · ${tab} — Glyph`;
    return () => {
      document.title = "Glyph";
    };
  }, [data?.workflow?.summary?.name, location.pathname]);

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

  // A deleted/never-existed workflow id is a dead end, not a skeleton: the
  // 404 is terminal (no retry), so branch as soon as it arrives (audit 2).
  if (error && toAppError(error).kind === "not_found") {
    return <WorkflowNotFound />;
  }
  if (isLoading || (!data?.workflow && !error)) {
    return (
      <div className="flex h-full flex-col">
        <Skeleton className="h-10 w-full rounded-none" />
        <div className="min-h-0 flex-1">
          <Skeleton className="h-full w-full" />
        </div>
      </div>
    );
  }

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

function WorkflowNotFound() {
  return (
    <div className="grid h-full place-items-center p-6" data-testid="workflow-not-found">
      <div className="max-w-md text-center">
        <p className="text-sm font-semibold">Workflow not found</p>
        <p className="mt-1 text-xs text-ink-muted">
          It may have been deleted, or the address is wrong.
        </p>
        <div className="mt-4 flex justify-center gap-2">
          <Link to="/">
            <Button>Back to Home</Button>
          </Link>
        </div>
      </div>
    </div>
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
