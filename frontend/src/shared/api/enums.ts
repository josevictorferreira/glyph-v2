// Exhaustive enum → { label, tone } maps for every proto enum (spec 0014).
// Unspecified values render as "Unknown" and log once.
import {
  IssueEntityType,
  IssueSeverity,
  OutputFileFormat,
  RunStatus,
  RunTrigger,
  StepKind,
  StepRunStatus,
  WorkflowStatus,
} from "@/gen/glyph/v1/common_pb";
import { InputSourceKind, ToolState } from "@/gen/glyph/v1/run_pb";
import { IntervalUnit } from "@/gen/glyph/v1/workflow_pb";
import { EventType } from "@/gen/glyph/v1/live_pb";

export type Tone = "neutral" | "muted" | "accent" | "success" | "danger" | "warning" | "striped";

export interface EnumView {
  label: string;
  tone: Tone;
}

const warned = new Set<string>();
function unknown(enumName: string, value: number): EnumView {
  const key = `${enumName}:${value}`;
  if (!warned.has(key)) {
    warned.add(key);
    console.warn(`[enums] unhandled ${enumName} value ${value}; rendering "Unknown"`);
  }
  return { label: "Unknown", tone: "neutral" };
}

export function describeWorkflowStatus(s: WorkflowStatus): EnumView {
  switch (s) {
    case WorkflowStatus.DRAFT:
      return { label: "Draft", tone: "neutral" };
    case WorkflowStatus.ACTIVE:
      return { label: "Active", tone: "success" };
    case WorkflowStatus.PAUSED:
      return { label: "Paused", tone: "warning" };
    case WorkflowStatus.NEEDS_ATTENTION:
      return { label: "Needs attention", tone: "danger" };
    default:
      return unknown("WorkflowStatus", s);
  }
}

export function describeRunStatus(s: RunStatus): EnumView {
  switch (s) {
    case RunStatus.QUEUED:
      return { label: "Queued", tone: "neutral" };
    case RunStatus.RUNNING:
      return { label: "Running", tone: "accent" };
    case RunStatus.SUCCEEDED:
      return { label: "Succeeded", tone: "success" };
    case RunStatus.FAILED:
      return { label: "Failed", tone: "danger" };
    case RunStatus.CANCELLED:
      return { label: "Cancelled", tone: "muted" };
    default:
      return unknown("RunStatus", s);
  }
}

export function describeStepRunStatus(s: StepRunStatus): EnumView {
  switch (s) {
    case StepRunStatus.QUEUED:
      return { label: "Queued", tone: "neutral" };
    case StepRunStatus.RUNNING:
      return { label: "Running", tone: "accent" };
    case StepRunStatus.SUCCEEDED:
      return { label: "Succeeded", tone: "success" };
    case StepRunStatus.FAILED:
      return { label: "Failed", tone: "danger" };
    case StepRunStatus.SKIPPED:
      return { label: "Skipped", tone: "striped" };
    case StepRunStatus.CANCELLED:
      return { label: "Cancelled", tone: "muted" };
    default:
      return unknown("StepRunStatus", s);
  }
}

export function describeStepKind(k: StepKind): EnumView {
  switch (k) {
    case StepKind.PI:
      return { label: "Pi", tone: "accent" };
    case StepKind.HELPER:
      return { label: "Helper", tone: "neutral" };
    default:
      return unknown("StepKind", k);
  }
}

export function describeOutputFileFormat(f: OutputFileFormat): EnumView {
  switch (f) {
    case OutputFileFormat.FREE_TEXT_MARKDOWN:
      return { label: "Markdown", tone: "neutral" };
    case OutputFileFormat.HTML:
      return { label: "HTML", tone: "neutral" };
    case OutputFileFormat.JSON:
      return { label: "JSON", tone: "neutral" };
    case OutputFileFormat.ZIP:
      return { label: "ZIP", tone: "neutral" };
    default:
      return unknown("OutputFileFormat", f);
  }
}

export function describeRunTrigger(t: RunTrigger): EnumView {
  switch (t) {
    case RunTrigger.MANUAL:
      return { label: "Manual", tone: "neutral" };
    case RunTrigger.SCHEDULED:
      return { label: "Scheduled", tone: "neutral" };
    default:
      return unknown("RunTrigger", t);
  }
}

