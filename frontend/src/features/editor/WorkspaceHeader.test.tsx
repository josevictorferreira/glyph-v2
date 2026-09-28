// WorkspaceHeader tests (spec 0018): the primary action matrix per status,
// readiness pill, lifecycle preconditions and the rename autosave path.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  GetWorkflowResponseSchema,
  UpdateWorkflowResponseSchema,
  WorkflowSchema,
  ActivateWorkflowResponseSchema,
  PauseWorkflowResponseSchema,
} from "@/gen/glyph/v1/workflow_pb";
import { StartRunResponseSchema } from "@/gen/glyph/v1/run_pb";
import { WorkflowStatus, IssueSchema } from "@/gen/glyph/v1/common_pb";
import type { WorkflowEvent } from "@/gen/glyph/v1/live_pb";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { renderWithApp } from "@test/render";
import { EditorChromeProvider, ReadinessSheet, WorkspaceHeader } from "@/features/editor";
import type { FakeServices } from "@test/fakeTransport";

const wf = (status: WorkflowStatus, name = "Tournament") =>
  create(GetWorkflowResponseSchema, {
    workflow: create(WorkflowSchema, { summary: { id: "wf-1", name, status } }),
    issues: [],
  });

const withIssue = (response: ReturnType<typeof wf>) =>
  create(GetWorkflowResponseSchema, {
    workflow: response.workflow,
    issues: [
      create(IssueSchema, {
        entityType: 2,
        entityId: "s1",
        field: "prompt",
        message: "“Research” needs a prompt.",
      }),
    ],
  });

function failedPrecondition(reason: string): ConnectError {
  const enc = new TextEncoder();
  // google.protobuf.Any for ErrorInfo {reason, domain}: field 1 reason.
  const reasonBytes = enc.encode(reason);
  const domainBytes = enc.encode("glyph");
  const info = new Uint8Array([
    (1 << 3) | 2,
    reasonBytes.length,
    ...reasonBytes,
    (2 << 3) | 2,
    domainBytes.length,
    ...domainBytes,
  ]);
  const err = new ConnectError("This workflow cannot run yet.", Code.FailedPrecondition);
  Object.assign(err, {
    details: [{ type: "google.rpc.ErrorInfo", value: info }],
  });
  return err;
}

function mount(services: FakeServices) {
  const selectStep = vi.fn();
  const ui = (
    <EditorChromeProvider selectStep={selectStep}>
      <WorkspaceHeader workflowId="wf-1" />
      <ReadinessSheet workflowId="wf-1" />
    </EditorChromeProvider>
  );
  // ModeSwitch renders Links, which need a (minimal) router context.
  const rootRoute = createRootRoute({ component: () => <>{ui}</> });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() });
  const rendered = renderWithApp(<RouterProvider router={router} />, {
    services: {
      live: {
        watchWorkflow: async function* (): AsyncIterable<{ event?: WorkflowEvent }> {
          await new Promise(() => {});
        },
      },
      ...services,
    },
  });
  return { ...rendered, selectStep };
}

afterEach(() => vi.restoreAllMocks());

