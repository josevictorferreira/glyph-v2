import { createFileRoute, Outlet } from "@tanstack/react-router";

// Runs mode: history (index) and the run lens ($runId).
export const Route = createFileRoute("/workflows/$id/runs")({
  component: Outlet,
});
