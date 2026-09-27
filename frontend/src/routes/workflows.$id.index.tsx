import { useCallback } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { WorkflowCanvas } from "@/features/canvas";
import { useWorkflow } from "@/features/workflows";
import { Skeleton } from "@/shared/ui";

export const Route = createFileRoute("/workflows/$id/")({
  validateSearch: (search: Record<string, unknown>): { step?: string } => ({
    step: typeof search.step === "string" && search.step.length > 0 ? search.step : undefined,
  }),
  component: CanvasTab,
});

/** Default workspace tab: the DAG canvas (spec 0017), selection in ?step=. */
function CanvasTab() {
  const { id } = Route.useParams();
  const { step } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data, isLoading } = useWorkflow(id);
  const workflow = data?.workflow;

  const setStep = useCallback(
    (stepId: string | null) => {
      void navigate({ to: ".", search: stepId ? { step: stepId } : {}, replace: true });
    },
    [navigate],
  );

  if (isLoading || !workflow) {
    return <Skeleton className="h-full w-full" />;
  }

  return (
    <WorkflowCanvas
      mode="build"
      workflow={workflow}
      issues={data.issues}
      selectedStepId={step ?? null}
      onSelectStep={setStep}
      onOpenStep={setStep}
      onImportYaml={() => void navigate({ to: "/workflows/$id/definition", params: { id } })}
    />
  );
}
