// Run lens tests (spec 0020 task 3–4): header evidence, failure banner, a
// failed run opening on its first failed step, stale-snapshot note, stop,
// timeline view, and canvas clicks selecting step runs.
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  RunStatus,
  RunTrigger,
  StepKind,
  StepRunStatus,
  WorkflowStatus,
} from "@/gen/glyph/v1/common_pb";
import { RunSchema, StepRunSchema } from "@/gen/glyph/v1/run_pb";
import type { GetStepRunRequest, Run, StopRunRequest } from "@/gen/glyph/v1/run_pb";
import { WorkflowSchema } from "@/gen/glyph/v1/workflow_pb";
import { renderWithApp } from "@test/render";
import { RunLens, type RunLensView } from "./RunLens";

function fixture(status: RunStatus): Run {
  return create(RunSchema, {
    id: "r1",
    workflowId: "wf",
    status,
    trigger: RunTrigger.MANUAL,
    queuedAt: timestampFromMs(1_000),
    startedAt: timestampFromMs(2_000),
    endedAt: status === RunStatus.FAILED ? timestampFromMs(4_000) : undefined,
    failureSummary: status === RunStatus.FAILED ? "The Writer step could not complete." : undefined,
    firstFailedStepRunId: status === RunStatus.FAILED ? "sr-2" : undefined,
    suppliedValues: { topic: "rust" },
    snapshot: {
      capturedAt: timestampFromMs(1_000),
      steps: [
        {
          id: "ss-1",
          kind: StepKind.PI,
          name: "Research",
          outputName: "notes",
          canvasX: 0,
          canvasY: 0,
        },
        {
          id: "ss-2",
          kind: StepKind.PI,
          name: "Writer",
          outputName: "draft",
          canvasX: 300,
          canvasY: 0,
        },
      ],
      connections: [],
    },
    stepRuns: [
      {
        id: "sr-1",
        snapshotStepId: "ss-1",
        stepName: "Research",
        status: StepRunStatus.SUCCEEDED,
        position: 0,
        startedAt: timestampFromMs(2_000),
        endedAt: timestampFromMs(3_000),
      },
      {
        id: "sr-2",
        snapshotStepId: "ss-2",
        stepName: "Writer",
        status: status === RunStatus.FAILED ? StepRunStatus.FAILED : StepRunStatus.RUNNING,
        position: 1,
        startedAt: timestampFromMs(3_000),
        humanError: status === RunStatus.FAILED ? "The selected model is unavailable." : undefined,
      },
    ],
  });
}

function mount(status: RunStatus, opts: { step?: string; view?: RunLensView } = {}) {
  const stops: StopRunRequest[] = [];
  const onNavigate = vi.fn();
  const run = fixture(status);
  const ui = (
    <div className="h-[700px] w-[1000px]">
      <RunLens
        workflowId="wf"
        runId="r1"
        stepRunId={opts.step ?? null}
        view={opts.view ?? "graph"}
        onNavigate={onNavigate}
      />
    </div>
  );
  const router = createRouter({
    routeTree: createRootRoute({ component: () => ui }),
    history: createMemoryHistory(),
  });
  renderWithApp(<RouterProvider router={router} />, {
    services: {
      workflow: {
        getWorkflow: async () => ({
          // Edited after the snapshot was captured.
          workflow: create(WorkflowSchema, {
            summary: { id: "wf", status: WorkflowStatus.ACTIVE, updatedAt: timestampFromMs(9_000) },
          }),
          issues: [],
        }),
      },
      run: {
        getRun: async () => ({ run }),
        getStepRun: async (req: GetStepRunRequest) => ({
          stepRun: create(StepRunSchema, {
            summary: run.stepRuns.find((s) => s.id === req.stepRunId),
            downloadPath: "/d",
          }),
        }),
        stopRun: async (req: StopRunRequest) => {
          stops.push(req);
          return { run };
        },
      },
    },
  });
  return { stops, onNavigate };
}

describe("RunLens", () => {
  it("opens a failed run on its first failed step with the human error", async () => {
    mount(RunStatus.FAILED);
    expect(await screen.findByTestId("failure-banner")).toHaveTextContent(
      "The Writer step could not complete.",
    );
    const panel = await screen.findByTestId("step-run-panel");
    expect(within(panel).getByText("Writer")).toBeVisible();
    expect(await within(panel).findByText("The selected model is unavailable.")).toBeVisible();
  });

  it("shows run evidence in the header and notes an outdated snapshot", async () => {
    mount(RunStatus.FAILED);
    const header = await screen.findByTestId("run-header");
    expect(header).toHaveTextContent("Failed");
    expect(header).toHaveTextContent("Manual");
    await waitFor(() =>
      expect(screen.getByTestId("snapshot-note")).toHaveTextContent(
        "This run used an earlier version of the workflow.",
      ),
    );
    expect(screen.getByText("Supplied values (1)")).toBeVisible();
  });

  it("stops a live run", async () => {
    const { stops } = mount(RunStatus.RUNNING);
    await userEvent.click(await screen.findByTestId("stop-run"));
    await waitFor(() => expect(stops[0]).toMatchObject({ workflowId: "wf", runId: "r1" }));
  });

  it("switches to the timeline and selects step runs from it", async () => {
    const { onNavigate } = mount(RunStatus.RUNNING, { view: "timeline" });
    const rows = await screen.findAllByTestId("timeline-row");
    expect(rows.map((r) => r.textContent)).toEqual(["Research", "Writer"]);
    await userEvent.click(rows[0]!);
    expect(onNavigate).toHaveBeenCalledWith({ step: "sr-1", view: "timeline" });
  });

  it("selects a step run by clicking its card", async () => {
    const { onNavigate } = mount(RunStatus.RUNNING);
    await userEvent.click(await screen.findByTestId("step-card-ss-1"));
    expect(onNavigate).toHaveBeenCalledWith({ step: "sr-1", view: "graph" });
  });
});
