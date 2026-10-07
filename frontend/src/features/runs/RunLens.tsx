// Run lens (spec 0020): the workflow canvas painted with one run's evidence,
// or a timeline of its step runs, plus the step run panel. Renders from the
// run snapshot only. A failed run opens on its first failed step.
import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { RunStatus } from "@/gen/glyph/v1/common_pb";
import type { Run } from "@/gen/glyph/v1/run_pb";
import { WorkflowCanvas } from "@/features/canvas";
import { useWorkflow } from "@/features/workflows";
import { appErrorToast } from "@/shared/api/errors";
import { describeRunTrigger } from "@/shared/api/enums";
import { cn } from "@/shared/lib/cn";
import { formatExact, tsToDate } from "@/shared/lib/time";
import {
  AlertTriangle,
  Badge,
  Button,
  ChevronRight,
  Dialog,
  DialogContent,
  DialogFooter,
  Disclosure,
  Duration,
  EmptyState,
  Panel,
  PanelGroup,
  PanelHandle,
  RelativeTime,
  RunStatusBadge,
  Skeleton,
  Stop,
  toast,
  Trash,
} from "@/shared/ui";
import { useRun, useRunDuration } from "./hooks";
import { isLiveRun, snapshotOutdated } from "./lib/run-view";
import { StepRunPanel } from "./StepRunPanel";
import { RunTimeline } from "./Timeline";
import { useDeleteRun, useStopRun } from "./use-run-actions";

export type RunLensView = "graph" | "timeline";

export interface RunLensProps {
  workflowId: string;
  runId: string;
  /** ?step= — a step run id. */
  stepRunId: string | null;
  view: RunLensView;
  onNavigate: (search: { step?: string; view?: RunLensView }) => void;
}

export function RunLens({ workflowId, runId, stepRunId, view, onNavigate }: RunLensProps) {
  const { data, isLoading, error } = useRun(workflowId, runId);
  const run = data?.run;
  if (isLoading) return <Skeleton className="h-full w-full" />;
  if (!run || error) {
    return (
      <EmptyState
        title="Run not found"
        description="It may have been deleted."
        actions={
          <Link
            to="/workflows/$id/runs"
            params={{ id: workflowId }}
            className="text-sm text-accent hover:underline"
          >
            All runs
          </Link>
        }
      />
    );
  }

  // Evidence first: a failed run opens on its first failed step.
  const selected = stepRunId ?? run.firstFailedStepRunId ?? null;
  const select = (id: string | null) => onNavigate({ step: id ?? undefined, view });
  const selectedSummary = run.stepRuns.find((s) => s.id === selected);

  return (
    <div className="flex h-full flex-col" data-testid="run-lens">
      <RunHeader workflowId={workflowId} run={run} />
      {run.status === RunStatus.FAILED && run.failureSummary && (
        <div
          className="flex items-center gap-2 border-b border-status-failed/30 bg-status-failed/10 px-3 py-2 text-sm"
          role="alert"
          data-testid="failure-banner"
        >
          <AlertTriangle className="size-4 shrink-0 text-status-failed" />
          <span className="min-w-0 flex-1 text-ink">{run.failureSummary}</span>
          {run.firstFailedStepRunId && run.firstFailedStepRunId !== selected && (
            <Button size="sm" variant="ghost" onClick={() => select(run.firstFailedStepRunId!)}>
              Open failed step <ChevronRight className="size-3.5" />
            </Button>
          )}
        </div>
      )}
      <div className="flex items-center gap-3 border-b border-border px-3 py-1.5">
        <div
          role="tablist"
          aria-label="Run view"
          className="flex h-7 items-center rounded-lg bg-surface-2 p-0.5"
        >
          {(["graph", "timeline"] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => onNavigate({ step: stepRunId ?? undefined, view: v })}
              className={cn(
                "flex h-6 items-center rounded-md px-2.5 text-xs font-medium text-ink-muted",
                view === v && "bg-surface text-ink shadow-sm",
              )}
            >
              {v === "graph" ? "Graph" : "Timeline"}
            </button>
          ))}
        </div>
        <SuppliedValues run={run} />
      </div>
      <PanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <Panel id="lens-main" minSize="30%">
          {view === "timeline" ? (
            <RunTimeline
              stepRuns={run.stepRuns}
              selectedStepRunId={selected}
              onSelectStepRun={select}
            />
          ) : run.snapshot ? (
            <WorkflowCanvas
              mode="lens"
              snapshot={run.snapshot}
              stepRuns={run.stepRuns}
              firstFailedStepRunId={run.firstFailedStepRunId}
              selectedStepId={selectedSummary?.snapshotStepId ?? null}
              onSelectStep={(snapshotStepId) => {
                if (!snapshotStepId) return;
                const stepRun = run.stepRuns.find((s) => s.snapshotStepId === snapshotStepId);
                if (stepRun) select(stepRun.id);
              }}
            />
          ) : null}
        </Panel>
        <PanelHandle />
        <Panel
          id="lens-panel"
          defaultSize="36%"
          minSize="24%"
          maxSize="60%"
          className="border-l border-border bg-surface"
        >
          {selected ? (
            <StepRunPanel
              key={selected}
              workflowId={workflowId}
              run={run}
              stepRunId={selected}
              onSelectStepRun={select}
            />
          ) : (
            <p className="p-6 text-center text-sm text-ink-subtle">
              Select a step to see its evidence.
            </p>
          )}
        </Panel>
      </PanelGroup>
    </div>
  );
}

