// Header schedule chip (spec 0019): tooltip summary next to the status
// badge; clicking focuses the workflow panel's schedule section. Hidden
// while there is no configured schedule.
import type { Workflow } from "@/gen/glyph/v1/workflow_pb";
import { useIssues } from "@/features/workflows";
import { Clock, Tooltip } from "@/shared/ui";
import { tsToDate } from "@/shared/lib/time";
import { formatInZone } from "./lib/preview";
import { scheduleState, scheduleStateLine, type ScheduleState } from "./lib/state";

type ScheduleStateKind = Exclude<ScheduleState["kind"], "none">;

const CHIP_LABEL: Record<ScheduleStateKind, string> = {
  active: "Scheduled",
  draft: "Starts on activation",
  paused: "Paused",
  attention: "Not dispatching",
};

export function ScheduleChip({ workflow, onClick }: { workflow: Workflow; onClick: () => void }) {
  const issues = useIssues(workflow.summary?.id ?? "");
  const state = scheduleState(workflow, issues.all);
  if (state.kind === "none") return null;

  const { schedule } = state;
  const next = tsToDate(schedule.nextRunAt);
  const label =
    state.kind === "active" && next
      ? formatInZone(next, schedule.timezone)
      : CHIP_LABEL[state.kind];

  return (
    <Tooltip
      content={
        <span>
          {schedule.humanDescription || "Custom recurrence"} · {scheduleStateLine(state)}
        </span>
      }
    >
      <button
        type="button"
        data-testid="schedule-chip"
        aria-label={`Schedule: ${schedule.humanDescription || "custom recurrence"}`}
        onClick={onClick}
        className="flex h-6 items-center gap-1 rounded-full border border-border bg-surface px-2 text-xs text-ink-muted hover:bg-surface-2 hover:text-ink"
      >
        <Clock size={12} />
        <span className="tabular-nums">{label}</span>
      </button>
    </Tooltip>
  );
}
