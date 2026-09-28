// Schedule summary state machine (spec 0019): the five states derived from
// the workflow status, the schedule row and WORKFLOW_SCHEDULE issues. Pure
// functions, unit-tested; the panel card and the header chip share them.
import { IssueEntityType, WorkflowStatus, type Issue } from "@/gen/glyph/v1/common_pb";
import type { Workflow } from "@/gen/glyph/v1/workflow_pb";
import { formatRelative } from "@/shared/lib/time";
import { tsToDate } from "@/shared/lib/time";
import { isConfigured, type ConfiguredSchedule } from "./recurrence";
import { formatInZone } from "./preview";

export type { ConfiguredSchedule } from "./recurrence";

export type ScheduleState =
  | { kind: "none" }
  | { kind: "active"; schedule: ConfiguredSchedule }
  | { kind: "draft"; schedule: ConfiguredSchedule }
  | { kind: "paused"; schedule: ConfiguredSchedule }
  | { kind: "attention"; schedule: ConfiguredSchedule };

export function scheduleIssues(issues: readonly Issue[]): Issue[] {
  return issues.filter((i) => i.entityType === IssueEntityType.WORKFLOW_SCHEDULE);
}

export function scheduleState(workflow: Workflow, issues: readonly Issue[] = []): ScheduleState {
  const schedule = workflow.schedule;
  if (!isConfigured(schedule)) return { kind: "none" };
  if (scheduleIssues(issues).length > 0) return { kind: "attention", schedule };
  const status = workflow.summary?.status ?? WorkflowStatus.DRAFT;
  if (status === WorkflowStatus.DRAFT) return { kind: "draft", schedule };
  if (!schedule.enabled || status === WorkflowStatus.PAUSED) return { kind: "paused", schedule };
  return { kind: "active", schedule };
}

/** The one-line summary per state (tooltip + panel card body). */
export function scheduleStateLine(state: ScheduleState, now: Date = new Date()): string {
  switch (state.kind) {
    case "none":
      return "Runs only when you start it.";
    case "draft":
      return "Schedule saved. It starts after you activate the workflow.";
    case "paused":
      return "Paused. No scheduled runs until you resume.";
    case "attention":
      return "Not dispatching: fix the issues first.";
    case "active": {
      const next = tsToDate(state.schedule.nextRunAt);
      if (!next) return "No upcoming run.";
      return `Next: ${formatInZone(next, state.schedule.timezone)} (${formatRelative(next, now)})`;
    }
  }
}
