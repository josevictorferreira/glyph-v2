// Run timeline (spec 0020): one row per step run, bars from queued (faint)
// → started → ended on a shared axis, so parallelism and waiting are
// visible. Running bars grow with a local 1s clock.
import { StepRunStatus } from "@/gen/glyph/v1/common_pb";
import type { StepRunSummary } from "@/gen/glyph/v1/run_pb";
import { describeStepRunStatus } from "@/shared/api/enums";
import { cn } from "@/shared/lib/cn";
import { formatDuration, useNow } from "@/shared/lib/time";
import { timeline } from "./lib/run-view";

const BAR: Record<number, string> = {
  [StepRunStatus.QUEUED]: "bg-status-queued",
  [StepRunStatus.RUNNING]: "bg-status-running",
  [StepRunStatus.SUCCEEDED]: "bg-status-succeeded",
  [StepRunStatus.FAILED]: "bg-status-failed",
  [StepRunStatus.SKIPPED]: "bg-status-skipped",
  [StepRunStatus.CANCELLED]: "bg-status-cancelled",
};

export function RunTimeline({
  stepRuns,
  selectedStepRunId,
  onSelectStepRun,
}: {
  stepRuns: readonly StepRunSummary[];
  selectedStepRunId: string | null;
  onSelectStepRun: (id: string) => void;
}) {
  const now = useNow(1000).getTime();
  const { rows, spanMs } = timeline(stepRuns, now);
  if (rows.length === 0) {
    return <p className="p-6 text-center text-sm text-ink-subtle">No step has been queued yet.</p>;
  }
  return (
    <div className="flex h-full flex-col overflow-auto p-4" data-testid="run-timeline">
      <div className="mb-2 flex justify-between pl-40 text-[0.6875rem] text-ink-subtle">
        <span>0s</span>
        <span>{formatDuration(spanMs)}</span>
      </div>
      <ul className="flex flex-col gap-1">
        {rows.map((row) => {
          const status = describeStepRunStatus(row.status);
          return (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => onSelectStepRun(row.id)}
                aria-pressed={row.id === selectedStepRunId}
                aria-label={`${row.name}: ${status.label}`}
                data-testid="timeline-row"
                className={cn(
                  "flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-surface-2",
                  row.id === selectedStepRunId && "bg-surface-2",
                )}
              >
                <span className="w-38 shrink-0 truncate text-xs text-ink">{row.name}</span>
                <span className="relative h-3 flex-1 rounded bg-surface-2">
                  {row.start !== null && (
                    <span
                      className="absolute inset-y-1 rounded bg-status-queued/40"
                      style={{
                        left: `${row.queued}%`,
                        width: `${Math.max(row.start - row.queued, 0)}%`,
                      }}
                      data-testid="timeline-wait"
                    />
                  )}
                  {row.start !== null && row.end !== null && (
                    <span
                      className={cn("absolute inset-y-0 rounded", BAR[row.status])}
                      style={{
                        left: `${row.start}%`,
                        width: `${Math.max(row.end - row.start, 0.5)}%`,
                      }}
                      data-testid="timeline-bar"
                    />
                  )}
                  {row.start === null && (
                    <span className="absolute inset-0 flex items-center pl-1 text-[0.625rem] text-ink-subtle">
                      {status.label}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
