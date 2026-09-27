// WorkspaceHeader tests (spec 0015): the dev rename control exercises
// query → autosave → mutation end to end against the fake transport.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithApp } from "@test/render";
import { WorkspaceHeader } from "./workflows.$id";
import { GetWorkflowResponseSchema, UpdateWorkflowResponseSchema } from "@/gen/glyph/v1/workflow_pb";
import { create } from "@bufbuild/protobuf";
import type { WorkflowEvent } from "@/gen/glyph/v1/live_pb";

const named = (name: string) =>
  create(GetWorkflowResponseSchema, { workflow: { summary: { id: "wf-1", name } }, issues: [] });

afterEach(() => vi.restoreAllMocks());

describe("WorkspaceHeader", () => {
  const mount = (name: string) => {
    const updates: { id: string; name: string }[] = [];
    const r = renderWithApp(<WorkspaceHeader workflowId="wf-1" />, {
      services: {
        workflow: {
          getWorkflow: () => Promise.resolve(named(name)),
          updateWorkflow: (req: { id: string; name: string }) => {
            updates.push({ id: req.id, name: req.name });
            return Promise.resolve(
              create(UpdateWorkflowResponseSchema, { workflow: { summary: { id: req.id, name: req.name } }, issues: [] }),
            );
          },
        },
        live: {
          // Eternal idle stream: no events, no errors (no reconnect timers).
          watchWorkflow: async function* (): AsyncIterable<{ event?: WorkflowEvent }> {
            await new Promise(() => {});
          },
        },
      },
    });
    return { ...r, updates };
  };

  it("shows the workflow name and live indicator", async () => {
    const { unmount } = mount("Tournament");
    const input = await screen.findByLabelText("Workflow name");
    await waitFor(() => expect(input).toHaveValue("Tournament"));
    expect(screen.getByTestId("connection-indicator")).toBeInTheDocument();
    unmount();
  });

  it("autosaves renames through UpdateWorkflow and reports Saved", async () => {
    const { updates, unmount } = mount("Tournament");
    const input = await screen.findByLabelText("Workflow name");
    vi.useFakeTimers();
    try {
      fireEvent.change(input, { target: { value: "Renamed" } });
      expect(screen.getByTestId("save-indicator")).toHaveTextContent("Unsaved changes");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(updates).toEqual([{ id: "wf-1", name: "Renamed" }]);
      expect(input).toHaveValue("Renamed");
      expect(screen.getByTestId("save-indicator")).toHaveTextContent("Saved");
    } finally {
      vi.useRealTimers();
      unmount();
    }
  });
});
