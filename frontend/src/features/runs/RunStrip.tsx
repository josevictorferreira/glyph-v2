// Run strip (spec 0020): the last 20 runs as status chips along the bottom
// of the workspace (all modes), newest on the right. Hover shows start,
// duration and failure; click opens the run lens; "+" runs now.
import { Link } from "@tanstack/react-router";
import { RunTrigger } from "@/gen/glyph/v1/common_pb";
import type { Run } from "@/gen/glyph/v1/run_pb";
import { describeRunStatus, describeRunTrigger } from "@/shared/api/enums";
import { cn } from "@/shared/lib/cn";
import { formatDuration, formatExact, tsToDate, useNow } from "@/shared/lib/time";
import { Clock, IconButton, Plus, StatusDot } from "@/shared/ui";
import { useRuns } from "./hooks";
import { elapsedMs, isLiveRun } from "./lib/run-view";
import { useRunSheet } from "./RunSheet";

export function runChipTitle(run: Run, now: number): string {
  const status = describeRunStatus(run.status).label;
  const started = tsToDate(run.startedAt) ?? tsToDate(run.queuedAt);
  const parts = [
    `${status} · ${describeRunTrigger(run.trigger).label}${run.draftTest ? " (draft test)" : ""}`,
    started ? `Started ${formatExact(started)}` : "Not started",
    `Duration ${formatDuration(elapsedMs(run, now))}`,
  ];
  if (run.failureSummary) parts.push(run.failureSummary);
  return parts.join("\n");
}

export function RunStrip({
  workflowId,
  activeRunId,
}: {
  workflowId: string;
  activeRunId?: string;
}) {
  const { data } = useRuns(workflowId, 20);
  const { runNow } = useRunSheet();
  const runs = [...(data?.runs ?? [])].reverse(); // newest right
  const now = useNow(5_000).getTime();

  return (
    <div
      className="flex h-9 shrink-0 items-center gap-2 border-t border-border bg-surface px-3"
      data-testid="run-strip"
    >
      <span className="text-xs text-ink-subtle">Runs</span>
      <ol className="flex min-w-0 flex-1 items-center justify-end gap-1 overflow-x-auto">
        {runs.length === 0 && <li className="text-xs text-ink-subtle">No runs yet</li>}
        {runs.map((run) => {
          const status = describeRunStatus(run.status);
          return (
            <li key={run.id}>
              <Link
                to="/workflows/$id/runs/$runId"
                params={{ id: workflowId, runId: run.id }}
                title={runChipTitle(run, now)}
                aria-label={runChipTitle(run, now).split("\n")[0]}
                data-testid="run-chip"
                className={cn(
                  "flex h-6 items-center gap-1 rounded-md border border-border px-1.5 hover:bg-surface-2",
                  run.id === activeRunId && "border-accent bg-accent/10",
                  run.draftTest && "border-dashed",
                )}
              >
                <StatusDot tone={status.tone} pulse={isLiveRun(run.status)} />
                {run.trigger === RunTrigger.SCHEDULED && (
                  <Clock className="size-3 text-ink-subtle" aria-hidden />
                )}
              </Link>
            </li>
          );
        })}
      </ol>
      <Link
        to="/workflows/$id/runs"
        params={{ id: workflowId }}
        className="shrink-0 text-xs text-accent hover:underline"
      >
        View all
      </Link>
      <IconButton label="Run now" size="sm" onClick={runNow} data-testid="strip-run-now">
        <Plus className="size-3.5" />
      </IconButton>
    </div>
  );
}
