// Sidebar / Home summary lines and ordering (spec 0016). Pure functions over
// WorkflowSummary so they can be tested without a transport.
import { RunStatus, WorkflowStatus } from "@/gen/glyph/v1/common_pb";
import type { WorkflowSummary } from "@/gen/glyph/v1/workflow_pb";
import { formatRelative, tsToMs } from "@/shared/lib/time";
import type { Tone } from "@/shared/api/enums";

export interface SummaryLine {
  text: string;
  dot: Tone;
}

/** The row's secondary line, by most urgent signal the summary carries. */
export function secondaryLine(s: WorkflowSummary, now: Date = new Date()): SummaryLine {
  if (s.lastRunStatus === RunStatus.RUNNING || s.lastRunStatus === RunStatus.QUEUED) {
    const started = tsToMs(s.lastRunAt);
    return {
      text: started === undefined ? "Running" : `Running · ${formatRelative(new Date(started), now)}`,
      dot: "accent",
    };
  }
  if (s.status === WorkflowStatus.NEEDS_ATTENTION) {
    return { text: "Needs attention", dot: "danger" };
  }
  if (s.lastRunStatus === RunStatus.FAILED) {
    const at = tsToMs(s.lastRunAt);
    return {
      text: at === undefined ? "Last run failed" : `Failed ${formatRelative(new Date(at), now)}`,
      dot: "danger",
    };
  }
  const next = tsToMs(s.nextRunAt);
  if (next !== undefined) {
    return { text: `Next ${formatRelative(new Date(next), now)}`, dot: "success" };
  }
  if (s.status === WorkflowStatus.DRAFT) {
    return { text: "Draft", dot: "neutral" };
  }
  const updated = tsToMs(s.updatedAt);
  return {
    text: updated === undefined ? "Workflow" : `Updated ${formatRelative(new Date(updated), now)}`,
    dot: "muted",
  };
}

const rank: Record<number, number> = {
  [WorkflowStatus.NEEDS_ATTENTION]: 0,
  [WorkflowStatus.ACTIVE]: 1,
  [WorkflowStatus.PAUSED]: 2,
  [WorkflowStatus.DRAFT]: 3,
  [WorkflowStatus.UNSPECIFIED]: 4,
};

/** Needs attention first, then running, then most recently updated. */
export function sortWorkflows(list: WorkflowSummary[]): WorkflowSummary[] {
  return [...list].sort((a, b) => {
    const aAttention = needsAttention(a) ? 0 : 1;
    const bAttention = needsAttention(b) ? 0 : 1;
    if (aAttention !== bAttention) return aAttention - bAttention;
    const aRunning = isRunning(a) ? 0 : 1;
    const bRunning = isRunning(b) ? 0 : 1;
    if (aRunning !== bRunning) return aRunning - bRunning;
    const aRank = rank[a.status] ?? 99;
    const bRank = rank[b.status] ?? 99;
    if (aRank !== bRank) return aRank - bRank;
    return (tsToMs(b.updatedAt) ?? 0) - (tsToMs(a.updatedAt) ?? 0);
  });
}

export function isRunning(s: WorkflowSummary): boolean {
  return s.lastRunStatus === RunStatus.RUNNING || s.lastRunStatus === RunStatus.QUEUED;
}

export function needsAttention(s: WorkflowSummary): boolean {
  return s.status === WorkflowStatus.NEEDS_ATTENTION || s.lastRunStatus === RunStatus.FAILED;
}
