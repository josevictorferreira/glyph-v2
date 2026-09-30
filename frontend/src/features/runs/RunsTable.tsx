// Runs mode (spec 0020): run history, newest first, paged by the
// ListRuns{before} cursor (20 per page) with an infinite-scroll sentinel.
// Rows open the run lens; live rows tick and can be stopped; delete
// confirms. Live invalidation covers these pages (runKeys.lists).
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useInfiniteQuery } from "@connectrpc/connect-query";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { RunService } from "@/gen/glyph/v1/run_pb";
import type { Run } from "@/gen/glyph/v1/run_pb";
import { appErrorToast } from "@/shared/api/errors";
import { describeRunTrigger } from "@/shared/api/enums";
import { tsToDate } from "@/shared/lib/time";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Duration,
  EmptyState,
  Play,
  RelativeTime,
  RunStatusBadge,
  Skeleton,
  toast,
} from "@/shared/ui";
import { isLiveRun } from "./lib/run-view";
import { useRunSheet } from "./RunSheet";
import { useRunDuration } from "./hooks";
import { useDeleteRun, useStopRun } from "./use-run-actions";

const PAGE = 20;
/** First page cursor: "before the end of time" (stable query key). */
const FIRST_PAGE = timestampFromMs(Date.UTC(9999, 11, 31));

export function RunsTable({ workflowId }: { workflowId: string }) {
  const { runNow } = useRunSheet();
  const query = useInfiniteQuery(
    RunService.method.listRuns,
    { workflowId, limit: PAGE, before: FIRST_PAGE },
    {
      pageParamKey: "before",
      getNextPageParam: (last) =>
        last.runs.length < PAGE ? undefined : last.runs.at(-1)?.createdAt,
    },
  );
  const sentinel = useRef<HTMLDivElement | null>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (query.isLoading) return <Skeleton className="m-4 h-40" />;
  const runs = query.data?.pages.flatMap((p) => p.runs) ?? [];
  if (runs.length === 0) {
    return (
      <EmptyState
        title="No runs yet"
        description="This workflow has not run. Start one to see its evidence here."
        actions={
          <Button variant="primary" onClick={runNow} data-testid="runs-empty-run-now">
            <Play /> Run now
          </Button>
        }
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto p-4" data-testid="runs-table">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-ink-subtle">
          <tr>
            <th className="py-1 font-medium">Status</th>
            <th className="py-1 font-medium">Started</th>
            <th className="py-1 font-medium">Trigger</th>
            <th className="py-1 font-medium">Duration</th>
            <th className="py-1 font-medium">Failure</th>
            <th className="py-1 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <RunRow key={run.id} workflowId={workflowId} run={run} />
          ))}
        </tbody>
      </table>
      <div ref={sentinel} className="h-8" />
      {hasNextPage && (
        <Button
          size="sm"
          variant="ghost"
          loading={isFetchingNextPage}
          onClick={() => void fetchNextPage()}
        >
          Load more
        </Button>
      )}
    </div>
  );
}

function RunRow({ workflowId, run }: { workflowId: string; run: Run }) {
  const duration = useRunDuration(run);
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const stop = useStopRun((e) => toast({ title: appErrorToast(e), tone: "danger" }));
  const remove = useDeleteRun((e) => toast({ title: appErrorToast(e), tone: "danger" }));
  const started = tsToDate(run.startedAt) ?? tsToDate(run.queuedAt) ?? tsToDate(run.createdAt);
  const live = isLiveRun(run.status);

  return (
    <tr className="border-t border-border" data-testid="run-row">
      <td className="py-2">
        <Link
          to="/workflows/$id/runs/$runId"
          params={{ id: workflowId, runId: run.id }}
          className="inline-flex items-center gap-2 hover:underline"
          aria-label={`Open run from ${started?.toISOString() ?? "unknown time"}`}
        >
          <RunStatusBadge status={run.status} />
        </Link>
        {run.draftTest && (
          <Badge tone="muted" className="ml-1">
            Draft test
          </Badge>
        )}
      </td>
      <td className="py-2 text-ink-muted">{started && <RelativeTime date={started} />}</td>
      <td className="py-2 text-ink-muted">{describeRunTrigger(run.trigger).label}</td>
      <td className="py-2 text-ink-muted">
        <Duration ms={duration} />
      </td>
      <td className="max-w-64 truncate py-2 text-xs text-status-failed" title={run.failureSummary}>
        {run.failureSummary}
      </td>
      <td className="py-2 text-right">
        <div className="flex justify-end gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void navigate({
                to: "/workflows/$id/runs/$runId",
                params: { id: workflowId, runId: run.id },
              })
            }
          >
            Open
          </Button>
          {live && (
            <Button
              size="sm"
              variant="ghost"
              loading={stop.isPending}
              onClick={() => stop.mutate({ workflowId, runId: run.id })}
            >
              Stop
            </Button>
          )}
          <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
            Delete
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
                onClick={() =>
                  remove.mutate(
                    { workflowId, runId: run.id },
                    { onSettled: () => setConfirmDelete(false) },
                  )
                }
              >
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </td>
    </tr>
  );
}
