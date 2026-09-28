// Home overview tests (spec 0016): sections from list data, empty state.
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { RunStatus, WorkflowStatus } from "@/gen/glyph/v1/common_pb";
import { ListRunsResponseSchema, RunSchema } from "@/gen/glyph/v1/run_pb";
import { ListWorkflowsResponseSchema, WorkflowSummarySchema } from "@/gen/glyph/v1/workflow_pb";
import { ValidateWorkflowResponseSchema } from "@/gen/glyph/v1/workflow_pb";
import type { WorkflowSummary } from "@/gen/glyph/v1/workflow_pb";
import { renderWithApp } from "@test/render";

const ts = (iso: string) =>
  create(TimestampSchema, { seconds: BigInt(Date.parse(iso) / 1000), nanos: 0 });

const summary = (id: string, init: Record<string, unknown> = {}): WorkflowSummary =>
  create(WorkflowSummarySchema, {
    id,
    name: `Workflow ${id}`,
    status: WorkflowStatus.DRAFT,
    updatedAt: ts("2026-01-15T10:00:00Z"),
    ...init,
  });

const mount = (workflows: WorkflowSummary[]) =>
  renderWithApp(undefined, {
    route: "/",
    services: {
      workflow: {
        listWorkflows: () => Promise.resolve(create(ListWorkflowsResponseSchema, { workflows })),
        getWorkflow: () =>
          Promise.resolve(create(ListWorkflowsResponseSchema, { workflows: [] }) as never),
        validateWorkflow: () =>
          Promise.resolve(
            create(ValidateWorkflowResponseSchema, {
              issues: [{ message: "Step Research needs a prompt" }],
            }),
          ),
      },
      run: {
        listRuns: () =>
          Promise.resolve(
            create(ListRunsResponseSchema, {
              runs: [
                create(RunSchema, {
                  id: `run-${Date.now()}`,
                  workflowId: "wf-a",
                  status: RunStatus.RUNNING,
                }),
              ],
            }),
          ),
      },
      live: {
        watchWorkflow: async function* () {
          await new Promise(() => {});
        },
      },
    },
  });

describe("HomePage", () => {
  it("shows the first-run empty state when there are no workflows", async () => {
    const { unmount } = mount([]);
    expect(await screen.findByTestId("home-first-run")).toBeInTheDocument();
    expect(screen.getByTestId("first-run-new")).toBeInTheDocument();
    expect(screen.getByTestId("first-run-import")).toBeInTheDocument();
    unmount();
  });

  it("renders needs attention, running, up next and finished sections", async () => {
    const { unmount } = mount([
      summary("attn", { status: WorkflowStatus.NEEDS_ATTENTION }),
      summary("run", {
        status: WorkflowStatus.ACTIVE,
        lastRunStatus: RunStatus.RUNNING,
        lastRunAt: ts("2026-01-15T11:58:00Z"),
      }),
      summary("next", {
        status: WorkflowStatus.ACTIVE,
        nextRunAt: ts("2026-01-16T09:00:00Z"),
        scheduleSummary: "Every weekday at 09:00",
      }),
      summary("done", {
        lastRunStatus: RunStatus.SUCCEEDED,
        lastRunAt: ts("2026-01-15T09:00:00Z"),
      }),
    ]);
    expect(await screen.findByTestId("home-attention")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("home-attention-card")).toHaveTextContent(
        "Step Research needs a prompt",
      ),
    );
    expect(screen.getByTestId("home-running")).toBeInTheDocument();
    expect(screen.getByTestId("home-next")).toBeInTheDocument();
    expect(screen.getByTestId("home-next-card")).toHaveTextContent("Every weekday at 09:00");
    expect(screen.getByTestId("home-finished")).toBeInTheDocument();
    expect(screen.getByTestId("home-finished-card")).toHaveTextContent("Succeeded");
    unmount();
  });

  it("hides empty sections", async () => {
    const { unmount } = mount([
      summary("done", {
        lastRunStatus: RunStatus.SUCCEEDED,
        lastRunAt: ts("2026-01-15T09:00:00Z"),
      }),
    ]);
    await screen.findByTestId("home-finished");
    expect(screen.queryByTestId("home-attention")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-running")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-next")).not.toBeInTheDocument();
    unmount();
  });
});
