import { createFileRoute } from "@tanstack/react-router";
import { DefinitionPlaceholder } from "@/features/definition";

export const Route = createFileRoute("/workflows/$id/definition")({
  component: DefinitionPlaceholder,
});
