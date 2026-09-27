// Home overview (spec 0016): what needs me, what is running, what runs next,
// what recently finished. Sections hide when empty; a first-run empty state
// replaces everything when no workflow exists.
import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { RunStatus, WorkflowStatus } from "@/gen/glyph/v1/common_pb";
import type { WorkflowSummary } from "@/gen/glyph/v1/workflow_pb";
import { useRuns } from "@/features/runs";
import { useValidateWorkflow, useWorkflowList } from "@/features/workflows";
import { needsAttention, isRunning, useCreateWorkflowDialog } from "@/features/library";
import { describeRunStatus, describeWorkflowStatus } from "@/shared/api/enums";
import { formatExact, formatRelative, tsToDate, useNow } from "@/shared/lib/time";
import { Badge, Button, EmptyState, Plus, StatusDot } from "@/shared/ui";

export function HomePage() {
  // Poll every 15s while Home is visible (react-query pauses in hidden tabs
  // unless refetchIntervalInBackground, which we leave off).
  const { data, isLoading } = useWorkflowList({ limit: 100 }, { refetchInterval: 15_000 });
  const now = useNow(10_000);
  const workflows = useMemo(() => data?.workflows ?? [], [data?.workflows]);

  const attention = useMemo(() => workflows.filter(needsAttention), [workflows]);
  const running = useMemo(() => workflows.filter(isRunning), [workflows]);
  const upNext = useMemo(
    () =>
      workflows
        .filter((w) => w.status === WorkflowStatus.ACTIVE && w.nextRunAt !== undefined)
        .sort((a, b) => (tsToDate(a.nextRunAt)?.getTime() ?? 0) - (tsToDate(b.nextRunAt)?.getTime() ?? 0)),
    [workflows],
  );
  const finished = useMemo(
    () =>
      workflows
        .filter((w) => w.lastRunAt !== undefined && !isRunning(w))
        .sort((a, b) => (tsToDate(b.lastRunAt)?.getTime() ?? 0) - (tsToDate(a.lastRunAt)?.getTime() ?? 0))
        .slice(0, 8),
    [workflows],
  );

  if (isLoading) {
    return <div className="p-6 text-sm text-ink-subtle">Loading…</div>;
  }

  if (workflows.length === 0) {
    return <FirstRun />;
  }

  return (
    <div className="h-full overflow-y-auto p-6" data-testid="home-page">
      <h1 className="mb-4 text-lg font-semibold">Home</h1>
      <div className="grid gap-6 lg:grid-cols-2">
        {attention.length > 0 && (
          <Section title="Needs attention" testId="home-attention">
            {attention.map((w) => (
              <AttentionCard key={w.id} workflow={w} now={now} />
            ))}
          </Section>
        )}
        {running.length > 0 && (
          <Section title="Running now" testId="home-running">
            {running.map((w) => (
              <RunningCard key={w.id} workflow={w} now={now} />
            ))}
          </Section>
        )}
        {upNext.length > 0 && (
          <Section title="Up next" testId="home-next">
            {upNext.map((w) => {
              const at = tsToDate(w.nextRunAt);
              return (
                <WorkflowCard key={w.id} workflow={w} testId="home-next-card">
                  <span className="text-xs text-ink-muted">
                    {at ? `${formatRelative(at, now)} · ${formatExact(at)}` : null}
                  </span>
                  {w.scheduleSummary && <span className="text-xs text-ink-subtle">{w.scheduleSummary}</span>}
                </WorkflowCard>
              );
            })}
          </Section>
        )}
        {finished.length > 0 && (
          <Section title="Recently finished" testId="home-finished">
            {finished.map((w) => {
              const at = tsToDate(w.lastRunAt);
              const status = w.lastRunStatus ? describeRunStatus(w.lastRunStatus) : undefined;
              return (
                <WorkflowCard key={w.id} workflow={w} testId="home-finished-card">
                  {status && <Badge tone={status.tone === "striped" ? "muted" : status.tone}>{status.label}</Badge>}
                  {at && <span className="text-xs text-ink-subtle">{formatRelative(at, now)}</span>}
                </WorkflowCard>
              );
            })}
          </Section>
        )}
      </div>
    </div>
  );
}