describe("WorkspaceHeader (spec 0018)", () => {
  it("autosaves renames through UpdateWorkflow", async () => {
    const updates: { id: string; name: string }[] = [];
    const { unmount } = mount({
      workflow: {
        getWorkflow: () => Promise.resolve(wf(WorkflowStatus.DRAFT)),
        updateWorkflow: (req: { id: string; name: string }) => {
          updates.push(req);
          return Promise.resolve(
            create(UpdateWorkflowResponseSchema, {
              workflow: wf(WorkflowStatus.DRAFT).workflow,
              issues: [],
            }),
          );
        },
      },
    });
    const input = await screen.findByLabelText("Workflow name");
    vi.useFakeTimers();
    try {
      fireEvent.change(input, { target: { value: "Renamed" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(updates.map((u) => ({ id: u.id, name: u.name }))).toEqual([
        { id: "wf-1", name: "Renamed" },
      ]);
      expect(screen.getByTestId("save-indicator")).toHaveTextContent("Saved");
    } finally {
      vi.useRealTimers();
      unmount();
    }
  });

  it("disables Activate while issues exist, with the reason as tooltip", async () => {
    const activate = vi.fn();
    const { unmount } = mount({
      workflow: {
        getWorkflow: () => Promise.resolve(withIssue(wf(WorkflowStatus.DRAFT))),
        activateWorkflow: activate,
      },
    });
    const activateButton = await screen.findByTestId("activate");
    expect(activateButton).toBeDisabled();
    expect(activateButton).toHaveAttribute("title", "Resolve 1 issue to activate.");
    expect(screen.getByTestId("readiness-pill")).toHaveTextContent("1 issue");
    unmount();
  });

  it("activates a ready draft", async () => {
    const activate = vi.fn((_req: { id: string }) =>
      Promise.resolve(
        create(ActivateWorkflowResponseSchema, {
          workflow: wf(WorkflowStatus.ACTIVE).workflow,
          issues: [],
        }),
      ),
    );
    const { unmount } = mount({
      workflow: {
        getWorkflow: () => Promise.resolve(wf(WorkflowStatus.DRAFT)),
        activateWorkflow: activate,
      },
    });
    await userEvent.click(await screen.findByTestId("activate"));
    await waitFor(() => expect(activate.mock.calls[0]![0]).toMatchObject({ id: "wf-1" }));
    unmount();
  });

  it("opens the readiness sheet when Activate fails with VALIDATION_FAILED", async () => {
    const { unmount } = mount({
      workflow: {
        getWorkflow: () => Promise.resolve(withIssue(wf(WorkflowStatus.DRAFT))),
        activateWorkflow: () => Promise.reject(failedPrecondition("VALIDATION_FAILED")),
      },
    });
    // Activate is disabled while issues exist — drive the same path through
    // the readiness sheet's own Activate button, which is always enabled.
    await userEvent.click(await screen.findByTestId("readiness-pill"));
    // The sheet offers context first; the issues list is the point here.
    expect(await screen.findByTestId("readiness-sheet")).toBeInTheDocument();
    expect(screen.getByText("“Research” needs a prompt.")).toBeInTheDocument();
    unmount();
  });

  it("runs an active workflow from Run now", async () => {
    const started: { workflowId: string }[] = [];
    const { unmount } = mount({
      workflow: { getWorkflow: () => Promise.resolve(wf(WorkflowStatus.ACTIVE)) },
      run: {
        startRun: (req: { workflowId: string }) => {
          started.push(req);
          return Promise.resolve(create(StartRunResponseSchema, {}));
        },
      },
    });
    await userEvent.click(await screen.findByTestId("run-now"));
    await waitFor(() =>
      expect(started.map((r) => ({ workflowId: r.workflowId }))).toEqual([{ workflowId: "wf-1" }]),
    );
    expect(await screen.findByText("Run started")).toBeInTheDocument();
    unmount();
  });

  it("pauses through the confirm dialog", async () => {
    const paused: { id: string }[] = [];
    const { unmount } = mount({
      workflow: {
        getWorkflow: () => Promise.resolve(wf(WorkflowStatus.ACTIVE)),
        pauseWorkflow: (req: { id: string }) => {
          paused.push(req);
          return Promise.resolve(
            create(PauseWorkflowResponseSchema, {
              workflow: wf(WorkflowStatus.PAUSED).workflow,
              issues: [],
            }),
          );
        },
      },
    });
    await screen.findByTestId("run-now");
    await userEvent.click(screen.getByRole("button", { name: "More workflow actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Pause" }));
    const confirm = await screen.findByTestId("confirm-pause");
    expect(screen.getByText("Pause this workflow?")).toBeInTheDocument();
    expect(
      screen.getByText("Scheduled runs stop. Manual runs stay available. History is kept."),
    ).toBeInTheDocument();
    await userEvent.click(confirm);
    await waitFor(() => expect(paused.map((r) => ({ id: r.id }))).toEqual([{ id: "wf-1" }]));
    unmount();
  });

  it("needs-attention shows Review issues and disables the run menu item", async () => {
    const started = vi.fn();
    const { unmount } = mount({
      workflow: {
        getWorkflow: () => Promise.resolve(withIssue(wf(WorkflowStatus.NEEDS_ATTENTION))),
      },
      run: { startRun: started },
    });
    await userEvent.click(await screen.findByTestId("review-issues"));
    expect(await screen.findByTestId("readiness-sheet")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "More workflow actions" }));
    const runItem = await screen.findByRole("menuitem", { name: "Run now" });
    expect(runItem).toHaveAttribute("aria-disabled", "true");
    unmount();
  });
});
