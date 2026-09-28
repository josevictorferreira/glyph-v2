import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { RunLens, type RunLensView } from "@/features/runs";

interface LensSearch {
  step?: string;
  view?: RunLensView;
}

export const Route = createFileRoute("/workflows/$id/runs/$runId")({
  validateSearch: (search: Record<string, unknown>): LensSearch => ({
    step: typeof search.step === "string" && search.step.length > 0 ? search.step : undefined,
    view: search.view === "timeline" ? "timeline" : undefined,
  }),
  component: RunLensRoute,
});

/** Run lens: ?step= selects a step run, ?view=timeline switches the view. */
function RunLensRoute() {
  const { id, runId } = Route.useParams();
  const { step, view } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <RunLens
      workflowId={id}
      runId={runId}
      stepRunId={step ?? null}
      view={view ?? "graph"}
      onNavigate={(next) =>
        void navigate({
          to: ".",
          search: { step: next.step, view: next.view === "timeline" ? "timeline" : undefined },
          replace: true,
        })
      }
    />
  );
}
