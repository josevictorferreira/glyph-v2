// Schedule summary card (spec 0019): the five states shown in the workflow
// panel. Copy is spec/Rails wording; the composer sheet does the editing.
import type { Workflow } from "@/gen/glyph/v1/workflow_pb";
import { useIssues } from "@/features/workflows";
import { Badge, Button, RelativeTime } from "@/shared/ui";
import { tsToDate } from "@/shared/lib/time";
import { scheduleIssues, scheduleState, scheduleStateLine } from "./lib/state";

export function ScheduleCard({
  workflow,
  onOpenComposer,
  onOpenReadiness,
}: {
  workflow: Workflow;
  onOpenComposer: () => void;
  onOpenReadiness: () => void;
}) {
  const issues = useIssues(workflow.summary?.id ?? "");
  const state = scheduleState(workflow, issues.all);

  if (state.kind === "none") {
    return (
      <div className="flex flex-col gap-2" data-testid="schedule-none">
        <p className="text-xs text-ink-subtle">Runs only when you start it.</p>
        <div>
          <Button size="sm" variant="secondary" onClick={onOpenComposer}>
            Add schedule
          </Button>
        </div>
      </div>
    );
  }

  const { schedule } = state;
  const lastDispatched = tsToDate(schedule.lastDispatchedAt);

  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border bg-surface px-2.5 py-2 text-xs"
      data-testid={`schedule-${state.kind}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-ink">{schedule.humanDescription || "Custom recurrence"}</span>
        {state.kind === "active" && <Badge tone="success">Enabled</Badge>}
        {state.kind === "paused" && <Badge tone="warning">Paused</Badge>}
        {state.kind === "attention" && <Badge tone="danger">Not dispatching</Badge>}
      </div>

      {state.kind === "attention" ? (
        <p className="text-ink-muted">
          Not dispatching: fix the issues first.{" "}
          <button
            type="button"
            className="font-medium text-accent underline underline-offset-2"
            onClick={onOpenReadiness}
          >
            Review readiness ({scheduleIssues(issues.all).length})
          </button>
        </p>
      ) : (
        <p className="text-ink-muted">{scheduleStateLine(state)}</p>
      )}

      {lastDispatched && (
        <p className="text-ink-subtle">
          Last dispatched <RelativeTime date={lastDispatched} />
        </p>
      )}

      <div>
        <Button size="sm" variant="ghost" onClick={onOpenComposer}>
          Edit schedule
        </Button>
      </div>
    </div>
  );
}
