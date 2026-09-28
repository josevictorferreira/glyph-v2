// Schedule composer sheet (spec 0019): pattern picker, per-pattern fields,
// timezone combobox (recent on top), enabled switch (hidden for drafts),
// client-side preview (croner — the same engine the backend uses) and
// save/remove through SaveSchedule. The form lives inside SheetContent so
// every open starts from the saved schedule.
import { useMemo, useState } from "react";
import { WorkflowStatus } from "@/gen/glyph/v1/common_pb";
import { WorkflowService } from "@/gen/glyph/v1/workflow_pb";
import type { Workflow } from "@/gen/glyph/v1/workflow_pb";
import { useWorkflowMutation } from "@/features/workflows";
import { appErrorToast } from "@/shared/api/errors";
import {
  Button,
  Combobox,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  NativeSelect,
  Sheet,
  SheetContent,
  Switch,
  toast,
} from "@/shared/ui";
import {
  WEEKDAYS,
  cronFor,
  isConfigured,
  parseCron,
  recurrenceFromCron,
  recurrenceToRequest,
  type Recurrence,
} from "./lib/recurrence";
import { formatInZone, isValidTimezone, nextOccurrences, viewerTimezone } from "./lib/preview";
import { rememberTimezone, timezoneItems } from "./lib/timezones";

const PATTERNS = [
  { value: "interval", label: "Interval" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "cron", label: "Cron" },
] as const;

/** hh:mm ("09:00") → { hour, minute } for the shared time picker. */
function splitTime(time: string): { hour: number; minute: number } {
  const [hour = 9, minute = 0] = time.split(":").map((part) => Number.parseInt(part, 10));
  return { hour, minute };
}

export function ScheduleComposer({
  workflow,
  open,
  onOpenChange,
}: {
  workflow: Workflow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title="Schedule"
        description="When this workflow runs automatically."
        data-testid="schedule-composer"
      >
        <ComposerForm workflow={workflow} onOpenChange={onOpenChange} />
      </SheetContent>
    </Sheet>
  );
}

