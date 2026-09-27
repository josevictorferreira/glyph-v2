// Command palette tests (spec 0016): registration, ⌘K, fuzzy flow, run action.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { create } from "@bufbuild/protobuf";
import { WorkflowStatus } from "@/gen/glyph/v1/common_pb";
import { GetWorkflowResponseSchema, ListWorkflowsResponseSchema, WorkflowSummarySchema } from "@/gen/glyph/v1/workflow_pb";
import { StartRunResponseSchema } from "@/gen/glyph/v1/run_pb";
import { renderWithApp } from "@test/render";

afterEach(() => vi.restoreAllMocks());

const mount = (opts: { started: { workflowId: string }[] } = { started: [] }) =>
  renderWithApp(undefined, {
    route: "/",
    services: {
      workflow: {
        listWorkflows: () =>
          Promise.resolve(
            create(ListWorkflowsResponseSchema, {
              workflows: [
                create(WorkflowSummarySchema, { id: "wf-1", name: "Tournament", status: WorkflowStatus.DRAFT, updatedAt: { seconds: 1n, nanos: 0 } }),
              ],
            }),
          ),
        getWorkflow: (req: { id: string }) =>
          Promise.resolve(create(GetWorkflowResponseSchema, { workflow: { summary: { id: req.id, name: "Tournament", status: WorkflowStatus.DRAFT } } })),
      },
      run: {
        startRun: (req: { workflowId: string }) => {
          opts.started.push({ workflowId: req.workflowId });
          return Promise.resolve(create(StartRunResponseSchema, { run: { id: "run-1", workflowId: req.workflowId } }));
        },
      },
      catalog: { refreshModels: () => Promise.resolve({}) },
      live: { watchWorkflow: async function* () { await new Promise(() => {}); } },
    },
  });

const openPalette = async () => {
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  await screen.findByTestId("command-palette");
};

describe("command palette", () => {
  it("opens with ⌘K and lists navigation and global commands", async () => {
    const { unmount } = mount();
    await screen.findByTestId("library-row-wf-1");
    await openPalette();
    expect(screen.getByTestId("command-nav:home")).toBeInTheDocument();
    expect(screen.getByTestId("command-nav:wf-wf-1")).toHaveTextContent("Tournament");
    expect(screen.getByTestId("command-global:new")).toBeInTheDocument();
    expect(screen.getByTestId("command-global:theme")).toBeInTheDocument();
    unmount();
  });

  it("filters as you type and closes after running a command", async () => {
    const { unmount } = mount();
    await screen.findByTestId("library-row-wf-1");
    await openPalette();
    fireEvent.change(screen.getByTestId("command-input"), { target: { value: "tour" } });
    await waitFor(() => expect(screen.queryByTestId("command-global:new")).not.toBeInTheDocument());
    expect(screen.getByTestId("command-nav:wf-wf-1")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("command-nav:wf-wf-1"));
    await waitFor(() => expect(screen.queryByTestId("command-palette")).not.toBeInTheDocument());
    unmount();
  });

  it("runs workflow actions (Run now) scoped to the open workflow", async () => {
    const started: { workflowId: string }[] = [];
    const { unmount, router } = mount({ started });
    await screen.findByTestId("library-row-wf-1");
    await router!.navigate({ to: "/workflows/$id", params: { id: "wf-1" } });
    await screen.findByTestId("workspace-header");
    await openPalette();
    fireEvent.change(screen.getByTestId("command-input"), { target: { value: "run now" } });
    fireEvent.click(screen.getByTestId("command-wf:wf-1:run"));
    await waitFor(() => expect(started).toEqual([{ workflowId: "wf-1" }]));
    unmount();
  });
});
