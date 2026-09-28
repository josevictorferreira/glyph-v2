import { createFileRoute } from "@tanstack/react-router";
import { DefinitionMode } from "@/features/definition";

export const Route = createFileRoute("/workflows/$id/definition")({
  component: DefinitionRoute,
});

function DefinitionRoute() {
  const { id } = Route.useParams();
  return <DefinitionMode workflowId={id} />;
}
