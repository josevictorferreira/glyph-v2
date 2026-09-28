// ScheduleComposer tests (spec 0019 task 3): pattern editing, preview,
// save/remove requests and draft handling.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { WorkflowStatus } from "@/gen/glyph/v1/common_pb";
import {
  GetWorkflowResponseSchema,
  SaveScheduleResponseSchema,
  ScheduleSchema,
  WorkflowSchema,
} from "@/gen/glyph/v1/workflow_pb";
import type { SaveScheduleRequest, Schedule, Workflow } from "@/gen/glyph/v1/workflow_pb";
import { renderWithApp } from "@test/render";
import { ScheduleComposer } from "./ScheduleComposer";

function wf(status: WorkflowStatus, schedule?: Schedule): Workflow {
  return create(WorkflowSchema, { summary: { id: "wf-1", name: "Tournament", status }, schedule });
}

const makeSchedule = (init: MessageInitShape<typeof ScheduleSchema> = {}) =>
  create(ScheduleSchema, {
    id: "sch-1",
    enabled: true,
    cronExpression: "0 9 * * 1",
    timezone: "UTC",
    humanDescription: "Mondays at 09:00 (UTC)",
    ...init,
  });

const saved = create(SaveScheduleResponseSchema, {
  workflow: wf(WorkflowStatus.ACTIVE, makeSchedule()),
  issues: [],
});

function mount(workflow: Workflow) {
  const requests: SaveScheduleRequest[] = [];
  const onOpenChange = vi.fn();
  // The real parent owns `open`; saving/removing closes the sheet through it.
  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <ScheduleComposer
        workflow={workflow}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          onOpenChange(next);
        }}
      />
    );
  }
  renderWithApp(<Harness />, {
    services: {
      workflow: {
        getWorkflow: async () => create(GetWorkflowResponseSchema, { workflow }),
        saveSchedule: async (req: SaveScheduleRequest) => {
          requests.push(req);
          return saved;
        },
      },
    },
  });
  const last = () => {
    const req = requests.at(-1);
    if (!req) throw new Error("no SaveSchedule request captured");
    return req;
  };
  return { requests, onOpenChange, last };
}

afterEach(() => vi.restoreAllMocks());

describe("ScheduleComposer (spec 0019)", () => {
  it("defaults to the saved shape and saves edits", async () => {
    const { last, onOpenChange } = mount(wf(WorkflowStatus.ACTIVE, makeSchedule()));
    // Saved weekly cron 0 9 * * 1 → Weekly pattern, Monday pressed.
    expect(screen.getByRole("tab", { name: "Weekly", selected: true })).toBeVisible();
    expect(screen.getByRole("button", { name: "Monday", pressed: true })).toBeVisible();
    expect(screen.getByLabelText("Schedule timezone").textContent).toContain("UTC");

    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "10:30" } });
    await userEvent.click(screen.getByTestId("save-schedule"));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    const req = last();
    expect(req.recurrence.case).toBe("weekly");
    expect(req.recurrence.case === "weekly" ? req.recurrence.value : undefined).toMatchObject({
      weekday: 1,
      hour: 10,
      minute: 30,
    });
    expect(req.timezone).toBe("UTC");
    expect(req.enabled).toBe(true);
  });

  it("interval bounds follow the unit", async () => {
    const { last } = mount(wf(WorkflowStatus.ACTIVE));
    expect(screen.getByRole("tab", { name: "Interval", selected: true })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Every"), { target: { value: "6" } });
    fireEvent.change(screen.getByLabelText("Unit"), { target: { value: "hours" } });
    await waitFor(() => expect(screen.getByTestId("schedule-preview").textContent).toContain("7 */6 * * *"));
    await userEvent.click(screen.getByTestId("save-schedule"));
    const req = await waitFor(() => {
      const r = last();
      expect(r.recurrence.case).toBe("interval");
      return r;
    });
    expect(req.recurrence.case === "interval" && req.recurrence.value.every).toBe(6);
  });

  it("shows the cron equivalent and next occurrences", () => {
    mount(wf(WorkflowStatus.ACTIVE));
    const preview = screen.getByTestId("schedule-preview");
    expect(preview.textContent).toContain("*/15 * * * *");
    // Five occurrences listed in the schedule timezone.
    expect(preview.querySelectorAll("li")).toHaveLength(5);
  });

  it("blocks invalid cron with the validator message", async () => {
    mount(wf(WorkflowStatus.ACTIVE));
    await userEvent.click(screen.getByRole("tab", { name: "Cron" }));
    await userEvent.type(screen.getByLabelText("Cron expression"), "nope");
    expect(screen.getByText("The recurrence is not a valid cron expression.")).toBeVisible();
    expect(screen.getByTestId("save-schedule")).toBeDisabled();
  });

  it("hides the enabled switch for drafts and saves enabled", async () => {
    const { last } = mount(wf(WorkflowStatus.DRAFT));
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText(/starts after you activate the workflow/i)).toBeVisible();
    await userEvent.click(screen.getByTestId("save-schedule"));
    await waitFor(() => expect(last().enabled).toBe(true));
  });

  it("remove confirms, then saves the none recurrence", async () => {
    const { onOpenChange, last } = mount(wf(WorkflowStatus.ACTIVE, makeSchedule()));
    await userEvent.click(screen.getByRole("button", { name: "Remove…" }));
    await userEvent.click(screen.getByTestId("confirm-remove"));
    await waitFor(() => expect(screen.queryByTestId("schedule-composer")).toBeNull());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(last().recurrence.case).toBe("none");
  });

  it("hides remove when there is no schedule", () => {
    mount(wf(WorkflowStatus.ACTIVE));
    expect(screen.queryByRole("button", { name: "Remove…" })).toBeNull();
  });
});
