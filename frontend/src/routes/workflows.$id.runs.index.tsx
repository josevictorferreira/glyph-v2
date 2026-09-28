import { createFileRoute } from "@tanstack/react-router";
import { RunsTable } from "@/features/runs";

export const Route = createFileRoute("/workflows/$id/runs/")({
  component: RunsRoute,
});

function RunsRoute() {
  const { id } = Route.useParams();
  return <RunsTable workflowId={id} />;
}
