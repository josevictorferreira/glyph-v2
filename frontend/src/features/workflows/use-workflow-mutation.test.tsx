// useWorkflowMutation tests (spec 0015): success reconciles the cache with
// the returned aggregate, failure rolls back the optimistic patch, lists are
// invalidated, and errors surface as AppError.
import { describe, expect, it, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { create, clone } from "@bufbuild/protobuf";
import { ConnectError, Code } from "@connectrpc/connect";
import { WorkflowSchema, StepSchema, WorkflowService } from "@/gen/glyph/v1/workflow_pb";
import { WorkflowStatus, IssueSchema } from "@/gen/glyph/v1/common_pb";
import { renderHookWithApp } from "@test/render";
import { useWorkflow } from "./hooks";
import { useWorkflowMutation } from "./use-workflow-mutation";

function makeWorkflow(step: { id: string; canvasX: number; canvasY: number }) {
  return create(WorkflowSchema, {
    summary: { id: "wf-1", name: "Tournament", status: WorkflowStatus.DRAFT },
    steps: [create(StepSchema, step)],
  });
}

function stepOf(wf: ReturnType<typeof makeWorkflow>) {
  return wf.steps[0]!;
}

describe("useWorkflowMutation", () => {
  it("on success, replaces the GetWorkflow cache with the returned aggregate", async () => {
    let savedName = "";
    const r = renderHookWithApp(
      () => ({
        q: useWorkflow("wf-1"),
        mut: useWorkflowMutation(WorkflowService.method.updateWorkflow, {
          onSucceeded: (res) => {
            savedName = res.workflow?.summary?.name ?? "";
          },
        }),
      }),
      {
        services: {
          workflow: {
            getWorkflow: () => ({
              workflow: makeWorkflow({ id: "s-1", canvasX: 0, canvasY: 0 }),
              issues: [],
            }),
            updateWorkflow: () => ({
              workflow: makeWorkflow({ id: "s-1", canvasX: 0, canvasY: 0 }),
              issues: [create(IssueSchema, { entityType: 2, entityId: "s-1", field: "model", message: "gone" })],
            }),
          },
        },
      },
    );
    await waitFor(() => expect(r.result.current.q.data?.workflow?.summary?.name).toBe("Tournament"));

    const invalidateSpy = vi.spyOn(r.queryClient, "invalidateQueries");
    await act(() => r.result.current.mut.mutateAsync({ id: "wf-1", name: "Renamed" }));
    expect(savedName).toBe("Tournament");
    await waitFor(() => expect(r.result.current.q.data?.issues).toHaveLength(1));
    expect(invalidateSpy).toHaveBeenCalled();
    invalidateSpy.mockRestore();
    r.unmount();
  });

  it("optimistically patches MoveStep and rolls back on failure", async () => {
    let settle: (ok: boolean) => void = () => {};
    const r = renderHookWithApp(
      () => ({
        q: useWorkflow("wf-1"),
        mut: useWorkflowMutation(WorkflowService.method.moveStep, {
          optimistic: (wf, req) => {
            const patched = clone(WorkflowSchema, wf);
            const s = patched.steps.find((x) => x.id === req.stepId)!;
            s.canvasX = req.canvasX ?? 0;
            s.canvasY = req.canvasY ?? 0;
            return patched;
          },
        }),
      }),
      {
        services: {
          workflow: {
            getWorkflow: () => ({
              workflow: makeWorkflow({ id: "s-1", canvasX: 0, canvasY: 0 }),
              issues: [],
            }),
            moveStep: () =>
              new Promise((resolve, reject) => {
                settle = (ok) =>
                  ok
                    ? resolve({ workflow: makeWorkflow({ id: "s-1", canvasX: 100, canvasY: 200 }), issues: [] })
                    : reject(new ConnectError("stale", Code.Aborted));
              }),
          },
        },
      },
    );
    await waitFor(() => expect(r.result.current.q.data?.workflow).toBeDefined());
    expect(stepOf(r.result.current.q.data!.workflow!)).toMatchObject({ canvasX: 0, canvasY: 0 });

    // Optimistic patch visible while the server has not answered.
    let inFlight: Promise<unknown> | undefined;
    act(() => {
      inFlight = r.result.current.mut.mutateAsync({ workflowId: "wf-1", stepId: "s-1", canvasX: 100, canvasY: 200 });
    });
    await waitFor(() =>
      expect(stepOf(r.result.current.q.data!.workflow!)).toMatchObject({ canvasX: 100, canvasY: 200 }),
    );

    act(() => settle(false));
    await act(async () => {
      await expect(inFlight).rejects.toBeTruthy();
    });
    await waitFor(() => expect(stepOf(r.result.current.q.data!.workflow!).canvasX).toBe(0));
    expect(stepOf(r.result.current.q.data!.workflow!).canvasY).toBe(0);
    r.unmount();
  });

  it("on error, surfaces an AppError to the caller", async () => {
    const seen: unknown[] = [];
    const r = renderHookWithApp(
      () =>
        useWorkflowMutation(WorkflowService.method.activateWorkflow, {
          onAppError: (e) => seen.push(e),
        }),
      {
        services: {
          workflow: {
            activateWorkflow: () => {
              throw new ConnectError("not ready", Code.FailedPrecondition);
            },
          },
        },
      },
    );
    await act(async () => {
      await expect(r.result.current.mutateAsync({ id: "wf-1" })).rejects.toBeTruthy();
    });
    expect(seen[0]).toMatchObject({ kind: "precondition" });
    r.unmount();
  });

  it("invalidates list queries after success", async () => {
    const r = renderHookWithApp(() => useWorkflowMutation(WorkflowService.method.updateWorkflow), {
      services: {
        workflow: {
          updateWorkflow: () => ({ workflow: makeWorkflow({ id: "s-1", canvasX: 0, canvasY: 0 }), issues: [] }),
        },
      },
    });
    const invalidateSpy = vi.spyOn(r.queryClient, "invalidateQueries");
    await act(() => r.result.current.mutateAsync({ id: "wf-1", name: "x" }));
    const keys = invalidateSpy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys.some((k) => k.includes("ListWorkflows"))).toBe(true);
    invalidateSpy.mockRestore();
    r.unmount();
  });
});
