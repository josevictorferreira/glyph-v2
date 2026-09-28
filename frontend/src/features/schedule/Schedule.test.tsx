// ScheduleCard tests (spec 0019 task 4): the five summary states.
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { IssueEntityType, IssueSchema, WorkflowStatus } from "@/gen/glyph/v1/common_pb";
import {
  GetWorkflowResponseSchema,
  ScheduleSchema,
  WorkflowSchema,
} from "@/gen/glyph/v1/workflow_pb";
import { renderWithApp } from "@test/render";
import { ScheduleCard } from "./Schedule";

const ts = (iso: string) =>
  create(TimestampSchema, { seconds: BigInt(Date.parse(iso) / 1000), nanos: 0 });

function mount(
  status: WorkflowStatus,
  schedule?: boolean,
  issues: ReturnType<typeof makeIssue>[] = [],
) {
  const onOpenComposer = vi.fn();
  const onOpenReadiness = vi.fn();
  renderWithApp(
    <ScheduleCard
      workflow={wf(status, schedule)}
      onOpenComposer={onOpenComposer}
      onOpenReadiness={onOpenReadiness}
    />,
    {
      services: {
        workflow: {
          getWorkflow: async () =>
            create(GetWorkflowResponseSchema, { workflow: wf(status, schedule), issues }),
        },
      },
    },
  );
  return { onOpenComposer, onOpenReadiness };
}

function wf(status: WorkflowStatus, schedule?: boolean) {
  return create(WorkflowSchema, {
    summary: { id: "wf-1", name: "Tournament", status },
    schedule: schedule
      ? create(ScheduleSchema, {
          id: "sch-1",
          enabled: true,
          cronExpression: "0 9 * * 1",
          timezone: "UTC",
          humanDescription: "Mondays at 09:00 (UTC)",
        })
      : undefined,
  });
}

const makeIssue = () =>
  create(IssueSchema, {
    entityType: IssueEntityType.WORKFLOW_SCHEDULE,
    entityId: "sch-1",
    field: "values",
    message: "The schedule needs a value for the required workflow input “Topic”.",
  });

describe("ScheduleCard (spec 0019)", () => {
  it("no schedule: invites to add one", async () => {
    const { onOpenComposer } = mount(WorkflowStatus.ACTIVE);
    expect(screen.getByText("Runs only when you start it.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Add schedule" }));
    expect(onOpenComposer).toHaveBeenCalled();
  });

  it("active: description, next run and last dispatched", () => {
    renderWithApp(
      <ScheduleCard workflow={activeWf()} onOpenComposer={vi.fn()} onOpenReadiness={vi.fn()} />,
      {
        services: {
          workflow: {
            getWorkflow: async () => create(GetWorkflowResponseSchema, { workflow: activeWf() }),
          },
        },
      },
    );
    expect(screen.getByTestId("schedule-active")).toBeVisible();
    expect(screen.getByText("Mondays at 09:00 (UTC)")).toBeVisible();
    expect(screen.getByText("Enabled")).toBeVisible();
    expect(screen.getByText(/^Next: Mon/)).toBeVisible();
    expect(screen.getByText(/^Last dispatched/)).toBeVisible();
  });

  it("draft: explains it starts after activation", () => {
    mount(WorkflowStatus.DRAFT, true);
    expect(screen.getByTestId("schedule-draft")).toBeVisible();
    expect(
      screen.getByText("Schedule saved. It starts after you activate the workflow."),
    ).toBeVisible();
  });

  it("paused: explains there are no scheduled runs", () => {
    mount(WorkflowStatus.PAUSED, true);
    expect(screen.getByTestId("schedule-paused")).toBeVisible();
    expect(screen.getByText("Paused. No scheduled runs until you resume.")).toBeVisible();
    expect(screen.getByText("Paused")).toBeVisible();
  });

  it("needs attention: links to the readiness sheet", async () => {
    const { onOpenReadiness } = mount(WorkflowStatus.NEEDS_ATTENTION, true, [makeIssue()]);
    expect(await screen.findByTestId("schedule-attention")).toBeVisible();
    expect(screen.getByText(/Not dispatching: fix the issues first\./)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /Review readiness/ }));
    expect(onOpenReadiness).toHaveBeenCalled();
  });

  it("edit schedule opens the composer", async () => {
    const { onOpenComposer } = mount(WorkflowStatus.ACTIVE, true);
    await userEvent.click(screen.getByRole("button", { name: "Edit schedule" }));
    expect(onOpenComposer).toHaveBeenCalled();
  });
});

function activeWf() {
  return create(WorkflowSchema, {
    summary: { id: "wf-1", name: "Tournament", status: WorkflowStatus.ACTIVE },
    schedule: create(ScheduleSchema, {
      id: "sch-1",
      enabled: true,
      cronExpression: "0 9 * * 1",
      timezone: "UTC",
      humanDescription: "Mondays at 09:00 (UTC)",
      nextRunAt: ts("2026-10-05T09:00:00Z"),
      lastDispatchedAt: ts("2026-09-28T09:00:00Z"),
    }),
  });
}
