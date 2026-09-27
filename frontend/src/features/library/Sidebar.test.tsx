// Library sidebar tests (spec 0016), mounted through the real route tree so
// router context (current workflow, navigation) is exercised.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { RunStatus, WorkflowStatus } from "@/gen/glyph/v1/common_pb";
import {
  CreateWorkflowResponseSchema,
  GetWorkflowResponseSchema,
  ListWorkflowsResponseSchema,
  WorkflowSummarySchema,
} from "@/gen/glyph/v1/workflow_pb";
import type { CreateWorkflowResponse, WorkflowSummary } from "@/gen/glyph/v1/workflow_pb";
import { renderWithApp } from "@test/render";

afterEach(() => vi.restoreAllMocks());

const ts = (iso: string) => create(TimestampSchema, { seconds: BigInt(Date.parse(iso) / 1000), nanos: 0 });

const summary = (id: string, name: string, init: Record<string, unknown> = {}): WorkflowSummary =>
  create(WorkflowSummarySchema, {
    id,
    name,
    status: WorkflowStatus.DRAFT,
    updatedAt: ts("2026-01-15T10:00:00Z"),
    ...init,
  });

const idleLive = {
  watchWorkflow: async function* () {
    await new Promise(() => {});
  },
};

const mount = (
  workflows: WorkflowSummary[],
  extra: { createWorkflow?: (req: { name: string }) => Promise<CreateWorkflowResponse> } = {},
) =>
  renderWithApp(undefined, {
    route: "/",
    services: {
      workflow: {
        listWorkflows: () => Promise.resolve(create(ListWorkflowsResponseSchema, { workflows })),
        getWorkflow: () => Promise.resolve(create(GetWorkflowResponseSchema, {})),
        ...(extra.createWorkflow ? { createWorkflow: extra.createWorkflow } : {}),
      },
      live: idleLive,
    },
  });

describe("LibrarySidebar", () => {
  it("renders sorted rows with secondary lines", async () => {
    const { unmount } = mount([
      summary("plain", "Plain draft"),
      summary("hot", "Broken", { status: WorkflowStatus.NEEDS_ATTENTION }),
      summary("run", "Busy", { status: WorkflowStatus.ACTIVE, lastRunStatus: RunStatus.RUNNING, lastRunAt: ts("2026-01-15T11:00:00Z") }),
    ]);
    await waitFor(() =>
      expect(screen.getAllByTestId("library-row-name").map((n) => n.textContent)).toEqual(["Broken", "Busy", "Plain draft"]),
    );
    expect(screen.getByTestId("library-row-hot").textContent).toContain("Needs attention");
    unmount();
  });

  it("debounces search into ListWorkflows and forwards the status filter", async () => {
    const calls: { query: string; status?: number }[] = [];
    const { unmount } = renderWithApp(undefined, {
      route: "/",
      services: {
        workflow: {
          listWorkflows: (req: { query: string; status?: number }) => {
            calls.push({ query: req.query, status: req.status });
            return Promise.resolve(create(ListWorkflowsResponseSchema, { workflows: [summary("a", "Alpha")] }));
          },
          getWorkflow: () => Promise.resolve(create(GetWorkflowResponseSchema, {})),
        },
        live: idleLive,
      },
    });
    const search = await screen.findByTestId("library-search");
    vi.useFakeTimers();
    try {
      fireEvent.change(search, { target: { value: "alp" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(calls.at(-1)?.query).toBe(""); // not yet debounced
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
      expect(calls.at(-1)?.query).toBe("alp");

      fireEvent.click(screen.getByTestId("chip-attention"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(calls.at(-1)?.status).toBe(WorkflowStatus.NEEDS_ATTENTION);
    } finally {
      vi.useRealTimers();
      unmount();
    }
  });

  it("opens the create dialog from New and creates a blank workflow", async () => {
    const created: { name: string }[] = [];
    const { unmount, router } = mount([summary("a", "Alpha")], {
      createWorkflow: (req: { name: string }) => {
        created.push({ name: req.name });
        return Promise.resolve(
          create(CreateWorkflowResponseSchema, { workflow: { summary: { id: "wf-new", name: req.name } } }),
        );
      },
    });
    await screen.findByTestId("library-row-a");
    fireEvent.click(screen.getByTestId("library-new"));
    const name = await screen.findByTestId("create-name");
    fireEvent.change(name, { target: { value: "Tournament" } });
    fireEvent.click(screen.getByTestId("create-submit"));
    await waitFor(() => expect(created).toEqual([{ name: "Tournament" }]));
    await waitFor(() => expect(router?.state.location.pathname).toBe("/workflows/wf-new"));
    unmount();
  });
});