function FirstRun() {
  const createDialog = useCreateWorkflowDialog();
  return (
    <div className="grid h-full place-items-center p-6" data-testid="home-first-run">
      <EmptyState
        title="Build your first workflow"
        description="Chain AI agent steps into a pipeline, or import one from a YAML definition."
        actions={
          <div className="flex gap-2">
            <Button data-testid="first-run-new" onClick={() => createDialog.open("blank")}>
              <Plus /> New workflow
            </Button>
            <Button variant="secondary" data-testid="first-run-import" onClick={() => createDialog.open("yaml")}>
              Import YAML
            </Button>
          </div>
        }
      />
    </div>
  );
}

function Section({ title, testId, children }: { title: string; testId: string; children: React.ReactNode }) {
  return (
    <section data-testid={testId} aria-label={title}>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-subtle">{title}</h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

/** Card chrome shared by all sections; extra rows render under the name. */
function WorkflowCard({
  workflow,
  testId,
  children,
}: {
  workflow: WorkflowSummary;
  testId: string;
  children?: React.ReactNode;
}) {
  const status = describeWorkflowStatus(workflow.status);
  return (
    <div data-testid={testId} className="rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center gap-2">
        <StatusDot tone={status.tone} />
        <Link
          to="/workflows/$id"
          params={{ id: workflow.id }}
          className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
        >
          {workflow.name}
        </Link>
      </div>
      <div className="mt-1 flex items-center gap-2 pl-5">{children}</div>
    </div>
  );
}

function AttentionCard({ workflow, now }: { workflow: WorkflowSummary; now: Date }) {
  const { data: validation } = useValidateWorkflow(workflow.id);
  const at = tsToDate(workflow.lastRunAt);
  const reason =
    workflow.status === WorkflowStatus.NEEDS_ATTENTION
      ? (validation?.issues.find((i: { message: string }) => i.message.length > 0)?.message ?? "Blocked by validation issues")
      : at
        ? `Last run failed ${formatRelative(at, now)}`
        : "Last run failed";
  return (
    <WorkflowCard workflow={workflow} testId="home-attention-card">
      <span className="min-w-0 flex-1 truncate text-xs text-danger">{reason}</span>
      <div className="flex shrink-0 gap-1.5">
        <Link
          to="/workflows/$id"
          params={{ id: workflow.id }}
          className="rounded-md border border-border px-2 py-0.5 text-xs hover:bg-surface-2"
          data-testid="attention-open"
        >
          Open
        </Link>
        <Link
          to="/workflows/$id"
          params={{ id: workflow.id }}
          className="rounded-md border border-accent px-2 py-0.5 text-xs text-accent hover:bg-accent/10"
          data-testid="attention-fix"
        >
          Fix
        </Link>
        {workflow.lastRunStatus === RunStatus.FAILED && <ViewRunLink workflow={workflow} />}
      </div>
    </WorkflowCard>
  );
}

function RunningCard({ workflow, now }: { workflow: WorkflowSummary; now: Date }) {
  const started = tsToDate(workflow.lastRunAt);
  const { data: runs } = useRuns(workflow.id, 1);
  const latest = runs?.runs[0];
  return (
    <WorkflowCard workflow={workflow} testId="home-running-card">
      <span className="min-w-0 flex-1 text-xs text-ink-muted">
        {started ? `Running · ${formatRelative(started, now)}` : "Running"}
      </span>
      {latest && (
        <Link
          to="/workflows/$id/runs/$runId"
          params={{ id: workflow.id, runId: latest.id }}
          className="shrink-0 rounded-md border border-border px-2 py-0.5 text-xs hover:bg-surface-2"
          data-testid="running-view-run"
        >
          View run
        </Link>
      )}
    </WorkflowCard>
  );
}

/** Latest-run link via ListRuns{limit:1}; renders nothing before it loads. */
function ViewRunLink({ workflow }: { workflow: WorkflowSummary }) {
  const { data: runs } = useRuns(workflow.id, 1);
  const latest = runs?.runs[0];
  if (!latest) return null;
  return (
    <Link
      to="/workflows/$id/runs/$runId"
      params={{ id: workflow.id, runId: latest.id }}
      className="rounded-md border border-border px-2 py-0.5 text-xs hover:bg-surface-2"
      data-testid="attention-view-run"
    >
      View run
    </Link>
  );
}
