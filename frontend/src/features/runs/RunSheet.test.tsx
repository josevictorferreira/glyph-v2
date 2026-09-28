// Run sheet tests (spec 0020 task 1): immediate start without required asked
// values, prefill from the latest run, draft banner, pre-flight block,
// client-side missing values, StartRun payload and navigation.
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { create } from "@bufbuild/protobuf";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { WorkflowStatus } from "@/gen/glyph/v1/common_pb";
import type { Issue } from "@/gen/glyph/v1/common_pb";
import { RunSchema } from "@/gen/glyph/v1/run_pb";
import type { StartRunRequest } from "@/gen/glyph/v1/run_pb";
import { WorkflowSchema } from "@/gen/glyph/v1/workflow_pb";
import type { WorkflowInput } from "@/gen/glyph/v1/workflow_pb";
import { renderWithApp } from "@test/render";
import { RunSheetProvider, useRunSheet } from "./RunSheet";

function Trigger() {
  const { runNow } = useRunSheet();
  return (
    <button type="button" onClick={runNow}>
      Trigger run
    </button>
  );
}

function mount(opts: {
  status?: WorkflowStatus;
  inputs?: Array<Partial<WorkflowInput>>;
  issues?: Issue[];
  lastSupplied?: Record<string, string>;
}) {
  const requests: StartRunRequest[] = [];
  const workflow = create(WorkflowSchema, {
    summary: { id: "wf-1", name: "Digest", status: opts.status ?? WorkflowStatus.ACTIVE },
    inputs: (opts.inputs ?? []) as never,
  });
  const rootRoute = createRootRoute();
  const home = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <RunSheetProvider workflowId="wf-1" onReviewIssues={() => {}}>
        <Trigger />
      </RunSheetProvider>
    ),
  });
  const lens = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflows/$id/runs/$runId",
    component: () => <p>lens page</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([home, lens]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  renderWithApp(<RouterProvider router={router} />, {
    services: {
      workflow: { getWorkflow: async () => ({ workflow, issues: opts.issues ?? [] }) },
      run: {
        listRuns: async () => ({
          runs: opts.lastSupplied
            ? [create(RunSchema, { id: "old", suppliedValues: opts.lastSupplied })]
            : [],
        }),
        startRun: async (req: StartRunRequest) => {
          requests.push(req);
          return { run: create(RunSchema, { id: "run-9", workflowId: "wf-1" }) };
        },
      },
    },
  });
  return { requests, router };
}

describe("run sheet (spec 0020)", () => {
  it("starts immediately when no required value is asked", async () => {
    const { requests } = mount({
      inputs: [{ id: "a", name: "tone", askAtRunTime: true, required: false }],
    });
    await userEvent.click(await screen.findByRole("button", { name: "Trigger run" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.values).toEqual({});
    expect(await screen.findByText("Run started")).toBeVisible();
    expect(screen.queryByTestId("run-sheet")).toBeNull();
  });

  it("prefills from the latest run, sends values and opens the new run", async () => {
    const { requests, router } = mount({
      inputs: [
        { id: "a", name: "topic", askAtRunTime: true, required: true },
        { id: "c", name: "style", askAtRunTime: false, required: true, value: "short" },
      ],
      lastSupplied: { topic: "rust" },
    });
    await userEvent.click(await screen.findByRole("button", { name: "Trigger run" }));
    const field = await screen.findByLabelText("topic");
    await waitFor(() => expect(field).toHaveValue("rust"));
    expect(screen.getByText("Used last time")).toBeVisible();
    expect(screen.getByText("Fixed values (1)")).toBeVisible();

    await userEvent.clear(field);
    await userEvent.type(field, "zig");
    await userEvent.click(screen.getByTestId("start-run"));
    await waitFor(() => expect(requests[0]?.values).toEqual({ topic: "zig" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/workflows/wf-1/runs/run-9"));
  });

  it("flags a blank required value without calling the backend", async () => {
    const { requests } = mount({
      inputs: [{ id: "a", name: "topic", askAtRunTime: true, required: true }],
    });
    await userEvent.click(await screen.findByRole("button", { name: "Trigger run" }));
    await userEvent.click(await screen.findByTestId("start-run"));
    expect(screen.getByText("Provide a value for this run.")).toBeVisible();
    expect(requests).toHaveLength(0);
  });

  it("labels draft test runs and blocks Start while issues exist", async () => {
    mount({
      status: WorkflowStatus.DRAFT,
      inputs: [{ id: "a", name: "topic", askAtRunTime: true, required: true }],
      issues: [
        {
          entityType: 2,
          entityId: "s1",
          field: "prompt",
          message: "“Research” needs a prompt.",
        } as never,
      ],
    });
    await userEvent.click(await screen.findByRole("button", { name: "Trigger run" }));
    expect(await screen.findByTestId("draft-test-banner")).toHaveTextContent(
      "This is a test run of a draft. It won't activate the workflow.",
    );
    expect(screen.getByText("“Research” needs a prompt.")).toBeVisible();
    expect(screen.getByTestId("start-run")).toBeDisabled();
  });
});
