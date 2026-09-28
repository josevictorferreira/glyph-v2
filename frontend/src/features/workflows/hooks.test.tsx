// Workflow query hook tests (spec 0015): named hooks read through the fake
// transport, enabled-gating works, staleTime follows the liveness registry.
import { describe, expect, it, afterEach } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { create } from "@bufbuild/protobuf";
import { WorkflowSchema } from "@/gen/glyph/v1/workflow_pb";
import { IssueSchema, WorkflowStatus } from "@/gen/glyph/v1/common_pb";
import { renderHookWithApp } from "@test/render";
import { markLive, isLive, useIsLive } from "@/shared/api/liveness";
import { useWorkflow, useWorkflowList, useIssues } from "./hooks";

afterEach(() => {
  markLive("wf-1", false);
  markLive("wf-2", false);
});

function workflow(id: string, name: string) {
  return create(WorkflowSchema, { summary: { id, name, status: WorkflowStatus.DRAFT } });
}

describe("useWorkflow", () => {
  it("fetches the workflow aggregate and surfaces issues", async () => {
    const r = renderHookWithApp(() => useWorkflow("wf-1"), {
      services: {
        workflow: {
          getWorkflow: () => ({
            workflow: workflow("wf-1", "Tournament"),
            issues: [
              create(IssueSchema, {
                severity: 1,
                entityType: 2,
                entityId: "step-1",
                field: "model",
                message: "Model no longer available",
              }),
            ],
          }),
        },
      },
    });
    await waitFor(() => expect(r.result.current.data?.workflow?.summary?.name).toBe("Tournament"));
    expect(r.result.current.data?.issues).toHaveLength(1);
    r.unmount();
  });

  it("is disabled for an empty id (no request fires)", async () => {
    const r = renderHookWithApp(() => useWorkflow(""), {
      services: {
        workflow: {
          getWorkflow: () => {
            throw new Error("should not be called");
          },
        },
      },
    });
    expect(r.result.current.fetchStatus).toBe("idle");
    r.unmount();
  });

  it("resolves staleTime to Infinity while live and 30s otherwise", async () => {
    const r = renderHookWithApp(() => useWorkflow("wf-2"), {
      services: {
        workflow: { getWorkflow: () => ({ workflow: workflow("wf-2", "W"), issues: [] }) },
      },
    });
    await waitFor(() => expect(r.result.current.isSuccess).toBe(true));
    const observer = () => r.queryClient.getQueryCache().getAll()[0]!.observers[0]!;
    expect(isLive("wf-2")).toBe(false);
    act(() => markLive("wf-2", true));
    await waitFor(() => expect(observer().options.staleTime).toBe(Infinity));
    act(() => markLive("wf-2", false));
    await waitFor(() => expect(observer().options.staleTime).toBe(30_000));
    r.unmount();
  });
});

describe("useWorkflowList", () => {
  it("normalizes the filter into the request", async () => {
    let seen: unknown;
    const r = renderHookWithApp(() => useWorkflowList({ query: "tour" }), {
      services: {
        workflow: {
          listWorkflows: (req: unknown) => {
            seen = req;
            return { workflows: [workflow("wf-1", "Tournament").summary!] };
          },
        },
      },
    });
    await waitFor(() => expect(r.result.current.data?.workflows).toHaveLength(1));
    expect(seen).toMatchObject({ query: "tour", limit: 0 });
    expect((seen as { status?: unknown }).status).toBeUndefined();
    r.unmount();
  });
});

describe("useIssues", () => {
  it("indexes issues by entity and field", async () => {
    const r = renderHookWithApp(() => useIssues("wf-1"), {
      services: {
        workflow: {
          getWorkflow: () => ({
            workflow: workflow("wf-1", "Tournament"),
            issues: [
              create(IssueSchema, {
                entityType: 2,
                entityId: "step-1",
                field: "model",
                message: "A",
              }),
              create(IssueSchema, {
                entityType: 2,
                entityId: "step-1",
                field: "prompt",
                message: "B",
              }),
              create(IssueSchema, {
                entityType: 4,
                entityId: "in-1",
                field: "value",
                message: "C",
              }),
            ],
          }),
        },
      },
    });
    await waitFor(() => expect(r.result.current.all).toHaveLength(3));
    expect(r.result.current.forEntity(2, "step-1").map((i) => i.message)).toEqual(["A", "B"]);
    expect(r.result.current.at(2, "step-1", "prompt").map((i) => i.message)).toEqual(["B"]);
    expect(r.result.current.at(2, "step-2", "model")).toEqual([]);
    r.unmount();
  });
});

describe("liveness registry", () => {
  it("useIsLive tracks markLive per workflow", async () => {
    const r = renderHookWithApp(() => useIsLive("wf-1"));
    expect(r.result.current).toBe(false);
    act(() => markLive("wf-1", true));
    expect(r.result.current).toBe(true);
    act(() => markLive("wf-1", true));
    act(() => markLive("wf-1", false));
    expect(r.result.current).toBe(true); // still one open
    act(() => markLive("wf-1", false));
    expect(r.result.current).toBe(false);
    r.unmount();
  });
});