export function describeIssueSeverity(s: IssueSeverity): EnumView {
  switch (s) {
    case IssueSeverity.ERROR:
      return { label: "Error", tone: "danger" };
    default:
      return unknown("IssueSeverity", s);
  }
}

export function describeIssueEntityType(t: IssueEntityType): EnumView {
  switch (t) {
    case IssueEntityType.WORKFLOW:
      return { label: "Workflow", tone: "neutral" };
    case IssueEntityType.WORKFLOW_STEP:
      return { label: "Step", tone: "neutral" };
    case IssueEntityType.STEP_INPUT:
      return { label: "Input", tone: "neutral" };
    case IssueEntityType.WORKFLOW_INPUT:
      return { label: "Value", tone: "neutral" };
    case IssueEntityType.WORKFLOW_CONNECTION:
      return { label: "Connection", tone: "neutral" };
    case IssueEntityType.WORKFLOW_SCHEDULE:
      return { label: "Schedule", tone: "neutral" };
    default:
      return unknown("IssueEntityType", t);
  }
}

export function describeInputSourceKind(k: InputSourceKind): EnumView {
  switch (k) {
    case InputSourceKind.NONE:
      return { label: "Not connected", tone: "muted" };
    case InputSourceKind.STEP_OUTPUT:
      return { label: "Step output", tone: "neutral" };
    case InputSourceKind.WORKFLOW_VALUE:
      return { label: "Workflow value", tone: "neutral" };
    case InputSourceKind.CONSTANT:
      return { label: "Constant", tone: "neutral" };
    default:
      return unknown("InputSourceKind", k);
  }
}

export function describeToolState(s: ToolState): EnumView {
  switch (s) {
    case ToolState.RUNNING:
      return { label: "Running", tone: "accent" };
    case ToolState.DONE:
      return { label: "Done", tone: "success" };
    case ToolState.ERROR:
      return { label: "Error", tone: "danger" };
    default:
      return unknown("ToolState", s);
  }
}

export function describeIntervalUnit(u: IntervalUnit): EnumView {
  switch (u) {
    case IntervalUnit.MINUTES:
      return { label: "minutes", tone: "neutral" };
    case IntervalUnit.HOURS:
      return { label: "hours", tone: "neutral" };
    default:
      return unknown("IntervalUnit", u);
  }
}

export function describeEventType(t: EventType): EnumView {
  switch (t) {
    case EventType.WORKFLOW_UPDATED:
      return { label: "Workflow updated", tone: "neutral" };
    case EventType.RUN_QUEUED:
      return { label: "Run queued", tone: "neutral" };
    case EventType.RUN_STARTED:
      return { label: "Run started", tone: "accent" };
    case EventType.RUN_SUCCEEDED:
      return { label: "Run succeeded", tone: "success" };
    case EventType.RUN_FAILED:
      return { label: "Run failed", tone: "danger" };
    case EventType.RUN_CANCELLED:
      return { label: "Run cancelled", tone: "muted" };
    case EventType.STEP_RUN_QUEUED:
      return { label: "Step queued", tone: "neutral" };
    case EventType.STEP_RUN_STARTED:
      return { label: "Step started", tone: "accent" };
    case EventType.STEP_RUN_PROGRESS:
      return { label: "Step progress", tone: "accent" };
    case EventType.STEP_RUN_SUCCEEDED:
      return { label: "Step succeeded", tone: "success" };
    case EventType.STEP_RUN_FAILED:
      return { label: "Step failed", tone: "danger" };
    case EventType.STEP_RUN_SKIPPED:
      return { label: "Step skipped", tone: "striped" };
    case EventType.STEP_RUN_CANCELLED:
      return { label: "Step cancelled", tone: "muted" };
    case EventType.RESYNC:
      return { label: "Resync", tone: "warning" };
    case EventType.HEARTBEAT:
      return { label: "Heartbeat", tone: "muted" };
    case EventType.RUN_DELETED:
      return { label: "Run deleted", tone: "muted" };
    default:
      return unknown("EventType", t);
  }
}
