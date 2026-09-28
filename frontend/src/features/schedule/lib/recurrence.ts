// Builder ↔ proto oneof ↔ cron mapping (spec 0019), mirroring the backend
// (backend/src/features/workflows/domain/schedule_calculator.rs) so the
// client-side preview and the server's next_run_at agree.
import { Cron } from "croner";
import { create } from "@bufbuild/protobuf";
import { IntervalUnit } from "@/gen/glyph/v1/workflow_pb";
import {
  ScheduleCronSchema,
  ScheduleDailySchema,
  ScheduleIntervalSchema,
  ScheduleMonthlySchema,
  ScheduleNoneSchema,
  ScheduleWeeklySchema,
} from "@/gen/glyph/v1/workflow_pb";
import type { SaveScheduleRequest, Schedule } from "@/gen/glyph/v1/workflow_pb";

export type RecurrenceUnit = "minutes" | "hours";

/** The recurrence shapes the composer builds, plus the raw cron escape hatch. */
export type Recurrence =
  | { kind: "interval"; every: number; unit: RecurrenceUnit }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  | { kind: "monthly"; day: number; hour: number; minute: number }
  | { kind: "cron"; expression: string };

/** Composer pattern picker values; "none" removes the schedule. */
export type SchedulePattern = "none" | Recurrence["kind"];

/** 0 = Sunday … 6 = Saturday (proto weekday encoding). */
export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** Parses a raw 5-field cron expression (the proto contract). */
export function parseCron(expression: string): string | null {
  const trimmed = expression.trim();
  if (trimmed.split(/\s+/).length !== 5) return null;
  try {
    new Cron(trimmed);
    return trimmed;
  } catch {
    return null;
  }
}

/** Serializes a builder shape to cron; `null` when out of range (backend parity). */
export function cronFor(recurrence: Recurrence): string | null {
  switch (recurrence.kind) {
    case "interval": {
      const { every, unit } = recurrence;
      if (!Number.isInteger(every) || every <= 0) return null;
      if (unit === "minutes") return every <= 59 ? `*/${every} * * * *` : null;
      return every <= 23 ? `7 */${every} * * *` : null;
    }
    case "daily":
      return `${recurrence.minute} ${recurrence.hour} * * *`;
    case "weekly":
      return `${recurrence.minute} ${recurrence.hour} * * ${recurrence.weekday}`;
    case "monthly":
      return recurrence.day >= 1 && recurrence.day <= 31
        ? `${recurrence.minute} ${recurrence.hour} ${recurrence.day} * *`
        : null;
    case "cron":
      return parseCron(recurrence.expression);
  }
}

/**
 * Recognizes a saved cron as one of the builder shapes (composer defaults).
 * Anything else — ranges, lists, a non-7 minute on an hour step — stays in
 * cron mode so re-saving never changes behaviour.
 */
export function recurrenceFromCron(cron: string): Recurrence | null {
  const parsed = parseCron(cron);
  if (!parsed) return null;
  const [minute = "", hour = "", dom = "", month = "", dow = ""] = parsed.split(/\s+/);
  const int = (field: string) => (/^\d+$/.test(field) ? Number(field) : null);
  const everyFrom = (field: string) => (/^\*\/\d+$/.test(field) ? Number(field.slice(2)) : null);

  if (hour === "*" && dom === "*" && month === "*" && dow === "*") {
    const every = everyFrom(minute);
    if (every !== null) return { kind: "interval", every, unit: "minutes" };
  }
  if (minute === "7" && dom === "*" && month === "*" && dow === "*") {
    const every = everyFrom(hour);
    if (every !== null) return { kind: "interval", every, unit: "hours" };
  }
  if (dom === "*" && dow === "*") {
    const h = int(hour);
    const m = int(minute);
    if (h !== null && m !== null) return { kind: "daily", hour: h, minute: m };
  }
  if (dom === "*" && month === "*") {
    const h = int(hour);
    const m = int(minute);
    const w = int(dow);
    if (h !== null && m !== null && w !== null) return { kind: "weekly", weekday: w, hour: h, minute: m };
  }
  if (dow === "*" && month === "*") {
    const h = int(hour);
    const m = int(minute);
    const d = int(dom);
    if (h !== null && m !== null && d !== null) return { kind: "monthly", day: d, hour: h, minute: m };
  }
  return { kind: "cron", expression: parsed };
}

/** The SaveScheduleRequest.recurrence oneof for a pattern (or its removal). */
export function recurrenceToRequest(pattern: SchedulePattern, recurrence: Recurrence): SaveScheduleRequest["recurrence"] {
  if (pattern === "none") return { case: "none", value: create(ScheduleNoneSchema, {}) };
  if (pattern !== recurrence.kind) throw new Error(`pattern ${pattern} does not match recurrence ${recurrence.kind}`);
  switch (recurrence.kind) {
    case "interval":
      return {
        case: "interval",
        value: create(ScheduleIntervalSchema, {
          every: recurrence.every,
          unit: recurrence.unit === "minutes" ? IntervalUnit.MINUTES : IntervalUnit.HOURS,
        }),
      };
    case "daily":
      return { case: "daily", value: create(ScheduleDailySchema, { hour: recurrence.hour, minute: recurrence.minute }) };
    case "weekly":
      return {
        case: "weekly",
        value: create(ScheduleWeeklySchema, {
          weekday: recurrence.weekday,
          hour: recurrence.hour,
          minute: recurrence.minute,
        }),
      };
    case "monthly":
      return {
        case: "monthly",
        value: create(ScheduleMonthlySchema, { day: recurrence.day, hour: recurrence.hour, minute: recurrence.minute }),
      };
    case "cron":
      return { case: "cron", value: create(ScheduleCronSchema, { expression: recurrence.expression.trim() }) };
  }
}

/** A schedule with both a cron and a timezone. */
export type ConfiguredSchedule = Schedule & { cronExpression: string; timezone: string };

/** A schedule is configured once it has both a cron and a timezone. */
export function isConfigured(schedule: Schedule | undefined): schedule is ConfiguredSchedule {
  return Boolean(schedule?.cronExpression && schedule?.timezone);
}