function ComposerForm({ workflow, onOpenChange }: { workflow: Workflow; onOpenChange: (open: boolean) => void }) {
  const workflowId = workflow.summary?.id ?? "";
  const status = workflow.summary?.status ?? WorkflowStatus.DRAFT;
  const draft = status === WorkflowStatus.DRAFT;
  const schedule = workflow.schedule;
  const configured = isConfigured(schedule);
  const saved = useMemo(
    () => (schedule && isConfigured(schedule) ? recurrenceFromCron(schedule.cronExpression) : null),
    [schedule],
  );

  const [pattern, setPattern] = useState<(typeof PATTERNS)[number]["value"]>(() =>
    saved ? (saved.kind === "cron" ? "cron" : saved.kind) : "interval",
  );
  const [every, setEvery] = useState(() => (saved?.kind === "interval" ? saved.every : 15));
  const [unit, setUnit] = useState<"minutes" | "hours">(() => (saved?.kind === "interval" ? saved.unit : "minutes"));
  const [time, setTime] = useState(() =>
    saved && (saved.kind === "daily" || saved.kind === "weekly" || saved.kind === "monthly")
      ? `${String(saved.hour).padStart(2, "0")}:${String(saved.minute).padStart(2, "0")}`
      : "09:00",
  );
  const [weekday, setWeekday] = useState(() => (saved?.kind === "weekly" ? saved.weekday : 1));
  const [day, setDay] = useState(() => (saved?.kind === "monthly" ? saved.day : 1));
  const [expression, setExpression] = useState(() => (saved?.kind === "cron" ? saved.expression : ""));
  const [timezone, setTimezone] = useState(() => schedule?.timezone || viewerTimezone());
  // A new schedule on an active workflow starts enabled; drafts are stored
  // disabled by the backend either way.
  const [enabled, setEnabled] = useState(() => schedule?.enabled ?? status === WorkflowStatus.ACTIVE);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const recurrence: Recurrence = useMemo(() => {
    const { hour, minute } = splitTime(time);
    switch (pattern) {
      case "interval":
        return { kind: "interval", every, unit };
      case "daily":
        return { kind: "daily", hour, minute };
      case "weekly":
        return { kind: "weekly", weekday, hour, minute };
      case "monthly":
        return { kind: "monthly", day, hour, minute };
      case "cron":
        return { kind: "cron", expression };
    }
  }, [pattern, every, unit, time, weekday, day, expression]);

  const cron = cronFor(recurrence);
  const preview = useMemo(
    () => (cron && isValidTimezone(timezone) ? nextOccurrences(cron, timezone, 5) : []),
    [cron, timezone],
  );
  const viewerTz = viewerTimezone();
  const showLocalLine = viewerTz !== timezone;

  const error =
    pattern === "cron" && !parseCron(expression)
      ? "The recurrence is not a valid cron expression."
      : pattern !== "cron" && !cron
        ? "The recurrence is out of range."
        : !isValidTimezone(timezone)
          ? "The schedule timezone is not a known IANA timezone."
          : null;

  const save = useWorkflowMutation(WorkflowService.method.saveSchedule, {
    onSucceeded: () => {
      rememberTimezone(timezone);
      toast({ title: "Schedule saved", tone: "success" });
      onOpenChange(false);
    },
    onAppError: appErrorToast,
  });
  const remove = useWorkflowMutation(WorkflowService.method.saveSchedule, {
    onSucceeded: () => {
      setConfirmRemove(false);
      toast({ title: "Schedule removed" });
      onOpenChange(false);
    },
    onAppError: appErrorToast,
  });

  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" aria-label="Recurrence pattern" className="flex flex-wrap gap-1 rounded-lg bg-surface-2 p-1">
        {PATTERNS.map((p) => (
          <button
            key={p.value}
            type="button"
            role="tab"
            aria-selected={pattern === p.value}
            onClick={() => setPattern(p.value)}
            className={
              "flex h-7 items-center rounded-md px-2.5 text-sm font-medium " +
              (pattern === p.value ? "bg-surface text-ink shadow-sm" : "text-ink-muted hover:text-ink")
            }
          >
            {p.label}
          </button>
        ))}
      </div>

      {pattern === "interval" && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Every" htmlFor="schedule-every">
            <Input
              id="schedule-every"
              type="number"
              min={1}
              max={unit === "minutes" ? 59 : 23}
              step={1}
              value={Number.isNaN(every) ? "" : every}
              onChange={(e) => setEvery(e.target.valueAsNumber)}
            />
          </Field>
          <Field label="Unit" htmlFor="schedule-unit">
            <NativeSelect
              id="schedule-unit"
              value={unit}
              onChange={(e) => setUnit(e.target.value as "minutes" | "hours")}
            >
              <option value="minutes">Minutes</option>
              <option value="hours">Hours</option>
            </NativeSelect>
          </Field>
        </div>
      )}

      {(pattern === "daily" || pattern === "weekly" || pattern === "monthly") && (
        <Field label="Time" htmlFor="schedule-time" hint="24-hour clock, 5-minute steps.">
          <Input id="schedule-time" type="time" step={300} value={time} onChange={(e) => setTime(e.target.value)} />
        </Field>
      )}

      {pattern === "weekly" && (
        <Field label="Weekday">
          <div className="flex flex-wrap gap-1" role="group" aria-label="Weekday">
            {WEEKDAYS.map((name, index) => (
              <button
                key={name}
                type="button"
                aria-pressed={weekday === index}
                onClick={() => setWeekday(index)}
                className={
                  "h-7 rounded-md border px-2 text-xs font-medium " +
                  (weekday === index
                    ? "border-accent bg-accent/10 text-accent"
                    : "border-border text-ink-muted hover:text-ink")
                }
              >
                {name}
              </button>
            ))}
          </div>
        </Field>
      )}

      {pattern === "monthly" && (
        <Field label="Day of month" htmlFor="schedule-day" hint="Months without this day are skipped.">
          <Input
            id="schedule-day"
            type="number"
            min={1}
            max={31}
            step={1}
            value={Number.isNaN(day) ? "" : day}
            onChange={(e) => setDay(e.target.valueAsNumber)}
          />
        </Field>
      )}

      {pattern === "cron" && (
        <Field label="Cron expression" htmlFor="schedule-cron">
          <Input
            id="schedule-cron"
            mono
            placeholder="0 9 * * 1"
            value={expression}
            onChange={(e) => setExpression(e.target.value)}
          />
          <p className="font-mono text-[0.6875rem] text-ink-subtle">min hour day month weekday</p>
        </Field>
      )}

      <Field label="Timezone" hint="IANA timezone the schedule runs in.">
        <Combobox
          ariaLabel="Schedule timezone"
          items={timezoneItems(timezone)}
          value={timezone}
          onValueChange={setTimezone}
          searchPlaceholder="Search timezones…"
        />
      </Field>

      {draft ? (
        <p className="text-xs text-ink-subtle">
          The switch is unavailable while the workflow is a draft; the schedule starts after you activate the
          workflow.
        </p>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <Switch label="Enabled" checked={enabled} onCheckedChange={setEnabled} />
          <span className="text-right text-xs text-ink-subtle">
            Scheduled runs dispatch only while the workflow is active.
          </span>
        </div>
      )}

      <div className="rounded-md border border-border bg-surface-2 px-2.5 py-2" data-testid="schedule-preview">
        {cron && (
          <p className="font-mono text-[0.6875rem] text-ink-subtle">
            {cron} <span className="font-sans">· {timezone}</span>
          </p>
        )}
        {preview.length > 0 ? (
          <ul className="mt-1 flex flex-col gap-0.5">
            {preview.map((occurrence) => (
              <li key={occurrence.toISOString()} className="text-xs text-ink">
                {formatInZone(occurrence, timezone)}
                {showLocalLine && (
                  <span className="text-ink-subtle"> · {formatInZone(occurrence, viewerTz)} your time</span>
                )}
              </li>
            ))}
          </ul>
        ) : !error ? (
          <p className="mt-1 text-xs text-ink-subtle">No upcoming occurrences.</p>
        ) : null}
      </div>

      {error && (
        <p className="text-xs text-status-failed" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
        {configured ? (
          <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(true)}>
            Remove…
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            data-testid="save-schedule"
            loading={save.isPending}
            disabled={error !== null}
            onClick={() =>
              save.mutate({
                workflowId,
                recurrence: recurrenceToRequest(pattern, recurrence),
                timezone,
                enabled: draft ? true : enabled,
              })
            }
          >
            Save schedule
          </Button>
        </div>
      </div>

      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <DialogContent
          title="Remove the schedule?"
          description="Scheduled runs stop. Manual runs stay available. History is kept."
        >
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              data-testid="confirm-remove"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate({
                  workflowId,
                  recurrence: recurrenceToRequest("none", recurrence),
                  timezone,
                  enabled: false,
                })
              }
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
