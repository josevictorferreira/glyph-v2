// Pure run helpers (spec 0020): live state, run sheet prefill, timeline
// geometry and snapshot staleness. Rendering never reads the current
// workflow for evidence — only the run snapshot and step runs.
import { RunStatus, StepRunStatus } from "@/gen/glyph/v1/common_pb";
import type { Run, StepRunSummary } from "@/gen/glyph/v1/run_pb";
import type { Workflow, WorkflowInput } from "@/gen/glyph/v1/workflow_pb";
import { tsToMs } from "@/shared/lib/time";

export function isLiveRun(status: RunStatus): boolean {
  return status === RunStatus.QUEUED || status === RunStatus.RUNNING;
}

export function isLiveStepRun(status: StepRunStatus): boolean {
  return status === StepRunStatus.QUEUED || status === StepRunStatus.RUNNING;
}

/** Elapsed time: stored ms when finished, otherwise measured to `now`. */
export function elapsedMs(
  item: Pick<Run | StepRunSummary, "startedAt" | "endedAt" | "elapsedMs">,
  now: number,
): number | undefined {
  if (item.elapsedMs !== undefined) return Number(item.elapsedMs);
  const start = tsToMs(item.startedAt);
  if (start === undefined) return undefined;
  return (tsToMs(item.endedAt) ?? now) - start;
}

// ---------------------------------------------------------------------------
// Run sheet
// ---------------------------------------------------------------------------

export function askedInputs(workflow: Workflow): WorkflowInput[] {
  return workflow.inputs.filter((i) => i.askAtRunTime);
}

/** The sheet opens only when a required value is asked at run time. */
export function needsRunSheet(workflow: Workflow): boolean {
  return askedInputs(workflow).some((i) => i.required);
}

export interface PrefilledValue {
  value: string;
  /** Came from the latest run's supplied values ("Used last time"). */
  fromLastRun: boolean;
}

/** Stored default first, else the latest run's supplied value, else empty. */
export function prefillValues(
  workflow: Workflow,
  lastRun: Run | undefined,
): Record<string, PrefilledValue> {
  const out: Record<string, PrefilledValue> = {};
  for (const input of askedInputs(workflow)) {
    const stored = input.value ?? "";
    const last = lastRun?.suppliedValues[input.name] ?? "";
    out[input.name] = stored.trim()
      ? { value: stored, fromLastRun: false }
      : { value: last, fromLastRun: last.trim().length > 0 };
  }
  return out;
}

/** Required asked values left blank (they have no stored default either). */
export function missingValues(workflow: Workflow, values: Record<string, string>): string[] {
  return askedInputs(workflow)
    .filter((i) => i.required && !(values[i.name] ?? "").trim() && !(i.value ?? "").trim())
    .map((i) => i.name);
}

/** Values to send: only non-blank entries (blank falls back to the stored value). */
export function valuesToSend(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim().length > 0));
}

export function looksLikeJson(value: string): boolean {
  const t = value.trim();
  return (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export interface TimelineRow {
  id: string;
  name: string;
  status: StepRunStatus;
  /** Percent offsets on the shared time axis (0–100). */
  queued: number;
  start: number | null;
  end: number | null;
}

export interface Timeline {
  rows: TimelineRow[];
  /** Axis span in ms (≥ 1). */
  spanMs: number;
}

/**
 * Waterfall geometry: rows ordered by start (never-started rows last, by
 * position), bars queued → started → ended on one axis from the earliest
 * queue time to the latest end (or `now` while anything runs).
 */
export function timeline(stepRuns: readonly StepRunSummary[], now: number): Timeline {
  const times = stepRuns.map((s) => ({
    s,
    queued: tsToMs(s.queuedAt) ?? tsToMs(s.startedAt),
    start: tsToMs(s.startedAt),
    end: tsToMs(s.endedAt) ?? (s.status === StepRunStatus.RUNNING ? now : undefined),
  }));
  const known = times
    .flatMap((t) => [t.queued, t.start, t.end])
    .filter((v): v is number => v !== undefined);
  if (known.length === 0) return { rows: [], spanMs: 1 };
  const origin = Math.min(...known);
  const spanMs = Math.max(Math.max(...known) - origin, 1);
  const pct = (v: number | undefined) => (v === undefined ? null : ((v - origin) / spanMs) * 100);

  const rows = [...times]
    .sort((a, b) => {
      if (a.start === undefined && b.start === undefined) return a.s.position - b.s.position;
      if (a.start === undefined) return 1;
      if (b.start === undefined) return -1;
      return a.start - b.start || a.s.position - b.s.position;
    })
    .map((t) => ({
      id: t.s.id,
      name: t.s.stepName,
      status: t.s.status,
      queued: pct(t.queued) ?? 0,
      start: pct(t.start),
      end: t.start === undefined ? null : pct(t.end),
    }));
  return { rows, spanMs };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/** The workflow changed after this run captured its snapshot. */
export function snapshotOutdated(run: Run, workflow: Workflow | undefined): boolean {
  const captured = tsToMs(run.snapshot?.capturedAt);
  const updated = tsToMs(workflow?.summary?.updatedAt);
  return captured !== undefined && updated !== undefined && updated > captured;
}
