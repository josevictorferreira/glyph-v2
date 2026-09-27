import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { BuildTab } from "@/features/editor";

export const Route = createFileRoute("/workflows/$id/")({
  validateSearch: (search: Record<string, unknown>): { step?: string } => ({
    step: typeof search.step === "string" && search.step.length > 0 ? search.step : undefined,
  }),
  component: BuildRoute,
});

/** Default workspace tab: canvas + contextual editor panel (spec 0017/0018). */
function BuildRoute() {
  const { id } = Route.useParams();
  const { step } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <BuildTab
      workflowId={id}
      selectedStepId={step ?? null}
      onSelectStep={(stepId) => {
        void navigate({ to: ".", search: stepId ? { step: stepId } : {}, replace: true });
      }}
    />
  );
}
