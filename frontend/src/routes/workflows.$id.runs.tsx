import { createFileRoute } from "@tanstack/react-router";
import { RunsPlaceholder } from "@/features/runs";

export const Route = createFileRoute("/workflows/$id/runs")({
  component: RunsPlaceholder,
});