function RunHeader({ workflowId, run }: { workflowId: string; run: Run }) {
  const navigate = useNavigate();
  const duration = useRunDuration(run);
  const { data } = useWorkflow(workflowId);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const stop = useStopRun((e) => toast({ title: appErrorToast(e), tone: "danger" }));
  const remove = useDeleteRun((e) => {
    setConfirmDelete(false);
    toast({ title: appErrorToast(e), tone: "danger" });
  });
  const live = isLiveRun(run.status);
  const queued = tsToDate(run.queuedAt);
  const started = tsToDate(run.startedAt);
  const ended = tsToDate(run.endedAt);
  const captured = tsToDate(run.snapshot?.capturedAt);

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2 text-xs text-ink-muted"
      data-testid="run-header"
    >
      <Link to="/workflows/$id" params={{ id: workflowId }} className="text-accent hover:underline">
        ← Back to build
      </Link>
      <RunStatusBadge status={run.status} />
      <span>{describeRunTrigger(run.trigger).label}</span>
      {run.draftTest && <Badge tone="muted">Draft test</Badge>}
      {queued && <span title={formatExact(queued)}>Queued {formatExact(queued)}</span>}
      {started && <span>Started {formatExact(started)}</span>}
      {ended && <span>Ended {formatExact(ended)}</span>}
      <span>
        Duration <Duration ms={duration} className="text-ink" data-testid="run-duration" />
      </span>
      {captured && (
        <span data-testid="snapshot-note">
          Snapshot captured <RelativeTime date={captured} />
          {snapshotOutdated(run, data?.workflow) &&
            " · This run used an earlier version of the workflow."}
        </span>
      )}
      <div className="ml-auto flex gap-2">
        {live && (
          <Button
            size="sm"
            loading={stop.isPending}
            onClick={() => stop.mutate({ workflowId, runId: run.id })}
            data-testid="stop-run"
          >
            <Stop className="size-3.5" /> Stop
          </Button>
        )}
        <Button
          size="sm"
          variant="danger"
          onClick={() => setConfirmDelete(true)}
          data-testid="delete-run"
        >
          <Trash className="size-3.5" /> Delete
        </Button>
      </div>
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent
          title="Delete this run?"
          description="Deletes this run's evidence permanently."
        >
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={remove.isPending}
              data-testid="confirm-delete-run"
              onClick={() =>
                remove.mutate(
                  { workflowId, runId: run.id },
                  {
                    onSuccess: () =>
                      void navigate({ to: "/workflows/$id/runs", params: { id: workflowId } }),
                  },
                )
              }
            >
              <Trash className="size-3.5" /> Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SuppliedValues({ run }: { run: Run }) {
  const entries = Object.entries(run.suppliedValues);
  if (entries.length === 0) return null;
  return (
    <Disclosure title={`Supplied values (${entries.length})`} className="text-xs">
      <dl className="flex flex-col gap-1 py-1 text-xs">
        {entries.map(([name, value]) => (
          <div key={name} className="flex gap-2">
            <dt className="font-mono text-ink-muted">{name}</dt>
            <dd className="min-w-0 truncate font-mono text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </Disclosure>
  );
}
