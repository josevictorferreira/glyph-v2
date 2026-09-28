// Schedule state machine tests (spec 0019): the five summary states and
// their one-line copy, derived from status, schedule and schedule issues.
import { describe, expect, it } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { IssueEntityType, IssueSchema, WorkflowStatus } from "@/gen/glyph/v1/common_pb";
import type { Issue } from "@/gen/glyph/v1/common_pb";
import { ScheduleSchema, WorkflowSchema } from "@/gen/glyph/v1/workflow_pb";
import { scheduleIssues, scheduleState, scheduleStateLine, type ConfiguredSchedule } from "./state";

const ts = (iso: string) =>
  create(TimestampSchema, { seconds: BigInt(Date.parse(iso) / 1000), nanos: 0 });

const workflow = (status: WorkflowStatus, schedule?: ReturnType<typeof makeSchedule>) =>
  create(WorkflowSchema, {
    summary: { id: "wf-1", name: "Tournament", status },
    schedule,
  });

const makeSchedule = (init: MessageInitShape<typeof ScheduleSchema> = {}) =>
  create(ScheduleSchema, {
    id: "sch-1",
    enabled: true,
    cronExpression: "0 9 * * 1",
    timezone: "UTC",
    humanDescription: "Mondays at 09:00 (UTC)",
    ...init,
  });

const configured = (schedule: ReturnType<typeof makeSchedule>) => schedule as ConfiguredSchedule;

const scheduleIssue = (): Issue =>
  create(IssueSchema, {
    entityType: IssueEntityType.WORKFLOW_SCHEDULE,
    entityId: "sch-1",
    field: "values",
    message: "The schedule needs a value for the required workflow input “Topic”.",
  });

describe("scheduleState", () => {
  it("is none without a schedule or without cron+timezone", () => {
    expect(scheduleState(workflow(WorkflowStatus.ACTIVE))).toEqual({ kind: "none" });
    expect(
      scheduleState(workflow(WorkflowStatus.ACTIVE, makeSchedule({ cronExpression: undefined }))),
    ).toEqual({
      kind: "none",
    });
    expect(
      scheduleState(workflow(WorkflowStatus.ACTIVE, makeSchedule({ timezone: undefined }))),
    ).toEqual({
      kind: "none",
    });
  });

  it("is attention when schedule issues exist, regardless of status", () => {
    expect(
      scheduleState(workflow(WorkflowStatus.ACTIVE, makeSchedule()), [scheduleIssue()]),
    ).toMatchObject({
      kind: "attention",
    });
    expect(
      scheduleState(workflow(WorkflowStatus.DRAFT, makeSchedule()), [scheduleIssue()]),
    ).toMatchObject({
      kind: "attention",
    });
  });

  it("is draft for a draft workflow (stored disabled by the backend)", () => {
    expect(
      scheduleState(workflow(WorkflowStatus.DRAFT, makeSchedule({ enabled: false }))),
    ).toMatchObject({
      kind: "draft",
    });
  });

  it("is paused when the schedule is off or the workflow is paused", () => {
    expect(
      scheduleState(workflow(WorkflowStatus.ACTIVE, makeSchedule({ enabled: false }))),
    ).toMatchObject({
      kind: "paused",
    });
    expect(scheduleState(workflow(WorkflowStatus.PAUSED, makeSchedule()))).toMatchObject({
      kind: "paused",
    });
  });

  it("is active when enabled on an active workflow", () => {
    expect(scheduleState(workflow(WorkflowStatus.ACTIVE, makeSchedule()))).toMatchObject({
      kind: "active",
    });
  });

  it("ignores non-schedule issues", () => {
    const stepIssue = create(IssueSchema, {
      entityType: IssueEntityType.WORKFLOW_STEP,
      entityId: "s1",
      field: "prompt",
      message: "“Research” needs a prompt.",
    });
    expect(
      scheduleState(workflow(WorkflowStatus.NEEDS_ATTENTION, makeSchedule()), [stepIssue]),
    ).toMatchObject({
      kind: "active",
    });
    expect(scheduleIssues([stepIssue, scheduleIssue()])).toHaveLength(1);
  });
});

describe("scheduleStateLine", () => {
  const next = configured(makeSchedule({ nextRunAt: ts("2026-09-28T09:00:00Z") }));

  it("renders the copy for every state", () => {
    expect(scheduleStateLine({ kind: "none" })).toBe("Runs only when you start it.");
    expect(
      scheduleStateLine({ kind: "draft", schedule: configured(makeSchedule({ enabled: false })) }),
    ).toBe("Schedule saved. It starts after you activate the workflow.");
    expect(scheduleStateLine({ kind: "paused", schedule: configured(makeSchedule()) })).toBe(
      "Paused. No scheduled runs until you resume.",
    );
    expect(scheduleStateLine({ kind: "attention", schedule: configured(makeSchedule()) })).toBe(
      "Not dispatching: fix the issues first.",
    );
    expect(scheduleStateLine({ kind: "active", schedule: configured(makeSchedule()) })).toBe(
      "No upcoming run.",
    );
  });

  it("renders the next run in the schedule timezone with a relative tail", () => {
    const line = scheduleStateLine(
      { kind: "active", schedule: next },
      new Date("2026-09-25T09:00:00Z"), // 3 days before
    );
    expect(line).toBe("Next: Mon, Sep 28, 09:00 (in 3 days)");
  });
});
